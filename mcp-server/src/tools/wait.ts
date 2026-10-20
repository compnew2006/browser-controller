import { z } from 'zod';
import type { ToolDefinition } from './types.js';
import { requireTabId, forwardHandler } from './types.js';

export const waitTool: ToolDefinition = {
  name: 'browser_wait',
  summary: 'Wait for a duration or condition',  description:
    'Wait for a condition: element to appear (any visible match, including inside shadow DOM / same-origin iframes), element to disappear, text to appear/disappear, the URL to change, or a fixed delay. Useful for SPAs and dynamic content.',
  inputSchema: z.object({
    tabId: requireTabId(),
    selector: z.string().optional().describe('CSS selector to wait for'),
    state: z
      .enum(['visible', 'hidden', 'attached'])
      .optional()
      .default('visible')
      .describe('Wait until element is visible, hidden, or attached to DOM'),
    timeout: z.number().optional().default(10000).describe('Max wait time in ms (capped at 50000; the result says so in note)'),
    delay: z.number().optional().describe('Fixed delay in ms, capped at 30000 (ignores selector/text/urlIncludes). The result reports the time actually waited.'),
    text: z.string().optional().describe('Wait until this text is on the page (state "hidden": until it is gone). Case-insensitive.'),
    urlIncludes: z.string().optional().describe('Wait until the tab URL contains this string (e.g. after a client-side navigation).'),
  }),
  timeoutMs: 60_000,
  handler: forwardHandler('browser_wait'),
};
