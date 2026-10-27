import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { allTools } from './tools/index.js';
import { prepareToolParams } from './tools/params.js';
import { codedMessageOf, withNotes } from './tools/types.js';
import type { ToolDefinition, ToolHost, ToolResult } from './tools/types.js';
import { attachSafetyController } from './tools/action-support.js';

// Re-exported for tests/register-tools.test.ts, which drives validation through
// the bootstrap; the implementation lives in tools/params.ts now.
export { parseToolParams } from './tools/params.js';

/** A failure text the agent reads: a text with no code gets INTERNAL_ERROR in front (a batch step's `step i/n <tool>: ` prefix stays in front). */
function codedText(text: string): string {
  const step = /^step \d+\/\d+ \S+: /.exec(text)?.[0] ?? '';
  return step + codedMessageOf(text.slice(step.length));
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
      return withNotes(codedResult(await tool.handler(host, parsed)), notes);
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
    if (!run) return failure(`INVALID_ARGUMENT: unknown tool ${request.params.name}`);
    return run(request.params.arguments ?? {});
  });
}
