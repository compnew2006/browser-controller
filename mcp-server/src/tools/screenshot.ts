import { z } from 'zod';
import type { ToolDefinition } from './types.js';
import { tabIdParam, targetParam, forwardHandler } from './types.js';

export const screenshotTool: ToolDefinition = {
  name: 'browser_screenshot',
  summary: 'Screenshot of a tab, an element or a region',
  description: 'JPEG of the viewport, of target (cropped to its box) or of region (CSS px). Longest side at most 1568 px.',
  inputSchema: z.object({
    tabId: tabIdParam,
    target: targetParam.optional(),
    region: z.object({
      x: z.number(),
      y: z.number(),
      width: z.number().positive(),
      height: z.number().positive(),
    }).strict().optional().describe('Crop rectangle, CSS px'),
  }).strict(),
  // Read-only: safe to retry.
  idempotent: true,
  timeoutMs: 15_000,
  handler: forwardHandler('browser_screenshot'),
};
