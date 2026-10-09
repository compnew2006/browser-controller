import { z } from 'zod';
import type { ToolDefinition, ToolHost, ToolResult } from './types.js';
import { optionalTabId } from './types.js';
import { toolMap } from './index.js';
import { parseToolParams } from '../register-tools.js';

/** Tools that must not run inside a batch (recursion / discovery only). */
const NOT_BATCHABLE = new Set(['browser_batch', 'browser_tools', 'browser_shortcuts']);
const MAX_STEPS = 200;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const RATE_LIMITED = /Rate limit exceeded.*Retry in ~(\d+)s/;
const MAX_RATE_RETRIES = 3;

/**
 * One step. A pure delay (browser_wait with only `delay`) sleeps here instead
 * of costing a daemon call. A step the daemon rejected for its per-session
 * rate limit never ran, so it is safe to wait out the window and resend it.
 */
async function runStep(def: ToolDefinition, host: ToolHost, params: Record<string, unknown>): Promise<ToolResult> {
  if (def.name === 'browser_wait' && typeof params.delay === 'number' && params.selector === undefined) {
    await sleep(params.delay);
    return { content: [{ type: 'text', text: JSON.stringify({ success: true, waited: params.delay }) }] };
  }
  for (let attempt = 0; ; attempt++) {
    try {
      return await def.handler(host, params);
    } catch (err) {
      const m = RATE_LIMITED.exec(err instanceof Error ? err.message : String(err));
      if (!m || attempt >= MAX_RATE_RETRIES) throw err;
      await sleep((Number(m[1]) + 1) * 1000);
    }
  }
}

/** If a step replaced the frozen tab `current`, the new tab id; else null. */
function replacedBy(result: ToolResult, current: number): number | null {
  for (const c of result.content) {
    if (c.type !== 'text' || !c.text.includes('replacedTabId')) continue;
    try {
      const r = JSON.parse(c.text) as { replacedTabId?: number; tabId?: number; reloaded?: number };
      const next = r.tabId ?? r.reloaded;
      if (r.replacedTabId === current && typeof next === 'number') return next;
    } catch { /* not a JSON payload */ }
  }
  return null;
}

/**
 * Run several browser tool calls in one round-trip (like Claude in Chrome's
 * browser_batch). Steps run strictly in order; the batch stops at the first
 * failing step so the agent never acts on a page that didn't reach the
 * expected state. Each step is validated and executed exactly as if it had
 * been called on its own, so per-tool timeouts, retries and error payloads
 * are unchanged.
 */
export const batchTool: ToolDefinition = {
  name: 'browser_batch',
  summary: 'Run several browser actions in one call (stops at first error)',
  description:
    'Run a sequence of browser tool calls (up to 200) in ONE call, in order, and get their results back (output:"last"/"errors" to keep long batches cheap). Use it to cut round-trips when you already know the next steps, e.g. click a field → type → press Tab → wait → read text. Stops at the first failing step (remaining steps are skipped) unless continueOnError is true. A top-level tabId is applied to every step that does not set its own. Steps cannot be nested batches.',
  inputSchema: z.object({
    tabId: optionalTabId().describe('Default tab id for every step that does not set its own tabId'),
    actions: z
      .array(z.object({
        tool: z.string().describe('Tool name, e.g. "browser_click"'),
        params: z.record(z.string(), z.unknown()).optional().describe('That tool\'s arguments'),
      }))
      .min(1)
      .max(MAX_STEPS)
      .describe(`Steps to run in order (max ${MAX_STEPS})`),
    continueOnError: z.boolean().optional().default(false).describe('Keep going after a failing step'),
    output: z
      .enum(['all', 'last', 'errors'])
      .optional()
      .default('all')
      .describe('all = the result of every step; last = only the last step result (+ any failure); errors = only failures. Use last/errors for long batches to save tokens.'),
  }),
  // Longest a single MCP call may reasonably take; each step keeps its own
  // transport timeout.
  timeoutMs: 300_000,
  async handler(host, params) {
    const { actions, continueOnError, output } = params as {
      tabId?: number;
      actions: Array<{ tool: string; params?: Record<string, unknown> }>;
      continueOnError: boolean;
      output: 'all' | 'last' | 'errors';
    };
    // The default tab follows a frozen tab's replacement (navigate/reload report replacedTabId).
    let tabId = (params as { tabId?: number }).tabId;
    const content: ToolResult['content'] = [];
    const batchStart = Date.now();
    const stepMs: number[] = [];
    let failed = 0;
    let ran = 0;
    for (const [i, step] of actions.entries()) {
      const label = `[${i + 1}/${actions.length}] ${step.tool}`;
      const def = toolMap.get(step.tool);
      const stepStart = Date.now();
      let result: ToolResult;
      if (!def || NOT_BATCHABLE.has(step.tool)) {
        result = { content: [{ type: 'text', text: `Error: ${def ? 'cannot be used inside a batch' : 'unknown tool'}` }], isError: true };
      } else {
        const stepParams = { ...(step.params || {}) };
        if (tabId !== undefined && stepParams.tabId === undefined && 'tabId' in def.inputSchema.shape) {
          stepParams.tabId = tabId;
        }
        try {
          result = await runStep(def, host, parseToolParams(def, stepParams));
        } catch (err) {
          result = { content: [{ type: 'text', text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
        }
      }
      const ms = Date.now() - stepStart;
      stepMs.push(ms);
      ran++;
      if (!result.isError && tabId !== undefined) {
        const replacement = replacedBy(result, tabId);
        if (replacement !== null) tabId = replacement;
      }
      const isLast = i === actions.length - 1;
      if (output === 'all' || result.isError || (output === 'last' && isLast)) {
        content.push({ type: 'text', text: `${label} ${result.isError ? 'FAILED' : 'ok'} ${ms} ms` });
        content.push(...result.content);
      }
      if (result.isError) {
        failed++;
        if (!continueOnError) {
          const skipped = actions.length - i - 1;
          if (skipped) content.push({ type: 'text', text: `Stopped: ${skipped} remaining step(s) skipped.` });
          break;
        }
      }
    }
    // Timing is appended last so the summary stays the first text block.
    content.push({ type: 'text', text: `timing: total ${Date.now() - batchStart} ms; steps ${stepMs.join(', ')} ms` });
    return {
      content: [{ type: 'text', text: `batch: ${ran - failed}/${actions.length} steps ok` }, ...content],
      ...(failed ? { isError: true } : {}),
    };
  },
};
