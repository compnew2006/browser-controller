import { z } from 'zod';
import type { ToolDefinition } from './types.js';
import { tabIdParam, forwardHandler } from './types.js';

/** Model-facing requests carry handles and tab IDs only; credentials stay in the private extension page. */
export const vaultTool: ToolDefinition = {
  name: 'browser_vault',
  summary: 'Request private credential help for the current site',
  description: 'Request a private save, list, unlock or fill. The owner approves each site once on its tab or extension page; credentials never enter this call.',
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
  // One call can wait 40 s for the owner's decision on the card and then run the fill
  // with its own 30 s budget, so the tool's limit has to cover both (F-38): a limit equal
  // to the card wait turned the owner's slow answer into a TIMEOUT instead of a decision.
  timeoutMs: 80_000,
  handler: forwardHandler('browser_vault'),
};
