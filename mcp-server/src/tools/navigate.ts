import { z } from 'zod';
import type { ToolDefinition } from './types.js';
import { optionalTabId, forwardHandler } from './types.js';

export const navigateTool: ToolDefinition = {
  name: 'browser_navigate',
  summary: 'Navigate a tab to a URL (+ optional inline snapshot)',
  description: 'Go to a URL (or "back" / "forward") in a tab and return a compact snapshot of the new page (snapshot:false skips it). Without tabId the active tab is used. Returns the final URL after redirects (requestedUrl when it differs) and the HTTP status (404 / 500 are reported, not thrown). A network failure fails with NAVIGATION_FAILED; a 204 or a file download returns noContent / download without waiting. back / forward with no history fail with NO_HISTORY_ENTRY.',
  inputSchema: z.object({
    url: z.string().describe('URL (the scheme is optional), or "back" / "forward" to move through the tab history'),
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
