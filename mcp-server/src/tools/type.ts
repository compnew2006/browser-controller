import { z } from 'zod';
import type { ToolDefinition } from './types.js';
import { requireTabId, forwardHandler } from './types.js';

export const typeTool: ToolDefinition = {
  name: 'browser_type',
  summary: 'Type text into an input element',
  description: 'Type text into an input (ref/selector, or the focused element) with real key presses over CDP (keydown, keypress, input, keyup per character). change/blur fire only when focus leaves: follow with browser_press_key Tab to commit. Returns the typed character count (typed) and the field value (first 100 characters). Falls back to synthetic events if the debugger cannot attach.',
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
