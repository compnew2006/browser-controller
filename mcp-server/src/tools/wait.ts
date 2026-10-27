import { z } from 'zod';
import type { ToolDefinition } from './types.js';
import { tabIdParam, targetParam, forwardHandler } from './types.js';

export const waitTool: ToolDefinition = {
  name: 'browser_wait',
  summary: 'Wait for an element, a URL or a delay',
  description: 'Wait for exactly one of: target visible (gone:true = hidden), url (substring or glob), ms (delay). Times out with TIMEOUT.',
  inputSchema: z.object({
    tabId: tabIdParam,
    target: targetParam.optional(),
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
  // Playwright's browser_wait_for names (text, textGone, time in seconds) and a bare selector.
  normalize: (params) => {
    const out = { ...params };
    const notes: string[] = [];
    if (out.target === undefined) {
      const [key] = ['text', 'textGone', 'selector'].filter((name) => typeof out[name] === 'string');
      if (key) {
        out.target = key === 'selector' ? out[key] : `text=${String(out[key])}`;
        delete out[key];
        if (key === 'textGone') out.gone = true;
        notes.push(`note: ${key} is read as target "${String(out.target)}"${key === 'textGone' ? ' with gone: true' : ''}`);
      }
    }
    if (out.ms === undefined && typeof out.time === 'number') {
      out.ms = Math.round(out.time * 1000);
      delete out.time;
      // A delay must fit the timeout (10 s by default): a longer one asks for that much.
      if (out.timeout === undefined && (out.ms as number) > 10_000) out.timeout = out.ms;
      notes.push(`note: time is read as ms: ${String(out.ms)} (seconds to ms)`);
    }
    return { params: out, notes };
  },
  // Waits can run up to the 50 s cap, so the transport must outlive it.
  timeoutMs: 55_000,
  handler: forwardHandler('browser_wait'),
};
