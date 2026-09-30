import { z } from 'zod';
import type { ToolDefinition } from './types.js';
import { forwardHandler } from './types.js';

export const resizeWindowTool: ToolDefinition = {
  name: 'browser_resize_window',
  summary: 'Resize/maximize the window that holds a tab',
  description:
    'Resize the browser window that contains a tab (e.g. to test a responsive layout at 390x844), or set it to normal/maximized/minimized/fullscreen. Affects the whole window the user sees — prefer a separate window for experiments. Returns the resulting window and viewport size.',
  inputSchema: z.object({
    tabId: z.number().int().describe('A tab in the window to resize (from browser_tabs list)'),
    width: z.number().int().min(200).max(10000).optional().describe('Window width in px'),
    height: z.number().int().min(200).max(10000).optional().describe('Window height in px'),
    state: z.enum(['normal', 'maximized', 'minimized', 'fullscreen']).optional().describe('Window state (width/height apply to "normal")'),
  }).superRefine((p, ctx) => {
    if (p.width === undefined && p.height === undefined && p.state === undefined) {
      ctx.addIssue({ code: 'custom', path: ['width'], message: 'width, height or state is required' });
    }
  }),
  timeoutMs: 10_000,
  handler: forwardHandler('browser_resize_window'),
};
