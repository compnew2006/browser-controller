import { z } from 'zod';
import type { ToolDefinition, ToolHost, ToolResult } from './types.js';
import { tabIdParam, targetParam, forwardHandler, failureResult, textResult } from './types.js';
import { STABLE_WAIT_DEFAULT_MS, waitUntilStable } from './page-stability.js';
import { ERROR_CODES, formatError } from '../core/error-codes.js';

const forwardWait = forwardHandler('browser_wait');

/**
 * browser_wait {until:'stable'}: wait until the page stops changing.
 *
 * The other waits look for something (an element, a URL) or wait a fixed time.
 * This one waits for the page itself to come to rest: its rendered text is
 * fingerprinted every 100 ms, and two identical readings mean the page settled.
 * It is what an agent needs after an action that redraws the page in place,
 * before reading the new state.
 */
const handler = async (host: ToolHost, params: Record<string, unknown>): Promise<ToolResult> => {
  if (params.until !== 'stable') return forwardWait(host, params);
  const tabId = params.tabId as number;
  const timeout = typeof params.timeout === 'number' ? params.timeout : STABLE_WAIT_DEFAULT_MS;
  const outcome = await waitUntilStable(host, tabId, timeout);
  if (outcome.settled) return textResult(`page settled after ${outcome.waitedMs} ms`);
  if (outcome.reason === 'unreadable') {
    return failureResult(formatError(ERROR_CODES.TIMEOUT, `the page could not be read after ${outcome.waitedMs} ms; it never settled within ${timeout} ms.`));
  }
  return failureResult(formatError(ERROR_CODES.TIMEOUT, `the page was still changing after ${outcome.waitedMs} ms; it never settled within ${timeout} ms.`));
};
(handler as { toolName?: string }).toolName = 'browser_wait';

export const waitTool: ToolDefinition = {
  name: 'browser_wait',
  summary: 'Wait for an element, a URL, a delay, or the page to settle',
  description: 'Wait for one of: target visible (gone:true = hidden), url (substring or glob), ms (delay), until:"stable" (page stops changing). Fails TIMEOUT.',
  inputSchema: z.object({
    tabId: tabIdParam,
    target: targetParam.optional(),
    gone: z.boolean().optional(),
    url: z.string().optional(),
    ms: z.number().int().min(0).max(50_000).optional(),
    until: z.enum(['stable']).optional().describe('Wait until the page stops changing'),
    timeout: z.number().int().min(1).max(50_000).optional(),
  }).strict().superRefine((params, ctx) => {
    const given = [params.target, params.url, params.ms, params.until].filter((v) => v !== undefined).length;
    if (given !== 1) {
      ctx.addIssue({ code: 'custom', path: ['target'], message: 'Give exactly one of target, url, ms or until' });
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
  handler,
};
