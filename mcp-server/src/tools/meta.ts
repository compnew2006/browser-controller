import { z } from 'zod';
import type { ToolDefinition } from './types.js';
import { textResult } from './types.js';
import { allTools, toolMap } from './index.js';

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
 * Set BROWSER_CONTROLLER_FULL_TOOLS=1 to disable progressive disclosure and
 * register all tools upfront (backward-compat mode).
 */
export interface MetaToolDeps {
  /** Activate a tool by name (enable + sendToolListChanged). No-op if already active. */
  onActivate: (toolName: string) => void;
  /** Whether a tool is currently active (enabled). */
  isActive: (toolName: string) => boolean;
}

export function createMetaTool(deps: MetaToolDeps): ToolDefinition {
  return {
    name: 'browser_tools',
    summary: 'Discover and activate browser tools (progressive disclosure)',
    description: `Discover, search, and activate browser control tools. Instead of loading all tool definitions upfront, use this to find the right tool for your task.

Actions:
- "list": See all available tools with short summaries (~400 tokens).
- "search": Find tools by keyword (e.g. query:"click" matches browser_click, browser_click_text).
- "details": Get the full schema + description for one tool AND activate it so you can call it.

Workflow: call "list" or "search" first, then "details" on the tool you need, then call that tool directly.`,
    inputSchema: z.object({
      action: z
        .enum(['list', 'search', 'details'])
        .describe('list = all summaries; search = find by keyword; details = full schema + activate'),
      query: z
        .string()
        .optional()
        .describe('Search query (for action:"search"). Matches tool name + summary.'),
      tool: z
        .string()
        .optional()
        .describe('Tool name (for action:"details"). e.g. "browser_click"'),
    }),
    async handler(_host, params) {
      const { action, query, tool } = params as { action: string; query?: string; tool?: string };

      if (action === 'list') {
        const tools = allTools
          .filter((t) => t.name !== 'browser_tools') // don't list the meta tool itself
          .map((t) => ({
            name: t.name,
            summary: t.summary,
            active: deps.isActive(t.name),
          }));
        return textResult(JSON.stringify({ tools }));
      }

      if (action === 'search') {
        if (!query) {
          return textResult(JSON.stringify({ error: 'query is required for action:"search"' }));
        }
        const q = query.toLowerCase();
        const matches = allTools
          .filter((t) => t.name !== 'browser_tools')
          .filter((t) => {
            const haystack = (t.name + ' ' + t.summary + ' ' + t.description).toLowerCase();
            // match if ANY word in the query appears in the haystack
            return q.split(/\s+/).some((word) => word.length > 1 && haystack.includes(word));
          })
          .map((t) => ({ name: t.name, summary: t.summary, active: deps.isActive(t.name) }));
        return textResult(JSON.stringify({ query, matches, count: matches.length }));
      }

      if (action === 'details') {
        if (!tool) {
          return textResult(JSON.stringify({ error: 'tool is required for action:"details"' }));
        }
        const def = toolMap.get(tool);
        if (!def) {
          return textResult(
            JSON.stringify({
              error: `Unknown tool: ${tool}`,
              available: allTools.filter((t) => t.name !== 'browser_tools').map((t) => t.name),
            }),
          );
        }
        // Activate the tool so the agent can call it directly after this.
        deps.onActivate(tool);
        // Return the full definition (minus the handler — the agent can't call it directly anyway)
        return textResult(
          JSON.stringify({
            name: def.name,
            description: def.description,
            inputSchema: def.inputSchema.shape,
            activated: true,
            message: `Tool "${tool}" is now active. You can call it directly.`,
          }),
        );
      }

      return textResult(JSON.stringify({ error: `Unknown action: ${action}. Use "list", "search", or "details".` }));
    },
  };
}
