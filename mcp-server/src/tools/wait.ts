import { z } from 'zod';
import type { ToolDefinition } from './types.js';
import { tabIdParam, forwardHandler } from './types.js';

export const waitTool: ToolDefinition = {
  name: 'browser_wait',
  summary: 'Wait for an element, a URL or a delay',
  description: 'Wait for exactly one of: target visible (gone:true = hidden), url (substring or glob), ms (delay). Times out with TIMEOUT.',
  inputSchema: z.object({
    tabId: tabIdParam,
    target: z.string().optional(),
    gone: z.boolean().optional(),
    url: z.string().optional(),
    ms: z.number().int().min(0).max(50_000).optional(),
    timeout: z.number().int().min(1).max(50_000).optional(),
  }).strict().superRefine((params, ctx) => {
    const given = [params.target, params.url, params.ms].filter((v) => v !== undefined).length;
    if (given !== 1) {
      ctx.addIssue({ code: 'custom', path: ['target'], message: 'Give exactly one of target, url or ms' });
    }
  }),
  // Waits can run up to the 50 s cap, so the transport must outlive it.
  timeoutMs: 55_000,
  handler: forwardHandler('browser_wait'),
};
