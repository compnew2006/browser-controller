import { McpServer, type RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolHost } from './tools/types.js';
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
export declare function registerTools(server: McpServer, host: ToolHost, fullMode: boolean, log?: (msg: string) => void): ToolRegistration;
//# sourceMappingURL=register-tools.d.ts.map