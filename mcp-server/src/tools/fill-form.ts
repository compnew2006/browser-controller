import { z } from 'zod';
import type { ToolDefinition } from './types.js';
import { requireTabId, forwardHandler } from './types.js';

export const fillFormTool: ToolDefinition = {
  name: 'browser_fill_form',
  summary: 'Fill multiple form fields in one call',  description:
    'Fill several fields in one call (text, select, checkbox, contentEditable), optionally submit.',
  inputSchema: z.object({
    tabId: requireTabId(),
    fields: z
      .array(
        z.object({
          ref: z.string().optional(),
          selector: z.string().optional(),
          value: z.union([z.string(), z.boolean()]),
          clear: z.boolean().optional().default(true),
        }),
      ),
    submit: z.boolean().optional().default(false),
  }),
  timeoutMs: 15_000,
  handler: forwardHandler('browser_fill_form'),
};
