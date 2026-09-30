import { z } from 'zod';
import type { ToolDefinition } from './types.js';
import { requireTabId, forwardHandler } from './types.js';

export const snapshotTool: ToolDefinition = {
  name: 'browser_snapshot',
  summary: 'Get the accessibility tree with element refs',  description:
    'Get an accessibility tree snapshot of the page, including shadow DOM (web components), slotted content and same-origin iframes. Returns element refs you can use with click, type, and every other ref tool. Use compact mode (default) for smaller output - only interactive elements, landmarks and headings. Output is capped by maxChars (default 20000); scope big pages with selector or ref.',
  inputSchema: z.object({
    tabId: requireTabId(),
    selector: z.string().optional().describe('CSS selector to scope the snapshot'),
    ref: z.string().optional().describe('Snapshot only the subtree of this ref (from an earlier snapshot/find)'),
    compact: z.boolean().optional().default(true).describe('When true (default), returns only interactive elements with minimal nesting. Set false for full tree.'),
    filter: z.enum(['interactive', 'all']).optional().describe('Alias of compact: "interactive" = compact, "all" = full tree. Wins over compact when given.'),
    depth: z.number().int().min(0).optional().describe('Max nesting depth of returned nodes (0 = top level only)'),
    maxChars: z.number().int().min(500).max(200_000).optional().describe('Cap on the serialized tree size (default 20000). The result says truncated:true when hit.'),
  }),
  // Read-only (refs are deterministic given a stable DOM): safe to retry.
  idempotent: true,
  timeoutMs: 15_000,
  handler: forwardHandler('browser_snapshot'),
};
