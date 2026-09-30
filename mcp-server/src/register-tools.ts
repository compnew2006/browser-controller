import { McpServer, type RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
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
 * disclosure wiring (disable-by-default + enable-on-details) is testable
 * without a live daemon (see tests/register-tools.test.ts, which drives a
 * real McpServer over InMemoryTransport).
 *
 * - fullMode=true  → all tools registered enabled (default; safe for agents
 *   whose instructions call tools directly).
 * - fullMode=false → BROWSER_CONTROLLER_PROGRESSIVE: every browser tool starts
 *   disabled; only the browser_tools meta tool is visible. When the agent
 *   requests {action:"details"}, onActivate enables the tool and notifies the
 *   client via tools/list_changed.
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
  // Track which tools are enabled (for the meta tool's isActive callback).
  const activeTools = new Set<string>();
  const toolHandles = new Map<string, RegisteredTool>();

  const metaDeps = {
    onActivate: (toolName: string) => {
      if (activeTools.has(toolName)) return; // already active
      const handle = toolHandles.get(toolName);
      if (handle) {
        handle.enable();
        activeTools.add(toolName);
        server.sendToolListChanged();
        log(`progressive disclosure: activated "${toolName}"`);
      }
    },
    isActive: (toolName: string) => activeTools.has(toolName),
  };

  // Register all browser tools, keeping handles for enable/disable control.
  for (const tool of allTools) {
    const handle = server.tool(tool.name, tool.description, tool.inputSchema.shape, wrapHandler(tool, host));
    toolHandles.set(tool.name, handle);
    if (fullMode) {
      activeTools.add(tool.name);
    } else {
      handle.disable(); // hidden until the agent activates it via browser_tools
    }
  }

  // Register the meta tool LAST (always enabled — it's the discovery entry point).
  const metaTool = createMetaTool(metaDeps);
  server.tool(metaTool.name, metaTool.description, metaTool.inputSchema.shape, wrapHandler(metaTool, host));

  return { toolHandles, activeTools };
}
