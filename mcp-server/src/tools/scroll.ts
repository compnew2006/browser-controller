import { z } from 'zod';
import type { ToolDefinition } from './types.js';
import { requireTabId, forwardHandler } from './types.js';

export const scrollTool: ToolDefinition = {
  name: 'browser_scroll',
  description:
    'Scroll the page, a container (selector) or an element into view (toElement); position top/bottom. With x/y: a real wheel event at that point (inner panels, maps, virtual lists).',
  inputSchema: z.object({
    tabId: requireTabId(),
    direction: z.enum(['up', 'down', 'left', 'right']).optional().default('down'),
    amount: z.number().optional().default(500).describe('Pixels'),
    selector: z.string().optional().describe('Scroll container (virtual lists)'),
    toElement: z.string().optional().describe('Ref or selector to scroll into view'),
    position: z.enum(['top', 'bottom']).optional(),
    x: z.number().optional().describe('Wheel at this viewport point, with y'),
    y: z.number().optional(),
  }),
  timeoutMs: 10_000,
  handler: forwardHandler('browser_scroll'),
};
