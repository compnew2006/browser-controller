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

/**
 * Task → tool orientation, shown at the top of the `list` response. This is the
 * first thing a first-time agent reads to know which tool to reach for. Keep it
 * short (it costs tokens on every `list` call) and relational — describe WHEN to
 * pick each tool relative to alternatives, not what the tool is (the per-tool
 * summary already does that).
 */
const TASK_PREAMBLE =
  'Task → tool:\n' +
  '• Click / type / fill a form → browser_click / browser_type / browser_fill_form (SPA-aware full events, no debugger banner). Prefer these over raw JS — they handle React/Vue controlled inputs and smart-selector fallback.\n' +
  '• Read visible text → browser_text (cheapest). Page structure / element refs → browser_snapshot. Screenshot → browser_screenshot (cannot be done via JS).\n' +
  '• Read/write DOM OR call an internal API (fetch) OR read cookies on a strict-CSP SPA → browser_run_action (runs via CDP, bypasses CSP, returns real values; shows a yellow debugger banner).\n' +
  '• browser_evaluate is the CSP-bound, banner-free lighter sibling of run_action. Use it only when you must avoid the debugger banner AND the page allows the script. If browser_evaluate returns null, fall back to browser_run_action.\n' +
  '• Navigate (incl. hash routes) → browser_navigate. Manage tabs → browser_tabs. Wait for something → browser_wait.';

/**
 * Per-tool "use this when… / not for…" guidance, returned alongside each tool
 * in `list` and `details`. This is a relational concern (how a tool relates to
 * its alternatives), so it lives here in a central map rather than inside each
 * ToolDefinition (which would couple every tool file to its siblings). If a tool
 * has no entry here, it falls back to an empty string.
 */
const TOOL_GUIDANCE: Record<string, string> = {
  browser_click:
    'Use for ANY click — it dispatches full mouse events and has a smart-selector fallback. Prefer over JS .click().',
  browser_type:
    'Use for typing into inputs — sets the value with the native setter + input/change events so React/Vue controlled inputs update. Prefer over JS .value= .',
  browser_fill_form:
    'Use to fill several fields in one call (and optionally submit). Cheaper than repeated browser_type calls.',
  browser_click_text:
    'Use to click by visible text (works on React dropdowns/portals that may not appear in a snapshot).',
  browser_navigate:
    'Use to go to a URL. Handles hash-only routes correctly (resolves without waiting for a complete event). Returns an optional inline snapshot so you can act immediately.',
  browser_snapshot:
    'Use to understand page structure and get element refs (e1, e2…) for subsequent click/type calls. Returns the accessibility tree (semantic), not raw DOM.',
  browser_text:
    'Use to read visible text on the page. Cheapest read tool. Returns {text, title, url}.',
  browser_find:
    'Use to locate elements by natural-language description when you don\'t have a snapshot yet. Returns refs for click/type.',
  browser_screenshot:
    'Use to capture a visual image (PNG/JPEG). Cannot be done via JS — this is the only way to see the page.',
  browser_evaluate:
    'Use for one-off JS in the page MAIN world (no debugger banner, CSP-safe). NOTE: on strict-CSP SPAs it may return null — fall back to browser_run_action.',
  browser_run_action:
    'Escape hatch: read/write DOM, fetch an internal API, or read cookies on a strict-CSP site. Runs via CDP so it bypasses CSP and returns real values. Shows a yellow "is being debugged" banner.',
  browser_tabs:
    'Use to list/create/close/focus/lock tabs. ALWAYS pass an explicit tabId to other tools so the agent doesn\'t act on the tab the user is looking at.',
  browser_scroll:
    'Use to scroll the page or a specific element (pixel offset, to-element, or top/bottom). Works with virtualized feeds.',
  browser_hover:
    'Use to trigger tooltips / dropdown menus / hover-only UI states.',
  browser_select:
    'Use to pick an option in a native <select> dropdown.',
  browser_press_key:
    'Use for keyboard input (Enter, Tab, Escape, ArrowDown, Ctrl+A, …).',
  browser_wait:
    'Use to wait for an element to appear/disappear, or a fixed delay. Avoids fragile sleep loops.',
  browser_console:
    'Use to read console messages (log/warn/error) from a tab. Useful for debugging.',
  browser_network:
    'Use to read network requests the page made (filter by URL). Useful for seeing API calls.',
  browser_upload_file:
    'Use to upload a file through an <input type="file">. Works even on strict-CSP pages (uses CDP).',
  browser_drag:
    'Use for drag-and-drop (ref/selector or x/y coords). Uses CDP mouse events for reliability.',
  browser_handle_dialog:
    'Use to handle or dismiss a JS dialog (alert/confirm/prompt) that blocks the page.',
};

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
            guidance: TOOL_GUIDANCE[t.name] ?? '',
            active: deps.isActive(t.name),
          }));
        return textResult(JSON.stringify({ preamble: TASK_PREAMBLE, tools }));
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
          .map((t) => ({ name: t.name, summary: t.summary, guidance: TOOL_GUIDANCE[t.name] ?? '', active: deps.isActive(t.name) }));
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
        // Return the full definition with a clean JSON Schema (not Zod internals).
        // z.toJSONSchema produces proper JSON Schema with parameter descriptions —
        // .shape serializes Zod's internal structure (1213 chars of noise without
        // descriptions). This is ~50% smaller AND includes the .describe() text.
        const jsonSchema = z.toJSONSchema(def.inputSchema);
        return textResult(
          JSON.stringify({
            name: def.name,
            description: def.description,
            guidance: TOOL_GUIDANCE[def.name] ?? '',
            inputSchema: jsonSchema,
            activated: true,
            message: `Tool "${tool}" is now active. You can call it directly.`,
          }),
        );
      }

      return textResult(JSON.stringify({ error: `Unknown action: ${action}. Use "list", "search", or "details".` }));
    },
  };
}
