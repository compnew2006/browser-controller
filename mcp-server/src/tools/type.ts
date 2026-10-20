import { z } from 'zod';
import type { ToolDefinition } from './types.js';
import { requireTabId, forwardHandler } from './types.js';

export const typeTool: ToolDefinition = {
  name: 'browser_type',
  description:
    'Real key presses: type text into ref/selector (or the focused field), then press key — "Enter", "ctrl+a", or a sequence "ArrowDown ArrowDown Enter". key alone goes to the focused element or the page. change fires when focus leaves (key "Tab"). Returns the field value, or after key where focus is. To set many fields at once use browser_fill.',
  inputSchema: z.object({
    tabId: requireTabId(),
    ref: z.string().optional(),
    selector: z.string().optional().describe('Omit ref and selector to use the focused field'),
    text: z.string().optional(),
    key: z.string().optional().describe('Pressed after the text'),
    clear: z.boolean().optional().describe('Clear the field first'),
  }).superRefine((p, ctx) => {
    if (p.text === undefined && !p.key && !p.clear) ctx.addIssue({ code: 'custom', message: 'text, key or both is required', path: ['text'] });
  }),
  timeoutMs: 15_000,
  handler: forwardHandler('browser_type'),
};
