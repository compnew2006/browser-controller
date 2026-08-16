import { z } from 'zod';
import type { ToolDefinition } from './types.js';
import { requireTabId, forwardHandler } from './types.js';

export const typeTool: ToolDefinition = {
  name: 'browser_type',
  summary: 'Type text into an input element',  description: 'Type text into an input element',
  inputSchema: z.object({
    tabId: requireTabId(),
    ref: z.string().optional().describe('Element reference from snapshot'),
    selector: z.string().optional().describe('CSS selector for the input'),
    text: z.string().describe('Text to type'),
    clear: z.boolean().optional().default(false).describe('Clear the field before typing'),
  }),
  timeoutMs: 15_000,
  handler: forwardHandler('browser_type'),
};
