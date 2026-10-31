import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { allTools } from './tools/index.js';
import { prepareToolParams } from './tools/params.js';
import { codedMessageOf, rawResultOf, withNotes } from './tools/types.js';
import type { ToolDefinition, ToolHost, ToolResult } from './tools/types.js';
import { attachSafetyController } from './tools/action-support.js';
import { noteOwnedTab, sessionGate } from './tools/session-mode.js';
import { ERROR_CODES, formatError, isKnownErrorCode } from './core/error-codes.js';
import { createLogger, newCorrelationId, runWithCorrelationId } from './core/logger.js';

/**
 * The logger of the MCP process. The tool layer and the thin client share it,
 * so a line written by one of them and a line written by the other belong to
 * the same scope — and, inside a request, to the same correlation id.
 */
export const log = createLogger('browser-controller');

// Re-exported for tests/register-tools.test.ts, which drives validation through
// the bootstrap; the implementation lives in tools/params.ts now.
export { parseToolParams } from './tools/params.js';

/**
 * A tool's failure text: the `CODE: message` of its first line, with a batch step's
 * `step i/n <tool>: ` prefix kept in front of it. The lines after it are context —
 * the earlier steps of a batch — and stay as they are.
 */
function stepPrefix(text: string): string {
  return /^step \d+\/\d+ \S+: /.exec(text)?.[0] ?? '';
}

function codedText(text: string): string {
  const step = stepPrefix(text);
  const rest = text.slice(step.length);
  const lineEnd = rest.indexOf('\n');
  if (lineEnd < 0) return step + codedMessageOf(rest);
  return step + codedMessageOf(rest.slice(0, lineEnd)) + rest.slice(lineEnd);
}

function failure(text: string): ToolResult {
  return { content: [{ type: 'text' as const, text: codedText(text) }], isError: true };
}

/** A tool's own failure result, with its text coded the same way as a thrown one. */
function codedResult(result: ToolResult): ToolResult {
  if (!result.isError) return result;
  const content = result.content.map((item) => (item.type === 'text' ? { ...item, text: codedText(item.text) } : item));
  return { ...result, content };
}

/**
 * Log a failed call with the correlation id of the request it belongs to.
 *
 * Only the tool name and the error CODE are logged: the message itself can
 * quote page content, and a log file is not the place for that.
 */
function logFailure(tool: string, result: ToolResult): void {
  const text = result.content.find((item) => item.type === 'text');
  const first = typeof text?.text === 'string' ? text.text.split('\n')[0] : '';
  const message = first.slice(stepPrefix(first).length);
  const candidate = message.includes(': ') ? message.slice(0, message.indexOf(': ')) : '';
  // Every line reaching here is already coded, so a candidate the registry does
  // not know is not a code at all: log INTERNAL_ERROR, never an unregistered
  // string the rest of the vocabulary does not produce.
  const code = isKnownErrorCode(candidate) ? candidate : ERROR_CODES.INTERNAL_ERROR;
  log.error(`tool ${tool} failed: ${code}`);
}

/** Run a tool: validate, call its handler, and turn every failure into a `CODE: message` result (never a protocol error). */
function wrapHandler(tool: ToolDefinition, host: ToolHost) {
  return async (params: Record<string, unknown>): Promise<ToolResult> => {
    let parsed: Record<string, unknown>;
    let notes: string[];
    try {
      ({ params: parsed, notes } = prepareToolParams(tool, params));
    } catch (err) {
      return failure(err instanceof Error ? err.message : String(err));
    }
    try {
      // The session policy (read-only, isolated) is checked before anything is dispatched.
      const gate = await sessionGate(tool.name, parsed, host);
      if (gate) return withNotes(gate, notes);
      const result = await tool.handler(host, parsed);
      // A tab the session opened is the session's own: in isolated mode it may act on it.
      if (tool.name === 'browser_navigate' && parsed.tabId === undefined) {
        const opened = rawResultOf(result)?.tabId;
        if (typeof opened === 'number') noteOwnedTab(host, opened);
      }
      return withNotes(codedResult(result), notes);
    } catch (err) {
      return failure(err instanceof Error ? err.message : String(err));
    }
  };
}

/**
 * Tool registration, extracted from index.ts's main() so the wiring is testable
 * without a live daemon (see tests/register-tools.test.ts, which drives a real
 * McpServer over InMemoryTransport). Every tool in allTools is registered and
 * listed, in order; a call is validated here before it reaches the host.
 */
export function registerTools(server: McpServer, host: ToolHost): void {
  attachSafetyController(host, {
    async confirm(details) {
      const capabilities = server.server.getClientCapabilities();
      if (!capabilities?.elicitation?.form) return 'unavailable';
      const target = details.target ? ` for target ${details.target}` : '';
      const response = await server.server.elicitInput({
        mode: 'form',
        message: details.message ?? `Allow ${details.categories.join(', ')} via ${details.tool} on ${details.site}${target}?`,
        requestedSchema: {
          type: 'object',
          properties: { confirm: { type: 'boolean', title: 'Allow this action' } },
          required: ['confirm'],
        },
      });
      return response.action === 'accept' && response.content?.confirm === true ? 'approved' : 'declined';
    },
  });
  const runs = new Map<string, (params: Record<string, unknown>) => Promise<ToolResult>>();
  for (const tool of allTools) {
    const run = wrapHandler(tool, host);
    runs.set(tool.name, run);
    // The zod object itself (not its shape), so the strict schemas advertise additionalProperties: false.
    server.registerTool(tool.name, { description: tool.description, inputSchema: tool.inputSchema }, run);
  }
  // The SDK checks arguments against these same shapes before the handler and answers with its own text
  // ("MCP error -32602: Input validation error: …"). tools/call is taken over here so every failure is
  // CODE: message; tools/list still advertises the JSON Schema built from the same shapes.
  server.server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const run = runs.get(request.params.name);
    // One correlation id ties request-scoped client, daemon and bridge logs together.
    const correlationId = newCorrelationId();
    return runWithCorrelationId(correlationId, async () => {
      if (!run) {
        const result = failure(formatError(ERROR_CODES.INVALID_ARGUMENT, `unknown tool ${request.params.name}`));
        logFailure(request.params.name, result);
        return result;
      }
      const result = await run(request.params.arguments ?? {});
      if (result.isError) logFailure(request.params.name, result);
      return result;
    });
  });
}
