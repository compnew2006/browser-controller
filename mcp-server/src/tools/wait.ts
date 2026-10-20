import { z } from 'zod';
import type { ToolDefinition } from './types.js';
import { requireTabId, forwardHandler } from './types.js';

export const waitTool: ToolDefinition = {
  name: 'browser_wait',
  description:
    'Wait for a selector (state visible/hidden/attached), text to appear (or vanish, state "hidden"), the URL to contain urlIncludes, or a fixed delay. Sees shadow DOM and same-origin iframes.',
  inputSchema: z.object({
    tabId: requireTabId(),
    selector: z.string().optional(),
    state: z
      .enum(['visible', 'hidden', 'attached'])
      .optional()
      .default('visible'),
    timeout: z.number().optional().default(10000).describe('ms'),
    delay: z.number().optional().describe('ms; ignores the other conditions'),
    text: z.string().optional().describe('Case-insensitive'),
    urlIncludes: z.string().optional(),
  }),
  timeoutMs: 60_000,
  handler: forwardHandler('browser_wait'),
};
