import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { allTools } from './tools/index.js';
import type { ToolDefinition, ToolHost } from './tools/types.js';

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

export function parseToolParams(tool: ToolDefinition, params: Record<string, unknown>): Record<string, unknown> {
  try {
    payloadLimitsSchema.parse(params);
    return tool.inputSchema.parse(params) as Record<string, unknown>;
  } catch (err) {
    if (err instanceof z.ZodError) {
      const details = z.treeifyError(err);
      throw new Error(`Invalid tool arguments for ${tool.name}: ${JSON.stringify(details)}`, { cause: err });
    }
    throw err;
  }
}

/** Wrap a tool handler so a throw becomes an isError result, never a protocol error. */
function wrapHandler(tool: ToolDefinition, host: ToolHost) {
  return async (params: Record<string, unknown>) => {
    try {
      const parsed = parseToolParams(tool, params);
      return await tool.handler(host, parsed);
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  };
}

/**
 * Register every browser tool on the server. Each call is validated against the
 * tool's schema (and payload limits) before it reaches the daemon; a throw
 * becomes an isError result. Kept apart from index.ts's main() so the wiring is
 * testable without a daemon (tests/register-tools.test.ts).
 */
export function registerTools(server: McpServer, host: ToolHost): void {
  for (const tool of allTools) {
    server.tool(tool.name, tool.description, tool.inputSchema.shape, wrapHandler(tool, host));
  }
}
