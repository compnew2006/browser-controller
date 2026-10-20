import { z } from 'zod';
import type { ToolDefinition } from './types.js';
import { tabIdParam, forwardHandler } from './types.js';

export const tabsTool: ToolDefinition = {
  name: 'browser_tabs',
  summary: 'List tabs, close or focus one, pick a browser',
  description: 'list (default): this session\'s tabs and the user\'s focused tab. close / focus need tabId. browser picks this session\'s Chrome profile ("auto" = default).',
  inputSchema: z.object({
    action: z.enum(['list', 'close', 'focus']).optional().describe('Default list'),
    tabId: tabIdParam.optional(),
    browser: z.string().optional().describe('"auto" or a browser id'),
  }).strict().superRefine((params, ctx) => {
    if ((params.action ?? 'list') !== 'list' && params.tabId === undefined) {
      ctx.addIssue({ code: 'custom', path: ['tabId'], message: `tabId is required for ${params.action}` });
    }
  }),
  timeoutMs: 10_000,
  handler: forwardHandler('browser_tabs'),
};
