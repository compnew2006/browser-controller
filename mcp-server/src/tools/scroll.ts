import { z } from 'zod';
import type { ToolDefinition } from './types.js';
import { requireTabId, forwardHandler } from './types.js';

export const scrollTool: ToolDefinition = {
  name: 'browser_scroll',
  summary: 'Scroll a tab up/down/left/right',  description:
    'Scroll the page or an element. Supports pixel offsets, scrolling to elements, and named positions (top/bottom). Works with virtual scroll containers used by social media sites.',
  inputSchema: z.object({
    tabId: requireTabId(),
    direction: z.enum(['up', 'down', 'left', 'right']).optional().default('down'),
    amount: z.number().optional().default(500).describe('Pixels to scroll'),
    selector: z.string().optional().describe('CSS selector of scroll container (for virtual scroll)'),
    toElement: z.string().optional().describe('Ref or CSS selector to scroll into view'),
    position: z.enum(['top', 'bottom']).optional().describe('Scroll to top or bottom of page'),
  }),
  timeoutMs: 10_000,
  handler: forwardHandler('browser_scroll'),
};
