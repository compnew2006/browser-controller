import type { ToolDefinition } from './types.js';
/**
 * Progressive disclosure meta tool (Anthropic "Code Execution with MCP" pattern).
 *
 * Instead of loading all 22 tool definitions into the agent's context upfront
 * (~4200 tokens), only `browser_tools` is registered as visible. The agent uses
 * it to discover, search, and activate other tools on demand:
 *
 *   browser_tools { action: "search", query: "click" }
 *     → [{ name: "browser_click", summary: "Click an element by ref or CSS selector" }, ...]
 *
 *   browser_tools { action: "details", tool: "browser_click" }
 *     → { name, description, inputSchema } + activates the tool
 *
 *   browser_tools { action: "list" }
 *     → all tool names + summaries (~400 tokens vs ~4200)
 *
 * The activation callback (`onActivate`) is injected by index.ts at registration
 * time. When the agent requests `details`, the tool is enabled via the SDK's
 * `RegisteredTool.enable()` + `sendToolListChanged()`, so subsequent `tools/list`
 * responses include it.
 *
 * Default is FULL mode (all tools always visible). Set
 * BROWSER_CONTROLLER_PROGRESSIVE=1 to enable progressive disclosure (only
 * browser_tools is visible until the agent activates others on demand).
 */
export interface MetaToolDeps {
    /** Activate a tool by name (enable + sendToolListChanged). No-op if already active. */
    onActivate: (toolName: string) => void;
    /** Whether a tool is currently active (enabled). */
    isActive: (toolName: string) => boolean;
}
export declare function createMetaTool(deps: MetaToolDeps): ToolDefinition;
//# sourceMappingURL=meta.d.ts.map