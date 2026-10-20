import { z } from 'zod';
import type { ToolDefinition } from './types.js';
import { forwardHandler } from './types.js';

// Answered by the bridge itself (it holds every extension connection), not by
// an extension — see BRIDGE_TOOLS in bridge.ts.

export const listBrowsersTool: ToolDefinition = {
  name: 'browser_list_browsers',
  summary: 'List the connected browsers (Chrome profiles)',
  description:
    'Connected browsers (Chrome profiles): browserId, label, which one is the default (the first seen by this daemon that is still connected) and the one this session uses. Only needed with several.',
  inputSchema: z.object({}),
  idempotent: true,
  timeoutMs: 5_000,
  handler: forwardHandler('browser_list_browsers'),
};

export const selectBrowserTool: ToolDefinition = {
  name: 'browser_select_browser',
  summary: 'Send this session\'s browser calls to one browser',
  description:
    'Route all of this session\'s browser calls to one connected browser (browserId or label; "auto" = the default, the first browser seen by this daemon that is still connected). List tabs again after switching: tab ids belong to their browser.',
  inputSchema: z.object({
    browserId: z.string(),
  }),
  timeoutMs: 5_000,
  handler: forwardHandler('browser_select_browser'),
};
