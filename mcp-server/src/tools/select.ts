import { z } from 'zod';
import type { ToolDefinition } from './types.js';
import { requireTabId, forwardHandler } from './types.js';

export const selectTool: ToolDefinition = {
  name: 'browser_select',
  description: 'Pick an option in a native <select> by value, label or index.',
  inputSchema: z.object({
    tabId: requireTabId(),
    ref: z.string().optional(),
    selector: z.string().optional(),
    value: z.string().optional(),
    label: z.string().optional(),
    index: z.number().optional().describe('0-based'),
  }),
  timeoutMs: 10_000,
  handler: forwardHandler('browser_select'),
};
