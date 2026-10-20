import { z } from 'zod';
import type { ToolDefinition } from './types.js';
import { requireTabId, forwardHandler } from './types.js';

export const waitTool: ToolDefinition = {
  name: 'browser_wait',
  summary: 'Wait for a duration or condition',  description:
    'Wait for a selector (state visible/hidden/attached), text to appear (or vanish, state "hidden"), the URL to contain urlIncludes, or a fixed delay. Sees shadow DOM and same-origin iframes.',
  inputSchema: z.object({
    tabId: requireTabId(),
    selector: z.string().optional(),
    state: z
      .enum(['visible', 'hidden', 'attached'])
      .optional()
      .default('visible')
      .describe('Wait until element is visible, hidden, or attached to DOM'),
    timeout: z.number().optional().default(10000).describe('Max wait in ms, capped at 50000 (the result notes the cap)'),
    delay: z.number().optional().describe('Fixed delay in ms, capped at 30000 (the result reports the time actually waited); ignores the other conditions'),
    text: z.string().optional().describe('Case-insensitive; with state "hidden", waits until the text is gone'),
    urlIncludes: z.string().optional().describe('Wait until the tab URL contains this string'),
  }),
  timeoutMs: 60_000,
  handler: forwardHandler('browser_wait'),
};
