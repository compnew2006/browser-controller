import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { allTools } from './tools/index.js';
import { codedMessageOf, unknownParameterHint } from './tools/types.js';
import type { ToolDefinition, ToolHost, ToolResult } from './tools/types.js';
import { attachSafetyController } from './tools/action-support.js';

const MAX_TOOL_ARGUMENT_BYTES = 1_000_000;
const MAX_TOOL_STRING_CHARS = 200_000;
const MAX_TOOL_ARRAY_ITEMS = 1_000;

function checkPayloadLimits(value: unknown, ctx: z.RefinementCtx, path: Array<string | number> = []): void {
  if (typeof value === 'string') {
    if (value.length > MAX_TOOL_STRING_CHARS) {
      ctx.addIssue({
        code: 'too_big',
        maximum: MAX_TOOL_STRING_CHARS,
        origin: 'string',
        inclusive: true,
        path,
        message: `String exceeds ${MAX_TOOL_STRING_CHARS} characters`,
      });
    }
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > MAX_TOOL_ARRAY_ITEMS) {
      ctx.addIssue({
        code: 'too_big',
        maximum: MAX_TOOL_ARRAY_ITEMS,
        origin: 'array',
        inclusive: true,
        path,
        message: `Array exceeds ${MAX_TOOL_ARRAY_ITEMS} items`,
      });
    }
    value.forEach((item, index) => checkPayloadLimits(item, ctx, [...path, index]));
    return;
  }
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      checkPayloadLimits(child, ctx, [...path, key]);
    }
  }
}

const payloadLimitsSchema = z.unknown().superRefine((value, ctx) => {
  let bytes: number;
  try {
    bytes = Buffer.byteLength(JSON.stringify(value), 'utf8');
  } catch {
    ctx.addIssue({ code: 'custom', message: 'Arguments must be JSON-serializable' });
    return;
  }
  if (bytes > MAX_TOOL_ARGUMENT_BYTES) {
    ctx.addIssue({
      code: 'too_big',
      maximum: MAX_TOOL_ARGUMENT_BYTES,
      origin: 'string',
      inclusive: true,
      message: `Arguments exceed ${MAX_TOOL_ARGUMENT_BYTES} bytes`,
    });
  }
  checkPayloadLimits(value, ctx);
});

type ZodIssue = z.ZodError['issues'][number];

/** What a missing required parameter needs beyond "is required" (one small map for the whole server). */
const REQUIRED_HINTS: Record<string, string> = {
  tabId: 'Call browser_tabs {action:"list"} first.',
};

const pathText = (path: PropertyKey[]): string => path.reduce<string>(
  (text, part, i) => (typeof part === 'number' ? `${text}[${part}]` : i === 0 ? String(part) : `${text}.${String(part)}`),
  '',
);

const valueAt = (params: unknown, path: PropertyKey[]): unknown => path.reduce<unknown>(
  (value, key) => (value && typeof value === 'object' ? (value as Record<PropertyKey, unknown>)[key] : undefined),
  params,
);

/** One short line per zod issue, as the agent reads it. */
function describeIssue(issue: ZodIssue, params: unknown): string[] {
  if (issue.code === 'unrecognized_keys') {
    const at = pathText(issue.path);
    return issue.keys.map((key) => {
      const hint = unknownParameterHint(key);
      return `unknown parameter ${key}${at ? ` in ${at}` : ''}${hint ? ` (${hint})` : ''}`;
    });
  }
  const field = pathText(issue.path) || 'arguments';
  if (issue.code === 'invalid_type' && valueAt(params, issue.path) === undefined) {
    const hint = REQUIRED_HINTS[field];
    return [`${field} is required${hint ? `. ${hint}` : ''}`];
  }
  const reason = issue.message.replace(/^Invalid input: /, '');
  return [reason.startsWith(`${field} `) ? reason : `${field}: ${reason}`];
}

/**
 * Validate a call's arguments against the tool's schema and the payload limits. A failure is one
 * `INVALID_ARGUMENT: …` error: `field is required`, `field: reason`, or `unknown parameter name`.
 */
export function parseToolParams(tool: ToolDefinition, params: Record<string, unknown>): Record<string, unknown> {
  try {
    payloadLimitsSchema.parse(params);
    return tool.inputSchema.parse(params) as Record<string, unknown>;
  } catch (err) {
    if (err instanceof z.ZodError) {
      const problems = err.issues.flatMap((issue) => describeIssue(issue, params));
      throw new Error(`INVALID_ARGUMENT: ${problems.join('; ')}`, { cause: err });
    }
    throw err;
  }
}

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
    try {
      parsed = parseToolParams(tool, params);
    } catch (err) {
      return failure(err instanceof Error ? err.message : String(err));
    }
    try {
      return codedResult(await tool.handler(host, parsed));
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
        message: `Allow ${details.categories.join(', ')} via ${details.tool} on ${details.site}${target}?`,
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
