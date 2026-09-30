import { z } from 'zod';
import type { ToolDefinition } from './types.js';
import { requireTabId, forwardHandler } from './types.js';

export const findTool: ToolDefinition = {
  name: 'browser_find',
  summary: 'Find elements by natural language description',  description:
    'Find elements on the page using natural language (e.g. "login button", "search input", "Open alert dialog"). Matches every word against accessible names, labels, placeholders and attributes, understands role words (button, link, input, checkbox, tab, menu...), looks inside shadow DOM and same-origin iframes, and prefers the control over its wrappers. Returns refs you can use with click/type/every ref tool.',
  inputSchema: z.object({
    tabId: requireTabId(),
    query: z.string().describe('Natural language description of what to find'),
    limit: z.number().optional().default(10).describe('Max matches to return'),
    role: z.string().optional().describe('Only return elements with this ARIA role (button, link, textbox, searchbox, checkbox, tab, menuitem, combobox, heading...)'),
  }),
  // Read-only: safe to retry on timeout. (Fixes the prior wire-name drift where
  // callTool('find') disagreed with .name 'browser_find' and silently disabled
  // this retry — see audit C1.)
  idempotent: true,
  timeoutMs: 15_000,
  handler: forwardHandler('browser_find'),
};
