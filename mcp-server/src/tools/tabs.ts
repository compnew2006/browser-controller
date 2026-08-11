import { z } from 'zod';
import type { ToolDefinition } from './types.js';
import { textResult } from './types.js';

export const tabsTool: ToolDefinition = {
  name: 'browser_tabs',
  summary: 'List, create, close, focus, lock, or unlock tabs',  description:
    'Manage browser tabs: list, create, close, focus, or lock. list requires no tabId. lock/unlock claim a tab for the calling agent so other agents queue behind it instead of racing (see browser_tabs lock).',
  inputSchema: z.object({
    action: z
      .enum(['list', 'create', 'close', 'focus', 'lock', 'unlock'])
      .describe('Tab action'),
    tabId: z.number().int().optional().describe('Tab ID (required for close/focus/lock/unlock)'),
    url: z.string().optional().describe('URL for create action'),
  }).superRefine((params, ctx) => {
    const targetedActions = ['close', 'focus', 'lock', 'unlock'];
    if (targetedActions.includes(params.action) && params.tabId === undefined) {
      ctx.addIssue({ code: 'custom', path: ['tabId'], message: `tabId is required for ${params.action}` });
    }
  }),
  async handler(bridge, params) {
    const result = await bridge.callTool('browser_tabs', params);
    return textResult(JSON.stringify(result));
  },
};
