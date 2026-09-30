import { z } from 'zod';
import type { ToolDefinition } from './types.js';
import { requireTabId, forwardHandler } from './types.js';

export const hoverTool: ToolDefinition = {
  name: 'browser_hover',
  summary: 'Hover over an element',  description: 'Hover over an element (ref/selector) or a viewport point (x/y) to trigger tooltips, dropdown menus, or hover states. Real mouse move over CDP.',
  inputSchema: z.object({
    tabId: requireTabId(),
    ref: z.string().optional().describe('Element reference from snapshot'),
    selector: z.string().optional().describe('CSS selector for the element'),
    x: z.number().optional().describe('Viewport x in CSS px (from browser_screenshot / find bounds) — use with y instead of ref/selector'),
    y: z.number().optional().describe('Viewport y in CSS px — use with x'),
    trusted: z.boolean().optional().describe('Real (isTrusted) mouse move over CDP — default. false = synthetic DOM events, no debugger banner.'),
  }),
  timeoutMs: 5_000,
  handler: forwardHandler('browser_hover'),
};
