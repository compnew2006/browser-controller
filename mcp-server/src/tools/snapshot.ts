import { z } from 'zod';
import type { ToolDefinition } from './types.js';
import { requireTabId, forwardHandler } from './types.js';

export const snapshotTool: ToolDefinition = {
  name: 'browser_snapshot',
  summary: 'Get the accessibility tree with element refs',
  description:
    'Get an accessibility tree snapshot of the page, including shadow DOM (web components), slotted content and same-origin iframes. Returns element refs you can use with click, type, and every other ref tool. Use compact mode (default) for smaller output - only interactive elements, landmarks and headings. Output is capped by maxChars (default 20000); scope big pages with selector or ref. source:"native" reads Chrome\'s own accessibility tree (exact roles, names and states as assistive technology computes them; uses the debugger, falls back to the DOM tree if it cannot attach); the default "dom" builds the tree from the page without the debugger.',
  inputSchema: z.object({
    tabId: requireTabId(),
    selector: z.string().optional().describe('CSS selector to scope the snapshot'),
    ref: z.string().optional().describe('Snapshot only the subtree of this ref (from an earlier snapshot/find)'),
    compact: z.boolean().optional().default(true).describe('When true (default), returns only interactive elements with minimal nesting. Set false for full tree.'),
    filter: z.enum(['interactive', 'all']).optional().describe('Alias of compact: "interactive" = compact, "all" = full tree. Wins over compact when given.'),
    depth: z.number().int().min(0).optional().describe('Max nesting depth of returned nodes (0 = top level only)'),
    source: z.enum(['dom', 'native']).optional().describe('"dom" (default): tree built from the DOM, no debugger banner. "native": Chrome\'s real accessibility tree via CDP (computed roles/names/states, closed shadow roots, same-origin iframes). Refs from either work with every ref tool. Result says source:"native"; if the debugger cannot attach you get the DOM tree plus nativeUnavailable.'),
    maxChars: z.number().int().min(500).max(200_000).optional().describe('Cap on the serialized tree size (default 20000). The result says truncated:true when hit.'),
  }),
  // Read-only (refs are deterministic given a stable DOM): safe to retry.
  idempotent: true,
  timeoutMs: 15_000,
  handler: forwardHandler('browser_snapshot'),
};
