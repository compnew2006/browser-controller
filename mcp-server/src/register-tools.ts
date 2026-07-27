import { McpServer, type RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import { allTools } from './tools/index.js';
import { createMetaTool } from './tools/meta.js';
import type { ToolDefinition, ToolHost } from './tools/types.js';

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

/** Wrap a tool handler so a throw becomes an isError result, never a protocol error. */
function wrapHandler(tool: ToolDefinition, host: ToolHost) {
  return async (params: Record<string, unknown>) => {
    try {
      return await tool.handler(host, params);
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
