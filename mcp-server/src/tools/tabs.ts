import { z } from 'zod';
import type { ToolDefinition, ToolHost, ToolResult } from './types.js';
import { tabIdParam, forwardHandler } from './types.js';
import { getSessionPolicy, setSessionPolicy, isIsolated, isolateTabListing, type Access, type Isolation } from './session-mode.js';

const forwardTabs = forwardHandler('browser_tabs');

/**
 * browser_tabs {action:'session'}: the session's own policy.
 *
 * `isolation` decides which tabs the agent may act on (its own only, or the
 * user's too). `access` decides whether it may change anything at all. Both
 * default to the current value, so the action with no parameter reports the
 * policy as it stands.
 */
const handler = async (host: ToolHost, params: Record<string, unknown>): Promise<ToolResult> => {
  const action = (params.action ?? 'list') as string;
  if (action === 'session') {
    const patch: { isolation?: Isolation; access?: Access } = {};
    if (params.isolation !== undefined) patch.isolation = params.isolation as Isolation;
    if (params.access !== undefined) patch.access = params.access as Access;
    const policy = setSessionPolicy(host, patch);
    return {
      content: [{ type: 'text', text: `session policy: isolation=${policy.isolation}; access=${policy.access}` }],
      structuredContent: { success: true, session: policy },
    };
  }
  const result = await forwardTabs(host, params);
  if (action !== 'list' || !isIsolated(host)) return result;
  // An isolated session sees its own tabs only: the user's are counted, not shown.
  return {
    ...result,
    content: result.content.map((item, index) => (
      item.type === 'text' && index === 0 ? { ...item, text: isolateTabListing(item.text) } : item
    )),
  };
};
(handler as { toolName?: string }).toolName = 'browser_tabs';

export const tabsTool: ToolDefinition = {
  name: 'browser_tabs',
  summary: 'List tabs, close or focus one, pick a browser, set the session policy',
  description: 'list (default): this session\'s tabs and the user\'s focused tab. close / focus need tabId. browser picks this session\'s Chrome profile ("auto" = default). session reads or sets the policy: isolation and access.',
  inputSchema: z.object({
    action: z.enum(['list', 'close', 'focus', 'session']).optional().describe('Default list'),
    tabId: tabIdParam.optional(),
    browser: z.string().optional().describe('"auto" or a browser id'),
    isolation: z.enum(['trusted', 'isolated']).optional().describe('session action: which tabs the agent may act on'),
    access: z.enum(['full', 'read-only']).optional().describe('session action: whether the agent may change pages'),
  }).strict().superRefine((params, ctx) => {
    const action = params.action ?? 'list';
    if ((action === 'close' || action === 'focus') && params.tabId === undefined) {
      ctx.addIssue({ code: 'custom', path: ['tabId'], message: `tabId is required for ${params.action}` });
    }
  }),
  timeoutMs: 10_000,
  handler,
};
