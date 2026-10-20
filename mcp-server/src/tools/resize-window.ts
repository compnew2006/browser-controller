import { z } from 'zod';
import type { ToolDefinition } from './types.js';
import { tabIdParam, forwardHandler } from './types.js';

export const resizeWindowTool: ToolDefinition = {
  name: 'browser_resize_window',
  summary: 'Resize/maximize the window that holds a tab',
  description:
    'Resize the window holding a tab, or set its state, for responsive testing. It is the user\'s window.',
  inputSchema: z.object({
    tabId: tabIdParam,
    width: z.number().int().min(200).max(10000).optional(),
    height: z.number().int().min(200).max(10000).optional(),
    state: z.enum(['normal', 'maximized', 'minimized', 'fullscreen']).optional().describe('width/height apply to "normal"'),
  }).superRefine((p, ctx) => {
    if (p.width === undefined && p.height === undefined && p.state === undefined) {
      ctx.addIssue({ code: 'custom', path: ['width'], message: 'width, height or state is required' });
    }
  }),
  timeoutMs: 10_000,
  handler: forwardHandler('browser_resize_window'),
};
