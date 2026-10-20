import { z } from 'zod';
import type { ToolDefinition, ToolHost, ToolResult } from './types.js';
import { tabIdParam, textResult, failureResult, rawResultOf, codedMessageOf } from './types.js';
import { toolMap } from './index.js';
import { parseToolParams } from '../register-tools.js';
import { BATCH_BUDGET_MS, BATCH_MAX_DELAY_MS, BATCH_MAX_STEPS, NOT_BATCHABLE, NO_DEFAULT_TAB } from './batch-limits.js';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const RATE_LIMITED = /Rate limit exceeded.*Retry in ~(\d+)s/;
const MAX_RATE_RETRIES = 3;

/** What {@link untilDeadline} returns when the batch budget ends first. */
const BUDGET_USED = Symbol('batch budget used');

/**
 * Runs one step until the batch deadline. A step still running then is left
 * behind: its late result or error is ignored, and the batch stops with BUDGET_USED.
 */
async function untilDeadline<T>(work: Promise<T>, deadline: number): Promise<T | typeof BUDGET_USED> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<typeof BUDGET_USED>((resolve) => {
    timer = setTimeout(() => resolve(BUDGET_USED), Math.max(0, deadline - Date.now()));
  });
  try {
    return await Promise.race([work, expired]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * One step. A pure delay (browser_wait with only `ms`) sleeps here instead of
 * costing a daemon call, capped at BATCH_MAX_DELAY_MS. A step the daemon
 * rejected for its per-session rate limit never ran, so it is safe to wait out
 * the window and resend it, unless the wait would pass the batch deadline.
 */
async function runStep(def: ToolDefinition, host: ToolHost, params: Record<string, unknown>, deadline: number): Promise<ToolResult> {
  if (def.name === 'browser_wait' && typeof params.ms === 'number' && params.target === undefined && params.url === undefined) {
    const requested = params.ms;
    const waited = Math.min(requested, BATCH_MAX_DELAY_MS);
    await sleep(waited);
    const note = waited < requested ? ` (delay clamped to ${BATCH_MAX_DELAY_MS} ms, requested ${requested} ms)` : '';
    return textResult(`waited ${waited} ms${note}`);
  }
  for (let attempt = 0; ; attempt++) {
    try {
      return await def.handler(host, params);
    } catch (err) {
      const m = RATE_LIMITED.exec(err instanceof Error ? err.message : String(err));
      if (!m || attempt >= MAX_RATE_RETRIES) throw err;
      const waitMs = (Number(m[1]) + 1) * 1000;
      if (Date.now() + waitMs > deadline) throw err;
      await sleep(waitMs);
    }
  }
}

/** The step's failure text: its CODE: message string. */
function messageOf(result: ToolResult): string {
  const first = result.content[0];
  return first?.type === 'text' ? first.text : 'failed';
}

/**
 * Run several browser tool calls in one round-trip (like Claude in Chrome's
 * browser_batch). Steps run strictly in order; the batch stops at the first
 * failing step so the agent never acts on a page that didn't reach the
 * expected state. Each step is validated and executed exactly as if it had
 * been called on its own, so per-tool timeouts, retries and error payloads
 * are unchanged. The whole batch shares one budget: a step cannot run past it.
 */
export const batchTool: ToolDefinition = {
  name: 'browser_batch',
  summary: 'Run up to 50 browser actions in one call',
  description: 'Up to 50 calls in order, each {tool, params}; stops at the first failure. tabId fills steps that omit it (not browser_tabs). Result: the last step.',
  inputSchema: z.object({
    tabId: tabIdParam.optional(),
    actions: z
      .array(z.object({
        tool: z.string(),
        params: z.record(z.string(), z.unknown()).optional(),
      }).strict())
      .min(1)
      .max(BATCH_MAX_STEPS),
  }).strict(),
  // The batch's time budget (BATCH_BUDGET_MS). No step runs past it, whatever its own timeout.
  timeoutMs: BATCH_BUDGET_MS,
  async handler(host, params) {
    const actions = params.actions as Array<{ tool: string; params?: Record<string, unknown> }>;
    const topTabId = params.tabId as number | undefined;
    // The default tab: the batch's tabId, or the tab a step without tabId opened.
    let tabId = topTabId;
    const deadline = Date.now() + BATCH_BUDGET_MS;
    let last: ToolResult = textResult('');
    for (const [i, step] of actions.entries()) {
      const label = `step ${i + 1}/${actions.length} ${step.tool}`;
      if (Date.now() >= deadline) {
        return failureResult(`${label}: TIMEOUT: batch budget used; ${actions.length - i} skipped`);
      }
      const def = toolMap.get(step.tool);
      let result: ToolResult;
      if (!def) {
        result = failureResult(`INVALID_ARGUMENT: unknown tool ${step.tool}`);
      } else if (NOT_BATCHABLE.has(step.tool)) {
        result = failureResult(`INVALID_ARGUMENT: ${step.tool} cannot be used inside a batch`);
      } else {
        const stepParams = { ...(step.params ?? {}) };
        if (tabId !== undefined && stepParams.tabId === undefined && !NO_DEFAULT_TAB.has(def.name) && 'tabId' in def.inputSchema.shape) {
          stepParams.tabId = tabId;
        }
        try {
          const parsed = parseToolParams(def, stepParams);
          const outcome = await untilDeadline(runStep(def, host, parsed, deadline), deadline);
          if (outcome === BUDGET_USED) {
            return failureResult(`${label}: TIMEOUT: batch budget used; ${actions.length - i - 1} skipped`);
          }
          result = outcome;
        } catch (err) {
          result = failureResult(codedMessageOf(err));
        }
        // A step that opened its own tab (navigate without tabId) sets the default for the steps after it.
        if (!result.isError && topTabId === undefined && step.params?.tabId === undefined && !NO_DEFAULT_TAB.has(def.name)) {
          const opened = rawResultOf(result)?.tabId;
          if (typeof opened === 'number') tabId = opened;
        }
      }
      if (result.isError) {
        return failureResult(`${label}: ${messageOf(result)}; ${actions.length - i - 1} skipped`);
      }
      last = result;
    }
    return last;
  },
};
