import { z } from 'zod';
import type { ToolDefinition } from './types.js';
import { tabIdParam, forwardHandler } from './types.js';

export const clickTool: ToolDefinition = {
  name: 'browser_click',
  summary: 'Click an element or a point with a trusted mouse',
  description: 'Trusted click on target, or at x,y. hover:true only moves; dragTo releases on another target. Hidden, disabled or covered: fails, nothing clicked.',
  inputSchema: z.object({
    tabId: tabIdParam,
    target: z.string(),
    button: z.enum(['left', 'right', 'middle']).optional(),
    count: z.number().int().min(1).max(3).optional(),
    modifiers: z.array(z.enum(['Alt', 'Control', 'Meta', 'Shift'])).optional(),
    hover: z.boolean().optional(),
    dragTo: z.string().optional(),
  }).strict(),
  timeoutMs: 10_000,
  handler: forwardHandler('browser_click'),
};
