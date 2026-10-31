import { z } from 'zod';
import type { ToolDefinition, ToolHost, ToolResult } from './types.js';
import { tabIdParam, textResult, failureResult, rawResultOf, codedMessageOf } from './types.js';
import { prepareToolParams } from './params.js';
import { BATCH_BUDGET_MS, BATCH_MAX_DELAY_MS, BATCH_MAX_STEPS, BATCH_MAX_OUTPUT_CHARS, NOT_BATCHABLE, NO_DEFAULT_TAB, TAB_OR_ORIGIN } from './batch-limits.js';
import { noteOwnedTab, sessionGate } from './session-mode.js';

/**
 * Resolve a sibling tool by name. tools/registry.ts installs the map at load;
 * importing the barrel from here instead is what made index <-> batch an import
 * cycle. Unwired, a step fails as 'unknown tool' rather than running anything.
 */
let resolveTool: (name: string) => ToolDefinition | undefined = () => undefined;

/** Called once, by tools/registry.ts. */
export function useToolRegistry(resolve: (name: string) => ToolDefinition | undefined): void {
  resolveTool = resolve;
}

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

/**
 * The step's failure text: its CODE: message on the first line, and the lines
 * that follow it (a hint on how to go on) apart. The batch's headline is the
 * code alone; the rest travels with the step, so a hint never hides the code.
 */
function failureOf(result: ToolResult): { message: string; rest: string[] } {
  const first = result.content[0];
  const text = first?.type === 'text' ? first.text : 'failed';
  const [head, ...rest] = text.split('\n');
  // A message that ends its sentence loses the full stop: "…nothing was clicked; 0 skipped", not ".;".
  return { message: head.replace(/\.$/, ''), rest };
}

/** One step's collected output: its text, its images, its receipt and its notes. */
interface StepOutput {
  /** `step i/n tool` — the label every block carries. */
  label: string;
  tool: string;
  text: string;
  images: Array<{ type: 'image'; data: string; mimeType: string }>;
  /** The step's own receipt (click/type/fill), when it has one. */
  receipt?: Record<string, unknown>;
  /** The notes the step's own parameters produced (a renamed 2.x parameter, …). */
  notes: string[];
}

/** A step's text and images: the text blocks joined, the image blocks kept in order. */
function partsOf(result: ToolResult): { text: string; images: StepOutput['images'] } {
  const texts: string[] = [];
  const images: StepOutput['images'] = [];
  for (const item of result.content) {
    if (item.type === 'text') texts.push(item.text);
    else images.push(item);
  }
  return { text: texts.join('\n'), images };
}

/** The receipt a step carries, when it has one (click/type/fill). */
function receiptOf(result: ToolResult): Record<string, unknown> | undefined {
  const structured = result.structuredContent;
  if (structured && typeof structured === 'object' && 'receipt' in structured) {
    const receipt = (structured as Record<string, unknown>).receipt;
    if (receipt && typeof receipt === 'object') return receipt as Record<string, unknown>;
  }
  return undefined;
}

/** The memory lines the daemon added to a forwarded result; none when absent or malformed. */
function memoryLinesOf(result: ToolResult): string[] {
  const memory = rawResultOf(result)?.memory;
  return Array.isArray(memory) ? memory.filter((line): line is string => typeof line === 'string') : [];
}

/** A step's one-line summary: the first line of its text, cut short. */
function summaryOf(step: StepOutput): string {
  const first = step.text.split('\n').find((line) => line.trim().length > 0) ?? '';
  return first.length > 120 ? `${first.slice(0, 120)}…` : first;
}

/**
 * The machine entry of one step: its number, its tool, its status and a
 * one-line summary, plus the receipt fields a click/type/fill carries.
 */
function entryOf(step: StepOutput, index: number, status: 'completed' | 'failed'): Record<string, unknown> {
  const extra = { ...(step.receipt ?? {}) };
  delete extra.tool;
  delete extra.status;
  delete extra.summary;
  return { step: index + 1, tool: step.tool, status, summary: summaryOf(step), ...extra };
}

/**
 * The batch's blocks: every step's images and text, each under its own label.
 * A step's text is left as it is, so a step that answered with JSON is still
 * JSON under its label. Past the cap the later steps are cut and the cut is
 * said out loud: the agent is told to read that step again.
 */
function blocksOf(steps: StepOutput[], maxChars: number): { blocks: ToolResult['content']; cut: number } {
  const blocks: ToolResult['content'] = [];
  let used = 0;
  let cut = 0;
  for (const step of steps) {
    const body = step.notes.length ? `${step.text}\n${step.notes.join('\n')}` : step.text;
    const room = maxChars - used;
    if (room <= 0) {
      cut += 1;
      continue;
    }
    const shown = body.length > room
      ? `${body.slice(0, room)}\n… cut here: ${body.length - room} more chars (read this step again)`
      : body;
    if (shown.length < body.length) cut += 1;
    used += shown.length;
    blocks.push(...step.images);
    blocks.push({ type: 'text', text: `${step.label}:\n${shown}` });
  }
  return { blocks, cut };
}

/**
 * A blank line between the text blocks, so the steps stay readable when the
 * client joins the content blocks into one text.
 */
function separate(content: ToolResult['content']): ToolResult['content'] {
  let lastText = -1;
  content.forEach((item, index) => { if (item.type === 'text') lastText = index; });
  return content.map((item, index) =>
    item.type === 'text' && index !== lastText ? { ...item, text: `${item.text}\n` } : item);
}

/**
 * The batch's answer: every step's block, and one structured entry per step.
 * On a failure the failing step's line comes first — it is the headline and
 * the code the agent reads — and the steps that already ran follow as context,
 * so a failure never hides what the batch had already seen.
 */
function batchResult(
  steps: StepOutput[],
  entries: Array<Record<string, unknown>>,
  maxChars: number,
  failure: { label: string; message: string } | null,
): ToolResult {
  const context = blocksOf(steps, maxChars);
  const cutNote: ToolResult['content'] = context.cut > 0
    ? [{ type: 'text', text: `… ${context.cut} step(s) cut: the batch's output cap (${maxChars} chars) was reached; read them again` }]
    : [];
  if (!failure) {
    return { content: separate([...context.blocks, ...cutNote]), structuredContent: { success: true, steps: entries } };
  }
  // A failed result is coded on its first line (the failure's CODE: message), and
  // the steps that already ran travel with it as context. They travel in one text
  // item, so the coding of the failure leaves them alone.
  const head = `${failure.label}: ${failure.message}`;
  const texts: string[] = [];
  const images: ToolResult['content'] = [];
  for (const item of [...context.blocks, ...cutNote]) {
    if (item.type === 'text') texts.push(item.text);
    else images.push(item);
  }
  const content: ToolResult['content'] = [
    ...images,
    { type: 'text', text: texts.length ? `${head}\n\n${texts.join('\n\n')}` : head },
  ];
  return { content, isError: true, structuredContent: { success: false, steps: entries } };
}

/**
 * The answer of a batch that ran on after its failures: the failures are the
 * headline, the steps that ran are the context. Nothing is hidden, and the
 * result still reads as an error, because a step did fail.
 */
function continuedBatchResult(
  steps: StepOutput[],
  entries: Array<Record<string, unknown>>,
  maxChars: number,
  failures: Array<{ label: string; message: string }>,
): ToolResult {
  const completed = entries.filter((entry) => entry.status === 'completed').length;
  const first = failures[0];
  const head = `STEP_FAILED: ${failures.length} step(s) failed, ${completed} completed. First failure — ${first.label}: ${first.message}`;
  const rest = failures.slice(1).map((failure) => `${failure.label}: ${failure.message}`);
  const context = blocksOf(steps, maxChars);
  const cutNote: ToolResult['content'] = context.cut > 0
    ? [{ type: 'text', text: `… ${context.cut} step(s) cut: the batch's output cap (${maxChars} chars) was reached; read them again` }]
    : [];
  const texts: string[] = [];
  const images: ToolResult['content'] = [];
  for (const item of [...context.blocks, ...cutNote]) {
    if (item.type === 'text') texts.push(item.text);
    else images.push(item);
  }
  const lead = [head, ...rest].join('\n');
  const content: ToolResult['content'] = [
    ...images,
    { type: 'text', text: texts.length ? `${lead}\n\n${texts.join('\n\n')}` : lead },
  ];
  return { content, isError: true, structuredContent: { success: false, steps: entries } };
}

/**
 * Run several browser tool calls in one round-trip (like Claude in Chrome's
 * browser_batch). Steps run strictly in order; the batch stops at the first
 * failing step so the agent never acts on a page that didn't reach the
 * expected state (onError:"continue" asks for the run to go on anyway). Each
 * step is validated and executed exactly as if it had been called on its own,
 * so per-tool timeouts, retries and error payloads are unchanged. The whole
 * batch shares one budget: a step cannot run past it.
 *
 * Every step's result comes back, each under its own step label: a batch never
 * drops what an earlier step read.
 */
export const batchTool: ToolDefinition = {
  name: 'browser_batch',
  summary: 'Run up to 50 browser actions in one call',
  description: 'Up to 50 calls in order, each {tool, params}; stops at the first failure (onError:"continue" runs the rest and reports every failure). tabId fills steps that omit it (not browser_tabs). Every step\'s result comes back under its own step label, with one structured entry per step. One browser_evaluate reading several fields beats a read step each.',
  inputSchema: z.object({
    tabId: tabIdParam.optional(),
    maxChars: z.number().int().min(1_000).max(500_000).optional().describe('Cap on the batch\'s whole text; later steps are cut past it (default 120000)'),
    onError: z.enum(['stop', 'continue']).optional().describe('What a failing step does: stop the batch (default) or run the rest and report every failure'),
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
    const maxChars = typeof params.maxChars === 'number' ? params.maxChars : BATCH_MAX_OUTPUT_CHARS;
    const keepGoing = params.onError === 'continue';
    // The default tab: the batch's tabId, or the tab a step without tabId opened.
    let tabId = topTabId;
    const deadline = Date.now() + BATCH_BUDGET_MS;
    const steps: StepOutput[] = [];
    const entries: Array<Record<string, unknown>> = [];
    const failures: Array<{ label: string; message: string }> = [];
    for (const [i, step] of actions.entries()) {
      const label = `step ${i + 1}/${actions.length} ${step.tool}`;
      if (Date.now() >= deadline) {
        const timedOut = { label, message: `TIMEOUT: batch budget used; ${actions.length - i} skipped` };
        return keepGoing
          ? continuedBatchResult(steps, entries, maxChars, [...failures, timedOut])
          : batchResult(steps, entries, maxChars, timedOut);
      }
      const def = resolveTool(step.tool);
      let result: ToolResult;
      let notes: string[] = [];
      if (!def) {
        result = failureResult(`INVALID_ARGUMENT: unknown tool ${step.tool}`);
      } else if (NOT_BATCHABLE.has(step.tool)) {
        result = failureResult(`INVALID_ARGUMENT: ${step.tool} cannot be used inside a batch`);
      } else {
        const stepParams = { ...(step.params ?? {}) };
        const namesOrigin = TAB_OR_ORIGIN.has(def.name) && stepParams.origin !== undefined;
        if (tabId !== undefined && stepParams.tabId === undefined && !NO_DEFAULT_TAB.has(def.name) && !namesOrigin && 'tabId' in def.inputSchema.shape) {
          stepParams.tabId = tabId;
        }
        try {
          const prepared = prepareToolParams(def, stepParams);
          // The notes travel with their own step, each labelled by it.
          notes = prepared.notes.map((note) => `${label}: ${note}`);
          const parsed = prepared.params;
          // The session policy (read-only, isolated) is checked per step: a batch
          // runs its steps itself, so they do not pass through the tool wrapper.
          const gate = await sessionGate(step.tool, parsed, host);
          if (gate) {
            result = gate;
          } else {
            const outcome = await untilDeadline(runStep(def, host, parsed, deadline), deadline);
            if (outcome === BUDGET_USED) {
              // A cut write step may have completed in the page: say so, as VAULT_OUTCOME_UNKNOWN does.
              const unknown = def.idempotent === true ? '' : '; outcome unknown, the step may have completed: check the page before retrying';
              const timedOut = { label, message: `TIMEOUT: batch budget used${unknown}; ${actions.length - i - 1} skipped` };
              return keepGoing
                ? continuedBatchResult(steps, entries, maxChars, [...failures, timedOut])
                : batchResult(steps, entries, maxChars, timedOut);
            }
            result = outcome;
          }
        } catch (err) {
          result = failureResult(codedMessageOf(err));
        }
        // A step that opened its own tab (navigate without tabId) sets the default for the steps after it.
        if (!result.isError && topTabId === undefined && step.params?.tabId === undefined && !NO_DEFAULT_TAB.has(def.name)) {
          const opened = rawResultOf(result)?.tabId;
          if (typeof opened === 'number') {
            tabId = opened;
            // The tab is this session's own: in isolated mode it may act on it.
            noteOwnedTab(host, opened);
          }
        }
      }
      const parts = partsOf(result);
      // The daemon appends a navigate step's memory reminder to its text. A host
      // that keeps the lines in their own field still has them travel with the step.
      const memoryNotes = memoryLinesOf(result)
        .filter((line) => !parts.text.includes(line))
        .map((line) => `${label}: memory: ${line}`);
      const output: StepOutput = { label, tool: step.tool, text: parts.text, images: parts.images, receipt: receiptOf(result), notes: [...notes, ...memoryNotes] };
      if (result.isError) {
        const failure = failureOf(result);
        entries.push(entryOf(output, i, 'failed'));
        if (!keepGoing) {
          // The failing step's own lines (a hint on how to go on) and its notes
          // travel as context under its label.
          const extra = [...failure.rest, ...notes];
          const context = extra.length ? [...steps, { ...output, text: extra.join('\n'), images: [] }] : steps;
          return batchResult(context, entries, maxChars, { label, message: `${failure.message}; ${actions.length - i - 1} skipped` });
        }
        // onError:"continue": the failure is recorded, the failing step's own output
        // travels with the other steps, and the batch runs on.
        failures.push({ label, message: failure.message });
        steps.push(output);
        continue;
      }
      steps.push(output);
      entries.push(entryOf(output, i, 'completed'));
    }
    return failures.length > 0
      ? continuedBatchResult(steps, entries, maxChars, failures)
      : batchResult(steps, entries, maxChars, null);
  },
};
