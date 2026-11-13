import { z } from 'zod';
import type { ToolDefinition, ToolHost, ToolResult } from './types.js';
import { tabIdParam, forwardHandler, rawResultOf } from './types.js';
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
  const raw = rawResultOf(result);
  const withBrowserMetadata = raw && Array.isArray(raw.browsers)
    ? {
      ...result,
      structuredContent: {
        success: raw.success !== false,
        browsers: raw.browsers,
        defaultBrowserId: raw.defaultBrowserId ?? null,
        selectedBrowserId: raw.selectedBrowserId ?? null,
        ...(raw.pinnedAuto === true ? { pinnedAuto: true } : {}),
      },
    }
    : result;
  if (action !== 'list' || !isIsolated(host)) return withBrowserMetadata;
  // An isolated session sees its own tabs only: the user's are counted, not shown.
  return {
    ...withBrowserMetadata,
    content: withBrowserMetadata.content.map((item, index) => (
      item.type === 'text' && index === 0 ? { ...item, text: isolateTabListing(item.text) } : item
    )),
  };
};
(handler as { toolName?: string }).toolName = 'browser_tabs';

export const tabsTool: ToolDefinition = {
  name: 'browser_tabs',
  summary: 'List tabs/profiles, select a browser, set session policy',
  description: 'list: tabs. profiles: connected browser IDs/names and read-only availability (no switch). close/focus need tabId; browser selects a profile (auto = earliest connected); session reads/sets policy.',
  inputSchema: z.object({
    action: z.enum(['list', 'profiles', 'close', 'focus', 'session']).optional().describe('Default list; profiles is read-only'),
    tabId: tabIdParam.optional(),
    browser: z.string().optional().describe('auto, browserId, or unique profile label'),
    isolation: z.enum(['trusted', 'isolated']).optional().describe('session action: which tabs the agent may act on'),
    access: z.enum(['full', 'read-only']).optional().describe('session action: whether the agent may change pages'),
  }).strict().superRefine((params, ctx) => {
    const action = params.action ?? 'list';
    if ((action === 'close' || action === 'focus') && params.tabId === undefined) {
      ctx.addIssue({ code: 'custom', path: ['tabId'], message: `tabId is required for ${params.action}` });
    }
    if (action === 'profiles' && params.browser !== undefined) {
      ctx.addIssue({ code: 'custom', path: ['browser'], message: 'browser cannot be combined with profiles' });
    }
  }),
  timeoutMs: 10_000,
  handler,
};
