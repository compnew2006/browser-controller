import { z } from 'zod';
import type { ToolDefinition } from './types.js';
import { forwardHandler } from './types.js';

export const tabsTool: ToolDefinition = {
  name: 'browser_tabs',
  summary: 'List, create, close, focus, reload, lock, or unlock tabs',  description:
    'Manage browser tabs: list, create, close, focus, reload, or lock. list requires no tabId. reload also recovers a frozen (TAB_WEDGED) tab. lock/unlock claim a tab for the calling agent so other agents queue behind it instead of racing (see browser_tabs lock).',
  inputSchema: z.object({
    action: z
      .enum(['list', 'create', 'close', 'focus', 'reload', 'lock', 'unlock'])
      .describe('Tab action'),
    tabId: z.number().int().optional().describe('Tab ID (required for close/focus/reload/lock/unlock)'),
    bypassCache: z.boolean().optional().describe('reload: skip the HTTP cache'),
    url: z.string().optional().describe('URL for create action'),
    active: z.boolean().optional().describe('create: false opens the tab in the background (the user keeps their current tab)'),
    window: z.boolean().optional().describe('focus: also bring the tab\'s window to the front'),
    fullUrls: z.boolean().optional().describe('list: do not shorten long URLs'),
  }).superRefine((params, ctx) => {
    const targetedActions = ['close', 'focus', 'reload', 'lock', 'unlock'];
    if (targetedActions.includes(params.action) && params.tabId === undefined) {
      ctx.addIssue({ code: 'custom', path: ['tabId'], message: `tabId is required for ${params.action}` });
    }
  }),
  // reload waits for the new document (up to 30s); the other actions return at once.
  timeoutMs: 35_000,
  handler: forwardHandler('browser_tabs'),
};
