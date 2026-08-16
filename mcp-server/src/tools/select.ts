import { z } from 'zod';
import type { ToolDefinition } from './types.js';
import { requireTabId, forwardHandler } from './types.js';

export const selectTool: ToolDefinition = {
  name: 'browser_select',
  summary: 'Select an option in a dropdown element',  description: 'Select an option from a dropdown/select element',
  inputSchema: z.object({
    tabId: requireTabId(),
    ref: z.string().optional().describe('Element reference from snapshot'),
    selector: z.string().optional().describe('CSS selector for the select element'),
    value: z.string().optional().describe('Option value to select'),
    label: z.string().optional().describe('Option label text to select'),
    index: z.number().optional().describe('Option index to select (0-based)'),
  }),
  timeoutMs: 10_000,
  handler: forwardHandler('browser_select'),
};
