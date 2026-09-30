import { z } from 'zod';
import type { ToolDefinition } from './types.js';
import { requireTabId, forwardHandler } from './types.js';

export const clickTool: ToolDefinition = {
  name: 'browser_click',
  summary: 'Click an element by ref or CSS selector',
  description: 'Click an element on the page using a ref from snapshot or a CSS selector, or at x/y viewport coordinates (e.g. read off a screenshot). clickCount 3 = triple click (select a line); modifiers hold keys (ctrl+click opens a link in a new tab). Uses a real mouse click over CDP (isTrusted events, real focus, default actions — works in background windows); falls back to synthetic DOM events if the debugger cannot attach.',
  inputSchema: z.object({
    tabId: requireTabId(),
    ref: z.string().optional().describe('Element reference from snapshot (e.g. "e12")'),
    selector: z.string().optional().describe('CSS selector for the element'),
    button: z.enum(['left', 'right', 'middle']).optional().default('left'),
    doubleClick: z.boolean().optional().default(false),
    clickCount: z.number().int().min(1).max(3).optional().describe('1 = click, 2 = double, 3 = triple click (overrides doubleClick)'),
    modifiers: z.array(z.enum(['ctrl', 'alt', 'shift', 'meta'])).optional().describe('Keys held during the click'),
    x: z.number().optional().describe('Viewport x in CSS px (from browser_screenshot / find bounds) — use with y instead of ref/selector'),
    y: z.number().optional().describe('Viewport y in CSS px — use with x'),
    trusted: z.boolean().optional().describe('Real (isTrusted) input over CDP — default. false = synthetic DOM events, no debugger banner.'),
  }).superRefine((params, ctx) => {
    const point = Number.isFinite(params.x) && Number.isFinite(params.y);
    if (!params.ref && !params.selector && !point) {
      ctx.addIssue({ code: 'custom', message: 'ref or selector (or x and y) is required', path: ['ref'] });
    }
  }),
  timeoutMs: 10_000,
  handler: forwardHandler('browser_click'),
};
