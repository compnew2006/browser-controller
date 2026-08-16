import { z } from 'zod';
import type { ToolDefinition } from './types.js';
import { requireTabId, forwardHandler } from './types.js';

export const clickTool: ToolDefinition = {
  name: 'browser_click',
  summary: 'Click an element by ref or CSS selector',  description: 'Click an element on the page using a ref from snapshot or a CSS selector',
  inputSchema: z.object({
    tabId: requireTabId(),
    ref: z.string().optional().describe('Element reference from snapshot (e.g. "e12")'),
    selector: z.string().optional().describe('CSS selector for the element'),
    button: z.enum(['left', 'right', 'middle']).optional().default('left'),
    doubleClick: z.boolean().optional().default(false),
  }),
  timeoutMs: 10_000,
  handler: forwardHandler('browser_click'),
};
