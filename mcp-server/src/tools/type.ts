import { z } from 'zod';
import type { ToolDefinition } from './types.js';
import { requireTabId, forwardHandler } from './types.js';

export const typeTool: ToolDefinition = {
  name: 'browser_type',
  summary: 'Type text into an input element',
  description: 'Focus an input (ref/selector — or, with neither, the element that already has focus) and type text with real key presses over CDP (keydown/keypress/input/keyup per character, like a user). Like a user, `change`/blur fire only when focus leaves — follow with browser_press_key Tab to commit. Returns the field value after typing. Falls back to synthetic events if the debugger cannot attach.',
  inputSchema: z.object({
    tabId: requireTabId(),
    ref: z.string().optional().describe('Element reference from snapshot'),
    selector: z.string().optional().describe('CSS selector for the input (omit both ref and selector to type into the focused field)'),
    text: z.string().describe('Text to type'),
    clear: z.boolean().optional().default(false).describe('Clear the field before typing'),
    trusted: z.boolean().optional().describe('Real (isTrusted) input over CDP — default. false = synthetic DOM events, no debugger banner.'),
  }),
  timeoutMs: 15_000,
  handler: forwardHandler('browser_type'),
};
