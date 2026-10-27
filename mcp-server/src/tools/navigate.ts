import { z } from 'zod';
import type { ToolDefinition } from './types.js';
import { tabIdParam, forwardHandler } from './types.js';

export const navigateTool: ToolDefinition = {
  name: 'browser_navigate',
  summary: 'Go to a URL, or back, forward or reload a tab',
  description: 'Load a URL (scheme optional), or back / forward / reload. No tabId: opens a new background tab (incognito: true = in a private window). A network failure fails NAVIGATION_FAILED.',
  inputSchema: z.object({
    url: z.string().describe('URL, or back / forward / reload'),
    tabId: tabIdParam.optional(),
    snapshot: z.boolean().optional().describe('Append a compact snapshot'),
    incognito: z.boolean().optional().describe('New tab only: open it in a private window'),
  }).strict(),
  timeoutMs: 20_000,
  handler: forwardHandler('browser_navigate'),
};
