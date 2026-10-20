import { z } from 'zod';
import type { ToolDefinition } from './types.js';
import { requireTabId, forwardHandler } from './types.js';

export const snapshotTool: ToolDefinition = {
  name: 'browser_snapshot',
  summary: 'Get the accessibility tree with element refs',
  description:
    'Accessibility tree of the page with refs for every ref tool (shadow DOM and same-origin iframes included; a cross-origin iframe is listed by origin only). Hidden elements (display:none, opacity:0, inert, aria-hidden) are left out; a password value shows as "••••". Compact by default: interactive elements, landmarks and headings; look-alike controls carry their row text. Capped at maxChars (default 20000, then truncated:true): scope big pages with selector or ref. source:"native" = Chrome\'s own tree via the debugger (falls back to the DOM tree if it cannot attach); "dom" (default) needs no debugger.',
  inputSchema: z.object({
    tabId: requireTabId(),
    selector: z.string().optional().describe('Only this element\'s subtree'),
    ref: z.string().optional().describe('Only this ref\'s subtree'),
    compact: z.boolean().optional().default(true).describe('false = full tree'),
    filter: z.enum(['interactive', 'all']).optional().describe('"interactive" = compact, "all" = full tree'),
    depth: z.number().int().min(0).max(100).optional().describe('Max nesting depth'),
    source: z.enum(['dom', 'native']).optional(),
    maxChars: z.number().int().min(500).max(200_000).optional(),
  }),
  // Read-only (refs are deterministic given a stable DOM): safe to retry.
  idempotent: true,
  timeoutMs: 15_000,
  handler: forwardHandler('browser_snapshot'),
};
