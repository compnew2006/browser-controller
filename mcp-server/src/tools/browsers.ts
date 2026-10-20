import { z } from 'zod';
import type { ToolDefinition } from './types.js';
import { forwardHandler } from './types.js';

// Answered by the bridge itself (it holds every extension connection), not by
// an extension — see BRIDGE_TOOLS in bridge.ts.

export const listBrowsersTool: ToolDefinition = {
  name: 'browser_list_browsers',
  description:
    'Connected browsers (Chrome profiles): browserId, label, the default and the one this session uses. Only needed with several.',
  inputSchema: z.object({}),
  idempotent: true,
  timeoutMs: 5_000,
  handler: forwardHandler('browser_list_browsers'),
};

export const selectBrowserTool: ToolDefinition = {
  name: 'browser_select_browser',
  description:
    'Route this session to one connected browser (browserId or label; "auto" = the default). List tabs again after switching.',
  inputSchema: z.object({
    browserId: z.string(),
  }),
  timeoutMs: 5_000,
  handler: forwardHandler('browser_select_browser'),
};
