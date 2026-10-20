import { z } from 'zod';
import type { ToolDefinition } from './types.js';
import { tabIdParam, forwardHandler } from './types.js';

export const tabsTool: ToolDefinition = {
  name: 'browser_tabs',
  description:
    'List, create, close, focus, reload or lock/unlock tabs; list gives the tabIds every other tool needs. lock makes other agents queue behind you; reload also recovers a frozen (TAB_WEDGED) tab.',
  inputSchema: z.object({
    action: z
      .enum(['list', 'create', 'close', 'focus', 'reload', 'lock', 'unlock']),
    tabId: tabIdParam.optional().describe('For close/focus/reload/lock/unlock'),
    bypassCache: z.boolean().optional().describe('reload: skip the cache'),
    url: z.string().optional().describe('create: URL'),
    active: z.boolean().optional().describe('create: false = open in the background'),
    window: z.boolean().optional().describe('focus: raise its window too'),
    fullUrls: z.boolean().optional().describe('list: keep long URLs whole'),
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
