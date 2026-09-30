import { z } from 'zod';
import type { ToolDefinition } from './types.js';
import { forwardHandler } from './types.js';

// Answered by the bridge itself (it holds every extension connection), not by
// an extension — see BRIDGE_TOOLS in bridge.ts.

export const listBrowsersTool: ToolDefinition = {
  name: 'browser_list_browsers',
  summary: 'List the connected browsers (Chrome profiles)',
  description:
    'List every browser (Chrome profile / instance with the extension) connected to Browser Controller: browserId, label, which one is the default and which one this session uses. With one browser connected you never need this.',
  inputSchema: z.object({}),
  idempotent: true,
  timeoutMs: 5_000,
  handler: forwardHandler('browser_list_browsers'),
};

export const selectBrowserTool: ToolDefinition = {
  name: 'browser_select_browser',
  summary: 'Send this session\'s browser calls to one browser',
  description:
    'Route all of this session\'s browser tool calls to one connected browser (by browserId or label from browser_list_browsers). "auto" goes back to the default (the most recently connected browser). Tab ids belong to their browser — list tabs again after switching.',
  inputSchema: z.object({
    browserId: z.string().describe('browserId or label from browser_list_browsers, or "auto"'),
  }),
  timeoutMs: 5_000,
  handler: forwardHandler('browser_select_browser'),
};
