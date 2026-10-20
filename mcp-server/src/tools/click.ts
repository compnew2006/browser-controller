import { z } from 'zod';
import type { ToolDefinition } from './types.js';
import { requireTabId, forwardHandler } from './types.js';

const target = {
  ref: z.string().optional(),
  selector: z.string().optional(),
  x: z.number().optional().describe('Viewport x in CSS px, with y'),
  y: z.number().optional(),
};

export const clickTool: ToolDefinition = {
  name: 'browser_click',
  description:
    'Real mouse click on an element (ref, selector, or its visible text) or a viewport point (x/y, e.g. off a screenshot). hover:true only moves the mouse there (menus, tooltips); dragTo drags it onto another element or point. A hidden, disabled or covered target is not clicked (HIDDEN / DISABLED / COVERED).',
  inputSchema: z.object({
    tabId: requireTabId(),
    ...target,
    text: z.string().optional().describe('Visible text or label, case-insensitive; buttons and links first, exact match first'),
    button: z.enum(['left', 'right', 'middle']).optional(),
    clickCount: z.number().int().min(1).max(3).optional().describe('2 = double, 3 = triple click'),
    modifiers: z.array(z.enum(['ctrl', 'alt', 'shift', 'meta'])).optional().describe('Held during the click (ctrl+click opens a link in a new tab)'),
    hover: z.boolean().optional().describe('Move the mouse there without clicking'),
    dragTo: z.object(target).optional().describe('Press here, drag, release on this element or point'),
  }).superRefine((p, ctx) => {
    if (!p.ref && !p.selector && !p.text && !(Number.isFinite(p.x) && Number.isFinite(p.y))) {
      ctx.addIssue({ code: 'custom', message: 'ref, selector or text (or x and y) is required', path: ['ref'] });
    }
  }),
  timeoutMs: 15_000,
  handler: forwardHandler('browser_click'),
};
