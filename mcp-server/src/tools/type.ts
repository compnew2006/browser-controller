import { z } from 'zod';
import type { ToolDefinition } from './types.js';
import { tabIdParam, targetParam, forwardHandler } from './types.js';
import { actionHandler, actionOptionsShape } from './action-support.js';

export const typeTool: ToolDefinition = {
  name: 'browser_type',
  summary: 'Type text or press a key in a field',
  description: 'Trusted typing into target, or the focused element. key sends one key or combo (Enter, Control+a), or several in order ("ArrowDown ArrowDown Enter"). clear first; submit presses Enter after.',
  inputSchema: z.object({
    tabId: tabIdParam,
    ...actionOptionsShape,
    target: targetParam.optional(),
    text: z.string().optional(),
    key: z.string().optional(),
    clear: z.boolean().optional(),
    submit: z.boolean().optional(),
  }).strict().superRefine((params, ctx) => {
    // Mirrors the handler: with nothing to type, press, clear or submit, the call does nothing.
    const acts = Boolean(params.text) || params.key !== undefined || params.clear === true || params.submit === true;
    if (!acts) {
      ctx.addIssue({ code: 'custom', message: 'give one of text, key, clear or submit' });
    }
  }),
  timeoutMs: 15_000,
  handler: actionHandler('browser_type', forwardHandler('browser_type')),
};
