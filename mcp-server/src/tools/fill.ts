import { z } from 'zod';
import type { ToolDefinition } from './types.js';
import { requireTabId, forwardHandler } from './types.js';

export const fillTool: ToolDefinition = {
  name: 'browser_fill',
  description:
    'Set form fields in one call: text fields and textareas (value replaced), <select> (option value or label; a list for multiple), checkbox/radio/switch (true/false), date/time/color/range, file inputs (absolute local path or list of paths). Lists only the fields that failed. Does not submit: click the submit button.',
  inputSchema: z.object({
    tabId: requireTabId(),
    fields: z
      .array(
        z.object({
          ref: z.string().optional(),
          selector: z.string().optional(),
          value: z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]),
        }),
      )
      .min(1),
  }),
  timeoutMs: 30_000,
  handler: forwardHandler('browser_fill'),
};
