import { z } from 'zod';
import type { ToolDefinition } from './types.js';
import { optionalTabId, forwardHandler } from './types.js';

export const navigateTool: ToolDefinition = {
  name: 'browser_navigate',
  summary: 'Navigate a tab to a URL (+ optional inline snapshot)',  description: 'Navigate to a URL in a browser tab. If tabId is omitted, navigates the active tab (or use browser_tabs create to open a new one). The scheme is optional ("example.com" is https://example.com; localhost is http). Returns the final URL after redirects (requestedUrl when it differs) and the HTTP status (404/500 are reported, not thrown; the page still loaded). A network failure fails with NAVIGATION_FAILED; a 204 response or a file download returns noContent / download without waiting for a page. back/forward use the tab history and fail with NO_HISTORY_ENTRY when there is nothing to go to. By default also returns a compact snapshot of the new page so you can act immediately; set snapshot:false to skip it and save tokens.',
  inputSchema: z.object({
    url: z.string().describe('A web address (the scheme is optional), or "back" / "forward" to move through the tab history'),
    tabId: optionalTabId(),
    waitUntil: z
      .enum(['load', 'domcontentloaded'])
      .optional()
      .default('load')
      .describe('When to consider navigation complete'),
    snapshot: z
      .boolean()
      .optional()
      .default(true)
      .describe('Return an inline snapshot of the new page (default true). Set false to save tokens when you will call browser_snapshot yourself.'),
  }),
  timeoutMs: 60_000,
  handler: forwardHandler('browser_navigate'),
};
