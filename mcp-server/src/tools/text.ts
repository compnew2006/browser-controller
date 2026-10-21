import { z } from 'zod';
import type { ToolDefinition } from './types.js';
import { tabIdParam, targetParam, forwardHandler } from './types.js';

export const textTool: ToolDefinition = {
  name: 'browser_text',
  summary: 'Readable text of the page or of one element',
  description: 'Visible text of the page or of target; hidden text is left out. Cut at maxChars with a note.',
  inputSchema: z.object({
    tabId: tabIdParam,
    target: targetParam.optional(),
    maxChars: z.number().int().min(100).max(100_000).optional(),
  }).strict(),
  // Read-only: safe to retry on timeout. (Fixes prior wire-name drift — C1.)
  idempotent: true,
  timeoutMs: 15_000,
  handler: forwardHandler('browser_text'),
};
