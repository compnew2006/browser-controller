import { z } from 'zod';
import type { ToolDefinition } from './types.js';
import { optionalTabId, forwardHandler } from './types.js';

export const navigateTool: ToolDefinition = {
  name: 'browser_navigate',
  description: 'Go to a URL (or "back" / "forward") in a tab and return the URL it landed on and a compact snapshot (snapshot:false skips it). httpStatus appears for 4xx/5xx; a network error fails; a download or 204 returns status "not-navigated". Without tabId the active tab is used.',
  inputSchema: z.object({
    url: z.string().describe('URL, or "back" / "forward"'),
    tabId: optionalTabId(),
    waitUntil: z
      .enum(['load', 'domcontentloaded'])
      .optional()
      .default('load'),
    snapshot: z
      .boolean()
      .optional()
      .default(true)
      .describe('Inline snapshot of the new page (default true)'),
  }),
  timeoutMs: 60_000,
  handler: forwardHandler('browser_navigate'),
};
