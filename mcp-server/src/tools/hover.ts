import { z } from 'zod';
import type { ToolDefinition } from './types.js';
import { requireTabId, forwardHandler } from './types.js';

export const hoverTool: ToolDefinition = {
  name: 'browser_hover',
  summary: 'Hover over an element',
  description: 'Hover an element (ref/selector) or a viewport point (x/y) to show tooltips, menus or hover states. Real mouse move over CDP, so CSS :hover applies. Without the debugger the hover is synthetic: JS hover handlers run, the result says trusted:false and CSS :hover is not applied.',
  inputSchema: z.object({
    tabId: requireTabId(),
    ref: z.string().optional(),
    selector: z.string().optional(),
    x: z.number().optional().describe('Viewport x in CSS px, with y'),
    y: z.number().optional(),
    trusted: z.boolean().optional(),
  }),
  timeoutMs: 5_000,
  handler: forwardHandler('browser_hover'),
};
