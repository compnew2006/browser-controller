import { z } from 'zod';
import type { ToolDefinition } from './types.js';
import { requireTabId, forwardHandler } from './types.js';

export const clickTool: ToolDefinition = {
  name: 'browser_click',
  description: 'Click an element (ref or selector) or a viewport point (x/y, e.g. read off a screenshot) with a real mouse click. clickCount 2/3 = double/triple click; modifiers hold keys (ctrl+click opens a link in a new tab). A hidden, disabled or covered target is not clicked (HIDDEN / DISABLED / COVERED).',
  inputSchema: z.object({
    tabId: requireTabId(),
    ref: z.string().optional(),
    selector: z.string().optional(),
    button: z.enum(['left', 'right', 'middle']).optional().default('left'),
    doubleClick: z.boolean().optional().default(false),
    clickCount: z.number().int().min(1).max(3).optional().describe('2 = double, 3 = triple (overrides doubleClick)'),
    modifiers: z.array(z.enum(['ctrl', 'alt', 'shift', 'meta'])).optional(),
    x: z.number().optional().describe('Viewport x in CSS px, with y'),
    y: z.number().optional(),
    trusted: z.boolean().optional(),
  }).superRefine((params, ctx) => {
    const point = Number.isFinite(params.x) && Number.isFinite(params.y);
    if (!params.ref && !params.selector && !point) {
      ctx.addIssue({ code: 'custom', message: 'ref or selector (or x and y) is required', path: ['ref'] });
    }
  }),
  timeoutMs: 10_000,
  handler: forwardHandler('browser_click'),
};
