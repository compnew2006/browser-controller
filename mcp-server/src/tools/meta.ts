import { z } from "zod";
import type { ToolDefinition } from "./types.js";
import { textResult, jsonError } from "./types.js";
import { allTools, toolMap } from "./index.js";

/**
 * Progressive disclosure meta tool (Anthropic "Code Execution with MCP" pattern).
 *
 * Instead of loading all 24 tool definitions into the agent's context upfront
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
  '• Click / type / keys → browser_click / browser_type / browser_press_key (real trusted input over CDP, works in background windows; trusted:false = synthetic, no debugger banner). Fill a form → browser_fill_form. Prefer these over raw JS.\n' +
  '• Several known steps → browser_batch (one call, stops at the first error).\n' +
  '• Read visible text → browser_text (cheapest). Page structure / element refs → browser_snapshot. Screenshot → browser_screenshot (cannot be done via JS).\n' +
  '• Safe Observe → Act loop → browser_observe, then browser_act with its snapshotId/ref. This adds freshness, geometry, allowed-action, and click-occlusion checks.\n' +
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
    'Use for ANY click — a real (trusted) mouse click over CDP with a verified smart-selector fallback; works in background windows. Also clicks at x/y read off a screenshot, triple-clicks (clickCount 3) and ctrl/shift-clicks. Prefer over JS .click().',
  browser_type:
    'Use for typing into inputs — real key presses over CDP, so autocomplete/lookup widgets react like for a user. change/blur fire when focus leaves: follow with browser_press_key Tab. Prefer over JS .value= .',
  browser_batch:
    'Use to run several known steps (click → type → Tab → wait → text) in ONE call. Stops at the first failing step. Biggest round-trip saver.',
  browser_fill_form:
    "Use to fill several fields in one call (and optionally submit). Cheaper than repeated browser_type calls.",
  browser_click_text:
    "Use to click by visible text (works on React dropdowns/portals that may not appear in a snapshot).",
  browser_navigate:
    "Use to go to a URL. Handles hash-only routes correctly (resolves without waiting for a complete event). Returns an optional inline snapshot so you can act immediately.",
  browser_snapshot:
    "Use to understand page structure and get element refs (e1, e2…) for subsequent click/type calls. Returns the accessibility tree (semantic), not raw DOM.",
  browser_text:
    'Use to read visible text on the page (incl. shadow DOM). Cheapest read tool. mode:"article" = main content only; page long text with offset/nextOffset. Returns {text, title, url}.',
  browser_find:
    'Use to locate elements by natural-language description ("search input", "Save button") when you don\'t have a snapshot yet — cheaper than a snapshot. Sees shadow DOM and same-origin iframes. Returns refs for every ref tool.',
  browser_screenshot:
    "Use to capture a visual image (PNG/JPEG). Cannot be done via JS — this is the only way to see the page.",
  browser_evaluate:
    "Use for one-off JS in the page MAIN world (no debugger banner). CSP-RESTRICTED: on strict-CSP SPAs it may return null — fall back to browser_run_action (CDP, bypasses CSP).",
  browser_run_action:
    'Escape hatch: read/write DOM, fetch an internal API, or read cookies on a strict-CSP site. Runs via CDP so it bypasses CSP and returns real values. Shows a yellow "is being debugged" banner.',
  browser_tabs:
    "Use to list/create/close/focus/lock tabs. ALWAYS pass an explicit tabId to other tools so the agent doesn't act on the tab the user is looking at.",
  browser_scroll:
    "Use to scroll the page or a specific element (pixel offset, to-element, or top/bottom). Works with virtualized feeds.",
  browser_hover:
    'Use to trigger tooltips / dropdown menus / hover-only UI states (ref, selector or x/y).',
  browser_shortcuts:
    'Use for a workflow you repeat (login-free form fill, report export…): save it once with {{variables}}, then run it in ONE call.',
  browser_list_browsers:
    'Use only when several browsers/profiles are connected: shows browserIds and which one this session uses.',
  browser_select_browser:
    'Use to work in another connected browser/profile (then list its tabs). "auto" = default.',
  browser_gif:
    'Use to show the user what you did: start before a flow, export after — writes an animated .gif (clicks marked) and returns its path.',
  browser_resize_window:
    'Use to test responsive layouts or maximize/restore the window holding a tab. Resizes the user\'s window — prefer a separate window for experiments.',
  browser_select:
    'Use to pick an option in a native <select> dropdown.',
  browser_press_key:
    'Use for keyboard input (Enter, Tab, Escape, ArrowDown, Ctrl+A, …), key sequences ("ArrowDown ArrowDown Enter") and repeat.',
  browser_wait:
    'Use to wait for an element to appear/disappear, text to appear/disappear, a URL change, or a fixed delay. Avoids fragile sleep loops.',
  browser_console:
    "Use to read console messages (log/warn/error) from a tab. Useful for debugging.",
  browser_network:
    "Use to read network requests the page made (filter by URL). Useful for seeing API calls.",
  browser_upload_file:
    'Use to upload a file through an <input type="file">. Works even on strict-CSP pages (uses CDP).',
  browser_drag:
    "Use for drag-and-drop (ref/selector or x/y coords). Uses CDP mouse events for reliability.",
  browser_handle_dialog:
    'Use to handle or dismiss a JS dialog (alert/confirm/prompt) that blocks the page.',
  browser_intercept:
    "Use to block/redirect/mock network traffic per tab (rules by URL regex) or export a redacted HAR. Check the enforcement flag — capture-only means rules are ledger-marked, not applied.",
  browser_observe:
    'Use as the primary AI-facing page read before browser_act. It returns compact, session-owned refs with allowed actions and geometry.',
  browser_act:
    'Use with browser_observe output when acting safely matters. It rejects stale, hidden, disabled, semantically invalid, or occluded targets.',
};

export function createMetaTool(deps: MetaToolDeps): ToolDefinition {
  return {
    name: "browser_tools",
    summary: "Discover and activate browser tools (progressive disclosure)",
    description: `Discover, search, and activate browser control tools. Instead of loading all tool definitions upfront, use this to find the right tool for your task.

Actions:
- "list": See all available tools with short summaries (~400 tokens).
- "search": Find tools by keyword (e.g. query:"click" matches browser_click, browser_click_text).
- "details": Get the full schema + description for one tool AND activate it so you can call it.

Workflow: call "list" or "search" first, then "details" on the tool you need, then call that tool directly.`,
    inputSchema: z.object({
      action: z
        .enum(["list", "search", "details"])
        .describe(
          "list = all summaries; search = find by keyword; details = full schema + activate",
        ),
      query: z
        .string()
        .optional()
        .describe(
          'Search query (for action:"search"). Matches tool name + summary.',
        ),
      tool: z
        .string()
        .optional()
        .describe('Tool name (for action:"details"). e.g. "browser_click"'),
    }),
    async handler(_host, params) {
      const { action, query, tool } = params as {
        action: string;
        query?: string;
        tool?: string;
      };

      if (action === "list") {
        const tools = allTools
          .filter((t) => t.name !== "browser_tools") // don't list the meta tool itself
          .map((t) => ({
            name: t.name,
            summary: t.summary,
            guidance: TOOL_GUIDANCE[t.name] ?? "",
            active: deps.isActive(t.name),
          }));
        return textResult(JSON.stringify({ preamble: TASK_PREAMBLE, tools }));
      }

      if (action === "search") {
        if (!query) {
          return jsonError({ error: 'query is required for action:"search"' });
        }
        const q = query.toLowerCase();
        const matches = allTools
          .filter((t) => t.name !== "browser_tools")
          .filter((t) => {
            const haystack = (
              t.name +
              " " +
              t.summary +
              " " +
              t.description
            ).toLowerCase();
            // match if ANY word in the query appears in the haystack
            return q
              .split(/\s+/)
              .some((word) => word.length > 1 && haystack.includes(word));
          })
          .map((t) => ({
            name: t.name,
            summary: t.summary,
            guidance: TOOL_GUIDANCE[t.name] ?? "",
            active: deps.isActive(t.name),
          }));
        return textResult(
          JSON.stringify({ query, matches, count: matches.length }),
        );
      }

      if (action === "details") {
        if (!tool) {
          return jsonError({ error: 'tool is required for action:"details"' });
        }
        const def = toolMap.get(tool);
        if (!def) {
          return jsonError({
            error: `Unknown tool: ${tool}`,
            available: allTools
              .filter((t) => t.name !== "browser_tools")
              .map((t) => t.name),
          });
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
            guidance: TOOL_GUIDANCE[def.name] ?? "",
            inputSchema: jsonSchema,
            activated: true,
            message: `Tool "${tool}" is now active. You can call it directly.`,
          }),
        );
      }

      return jsonError({
        error: `Unknown action: ${action}. Use "list", "search", or "details".`,
      });
    },
  };
}
