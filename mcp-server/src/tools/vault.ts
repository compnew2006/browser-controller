import { z } from 'zod';
import type { ToolDefinition } from './types.js';
import { tabIdParam, forwardHandler } from './types.js';

/** Model-facing requests carry handles and tab IDs only; credentials stay in the private extension page. */
export const vaultTool: ToolDefinition = {
  name: 'browser_vault',
  summary: 'Request private credential help for the current site',
  description: 'Request a private save, list, unlock, or one-shot fill. Passwords and approval decisions are entered in the Browser Controller extension page, never in this tool call.',
  inputSchema: z.object({
    action: z.enum(['status', 'list', 'fill', 'save_login', 'unlock']),
    tabId: tabIdParam.optional(),
    handle: z.string().min(1).max(128).optional(),
    label: z.string().trim().min(1).max(80).optional(),
    requestId: z.string().min(1).max(128).optional(),
  }).strict().superRefine((params, ctx) => {
    const fail = (field: string, message: string) => ctx.addIssue({ code: 'custom', path: [field], message });
    if (params.action === 'status') {
      if (params.handle !== undefined || params.label !== undefined || params.tabId !== undefined) fail('action', 'status accepts only an optional requestId');
      return;
    }
    // Every action except status works on a tab.
    if (params.tabId === undefined) fail('tabId', `${params.action} requires tabId`);
    if (params.action === 'fill' && params.handle === undefined) fail('handle', 'fill requires a saved account handle');
    if (params.action !== 'fill' && params.handle !== undefined) fail('handle', 'handle is accepted only by fill');
    if (params.action !== 'save_login' && params.label !== undefined) fail('label', 'label is accepted only by save_login');
    if (params.requestId !== undefined) fail('requestId', 'requestId is accepted only by status');
  }),
  // Three bounded extension actions (inspection, re-inspection, fill) plus
  // local lock/audit overhead fit inside the service's 30s active fill budget.
  timeoutMs: 40_000,
  handler: forwardHandler('browser_vault'),
};
