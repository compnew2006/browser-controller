import { McpServer, type RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { allTools } from './tools/index.js';
import { createMetaTool } from './tools/meta.js';
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

/**
 * Tool registration, extracted from index.ts's main() so the progressive
 * disclosure wiring (hidden until activated; a call or details activates) is
 * testable without a live daemon (see tests/register-tools.test.ts, which drives
 * a real McpServer over InMemoryTransport).
 *
 * - fullMode=true  → all tools registered and listed (default; safe for agents
 *   whose instructions call tools directly). No browser_tools meta tool.
 * - fullMode=false → BROWSER_CONTROLLER_PROGRESSIVE: every tool stays enabled
 *   but tools/list shows only browser_tools and the tools activated so far. A
 *   call to any tool activates it first (so it runs at once), and
 *   {action:"details"} activates it too. Each activation sends
 *   tools/list_changed.
 */
export interface ToolRegistration {
  toolHandles: Map<string, RegisteredTool>;
  activeTools: Set<string>;
}

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

export function registerTools(
  server: McpServer,
  host: ToolHost,
  fullMode: boolean,
  log: (msg: string) => void = () => {},
): ToolRegistration {
  // Tools the client can see and call (progressive mode: the activated ones).
  const activeTools = new Set<string>();
  const toolHandles = new Map<string, RegisteredTool>();

  const metaDeps = {
    onActivate: (toolName: string) => {
      if (activeTools.has(toolName) || !toolHandles.has(toolName)) return; // already active, or unknown
      activeTools.add(toolName);
      server.sendToolListChanged();
      log(`progressive disclosure: activated "${toolName}"`);
    },
    isActive: (toolName: string) => activeTools.has(toolName),
  };

  // Every tool stays ENABLED in both modes. The SDK rejects a call to a disabled
  // tool before any handler runs, so a disabled tool could never be activated by
  // being called. Progressive mode hides the inactive tools from tools/list
  // instead (below), and a call to any tool activates it before it runs.
  for (const tool of allTools) {
    const call = wrapHandler(tool, host);
    const handle = server.tool(
      tool.name,
      tool.description,
      tool.inputSchema.shape,
      fullMode
        ? call
        : async (params: Record<string, unknown>) => {
          metaDeps.onActivate(tool.name);
          return call(params);
        },
    );
    toolHandles.set(tool.name, handle);
    if (fullMode) activeTools.add(tool.name);
  }

  if (!fullMode) {
    // The meta tool is the discovery entry point, so it is always listed.
    const metaTool = createMetaTool(metaDeps);
    server.tool(metaTool.name, metaTool.description, metaTool.inputSchema.shape, wrapHandler(metaTool, host));

    // tools/list shows browser_tools plus the activated tools. The SDK's own list
    // handler shows every enabled tool, so this one replaces it. Schemas use the
    // agent's input direction, like the SDK's list does.
    const listed = [...allTools, metaTool];
    server.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: listed
        .filter((t) => t.name === metaTool.name || activeTools.has(t.name))
        .map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: z.toJSONSchema(t.inputSchema, { io: 'input', target: 'draft-7' }) as { type: 'object'; properties?: Record<string, object> },
        })),
    }));
  }

  return { toolHandles, activeTools };
}
