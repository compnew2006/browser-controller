import { z } from 'zod';
import type { ToolDefinition, ToolHost, ToolResult } from './types.js';
import { tabIdParam, forwardHandler, rawResultOf } from './types.js';
import { waitForPageToSettle } from './page-stability.js';

const forwardNavigate = forwardHandler('browser_navigate');

/**
 * browser_navigate, then wait for the page to draw.
 *
 * The load event is not the end of the page: an app that renders after it (a
 * React app, a script that fills a table) is still empty when the navigation
 * returns. A read that follows the navigation would then see the page before
 * it drew. Waiting for the page to settle closes that window, the same way it
 * does after an action.
 */
const handler = async (host: ToolHost, params: Record<string, unknown>): Promise<ToolResult> => {
  const result = await forwardNavigate(host, params);
  if (result.isError) return result;
  const tabId = rawResultOf(result)?.tabId ?? (typeof params.tabId === 'number' ? params.tabId : undefined);
  if (typeof tabId === 'number') await waitForPageToSettle(host, tabId);
  return result;
};
(handler as { toolName?: string }).toolName = 'browser_navigate';

export const navigateTool: ToolDefinition = {
  name: 'browser_navigate',
  summary: 'Go to a URL, or back, forward or reload a tab',
  description: 'Load a URL (scheme optional), or go back/forward/reload. Without tabId, opens a background tab; incognito:true is private. Returns after drawing; network failures are NAVIGATION_FAILED.',
  inputSchema: z.object({
    url: z.string().describe('URL, or back / forward / reload'),
    tabId: tabIdParam.optional(),
    snapshot: z.boolean().optional().describe('Append a compact snapshot'),
    incognito: z.boolean().optional().describe('New tab only: open it in a private window'),
  }).strict(),
  timeoutMs: 20_000,
  handler,
};
