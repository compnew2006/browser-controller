import { z } from 'zod';
import type { ToolDefinition } from './types.js';
import { tabIdParam, forwardHandler } from './types.js';

export const scrollTool: ToolDefinition = {
  name: 'browser_scroll',
  summary: 'Scroll the page, a container or to an element',
  description: 'Wheel scroll by dy / dx px at target or the page centre. With only target: scroll it into view. Nothing moved fails NOT_SCROLLABLE.',
  inputSchema: z.object({
    tabId: tabIdParam,
    target: z.string().optional(),
    dy: z.number().optional(),
    dx: z.number().optional(),
  }).strict(),
  timeoutMs: 10_000,
  handler: forwardHandler('browser_scroll'),
};
