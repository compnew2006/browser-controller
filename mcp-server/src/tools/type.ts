import { z } from 'zod';
import type { ToolDefinition } from './types.js';
import { requireTabId, forwardHandler } from './types.js';

export const typeTool: ToolDefinition = {
  name: 'browser_type',
  description: 'Type text into an input (ref/selector, or the focused element) with real key presses. change/blur fire only when focus leaves: follow with browser_press_key Tab to commit. Returns the field value.',
  inputSchema: z.object({
    tabId: requireTabId(),
    ref: z.string().optional(),
    selector: z.string().optional().describe('Omit ref and selector to type into the focused field'),
    text: z.string(),
    clear: z.boolean().optional().default(false).describe('Clear the field first'),
    trusted: z.boolean().optional(),
  }),
  timeoutMs: 15_000,
  handler: forwardHandler('browser_type'),
};
