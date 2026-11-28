/**
 * The Gap A prepare policy (plan §3): a click/type step that fails because
 * its element cannot be reached gets one automatic prepare sequence and
 * one retry — instead of failing the task at the first failure and making
 * the agent plan the scroll and hover by hand.
 *
 * Reactive, not unconditional (coordinator ruling): the step runs normally
 * first, and prepare runs ONLY when that first attempt fails with one of
 * `ELEMENT_COVERED`, `ELEMENT_HIDDEN`, `TARGET_OFFSCREEN` or
 * `CLICK_MISSED` — a click landing on the covering element is the same
 * failure, reported differently. A step that succeeds first try never
 * scrolls or hovers: unconditional hover can open hover menus by accident.
 *
 * The sequence, one of them, on the step's own target:
 * - `browser_scroll` (scroll-into-view on the target), then
 * - `browser_click {hover: true}` ONLY when the scroll itself failed with
 *   `ELEMENT_HIDDEN`, then scroll-into-view again, then
 * - ONE retry of the original action.
 * The hover branch is keyed on the scroll's own failure because the
 * extension cannot scroll a hidden element into view
 * (`extension/handlers/inspection.js`, `scrollIntoViewPage`: a hidden
 * element "cannot be scrolled to") — scroll-first would never reach the
 * hover for a hover-revealed control. A hidden element is exactly the
 * hover-revealed case (dropdown, tooltip): scrolling cannot unhide it,
 * but moving the mouse to the target can — for a menu item inside the
 * hover container, that move lands on the container and its :hover rule
 * reveals the item. For a covered or offscreen element the scroll
 * is the fix and no hover runs. If any prepare call fails, the reason is
 * recorded and the original action is NOT retried — a point target, for
 * example, has no element to scroll or hover, so the scroll tool refuses
 * it and the step fails on the original error.
 *
 * Prepare attempts are sub-evidence, not new steps (coordinator ruling):
 * they are recorded on the click/type step's own evidence — one
 * `prepare step N (...)` line in the task evidence, and the prepare notes
 * appended to the step result's detail when the step fails — so the
 * task's planned step count and the verifier/evidence accounting
 * (FR-002/FR-009) do not change.
 *
 * One prepare+retry per step execution, separate from the RetryPolicy
 * (FR-013/FR-014): the wrapper runs at most one prepare sequence, and
 * the recovery policy around it still applies afterwards — a retryable
 * failure after the prepare is reconciled before any further retry, per
 * FR-015, by `executeStepWithRecovery`, never re-clicked blind.
 *
 * The prepare calls are normal tool calls through the registered tools
 * (FR-003): the shield and the linger block apply per call as usual, and
 * they run under the step's own P4 approval — the click/type step already
 * passed the mutation gate, so its prepare moves are part of executing
 * that approved step, exactly like a recovery retry under the same
 * approval. Prepare params are derived from the step's validated params,
 * so they are not re-validated against the prepare tool's schema: the
 * target already passed the step's own schema, and a narrower test
 * schema must not refuse the derived params.
 *
 * Lives apart from `runner.ts` for the same reason `login-gates.ts` and
 * `fail.ts` do: the runner sits exactly on the 600-line maintenance gate
 * (`tests/architecture-maintenance.test.ts`), so the policy lives here
 * and the runner calls it at one hook point — the `invoke` it hands to
 * `executeStepWithRecovery`.
 */
import { ERROR_CODES } from '../core/error-codes.js';
import { errorCodeOf, whereOf } from './recovery.js';
import { resultText } from './verify.js';
import { failureResult } from '../tools/types.js';
import type { ToolDefinition, ToolHost, ToolResult } from '../tools/types.js';
import type { Task, TaskStep } from './types.js';

/** The tools a prepare sequence can recover: a click or a type on an element. */
const PREPARE_TOOLS: ReadonlySet<string> = new Set(['browser_click', 'browser_type']);

/**
 * The failure codes a prepare sequence can fix: the element is covered,
 * hidden, offscreen, or the click landed on something else. Any other
 * code — disabled, invalid, rate-limited — stops at once; scrolling or
 * hovering cannot fix it.
 */
const PREPARE_FAILURE_CODES: ReadonlySet<string> = new Set([
  ERROR_CODES.ELEMENT_COVERED,
  ERROR_CODES.ELEMENT_HIDDEN,
  ERROR_CODES.TARGET_OFFSCREEN,
  ERROR_CODES.CLICK_MISSED,
]);

/**
 * Whether this failure may be prepared: a click/type step whose first
 * attempt failed with a prepare-fixable code. A hover step counts too:
 * it is still a `browser_click` step, and a scroll can uncover the
 * target it failed to hover.
 */
export function isPrepareEligible(tool: string, code: string | undefined): boolean {
  if (code === undefined || !PREPARE_FAILURE_CODES.has(code)) return false;
  if (!PREPARE_TOOLS.has(tool)) return false;
  return true;
}

/** How `withElementPrepare` reaches the prepare tools. */
export interface PrepareDeps {
  /** Tool definitions to resolve the prepare calls against; the registered map in production. */
  tools: ReadonlyMap<string, ToolDefinition>;
  /** The host the prepare handlers run with; injected tools ignore it. */
  host: ToolHost | undefined;
  /** The tab the step ran on, when one is bound — the prepare runs on the same tab. */
  tabId?: number;
}

/** One prepare tool call, as an outcome: a missing tool is a failure, not a throw. */
async function callPrepareTool(
  tools: ReadonlyMap<string, ToolDefinition>,
  host: ToolHost | undefined,
  name: string,
  params: Record<string, unknown>,
): Promise<{ ok: true; text: string } | { ok: false; detail: string }> {
  const def = tools.get(name);
  if (!def) return { ok: false, detail: `${name} is not available` };
  try {
    const result = await def.handler(host as ToolHost, params);
    if (result.isError) return { ok: false, detail: resultText(result) };
    return { ok: true, text: resultText(result) };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Run the prepare sequence for a failed click/type step. Returns whether
 * the original action may be retried, and the notes that describe what
 * the prepare did — the caller records both. With no target there is
 * nothing to scroll or hover, so there is no retry.
 */
async function runPrepare(
  validated: Record<string, unknown>,
  deps: PrepareDeps,
): Promise<{ retry: boolean; notes: string[] }> {
  const target = validated.target;
  if (target === undefined) return { retry: false, notes: ['no target to scroll or hover'] };
  const params: Record<string, unknown> = { target };
  if (deps.tabId !== undefined) params.tabId = deps.tabId;

  const scroll = await callPrepareTool(deps.tools, deps.host, 'browser_scroll', params);
  if (scroll.ok) return { retry: true, notes: ['scroll-into-view ok'] };

  // The scroll failed. Only a hidden element can still be saved: its
  // failure says the element is not displayed, and only a hover can
  // reveal a hover-controlled element — anything else (nothing to move,
  // a refused point target, a missing tool) ends the prepare here.
  const notes = [`scroll-into-view failed: ${scroll.detail}`];
  if (errorCodeOf(scroll.detail) !== ERROR_CODES.ELEMENT_HIDDEN) return { retry: false, notes };

  const hover = await callPrepareTool(deps.tools, deps.host, 'browser_click', { ...params, hover: true });
  if (!hover.ok) {
    notes.push(`hover failed: ${hover.detail}`);
    return { retry: false, notes };
  }
  notes.push('hovered the target');
  const again = await callPrepareTool(deps.tools, deps.host, 'browser_scroll', params);
  if (!again.ok) {
    notes.push(`scroll-into-view after hover failed: ${again.detail}`);
    return { retry: false, notes };
  }
  notes.push('scroll-into-view ok');
  return { retry: true, notes };
}

/**
 * Wrap one step's tool call with the prepare policy, for the `invoke`
 * `executeStepWithRecovery` runs: the first attempt runs as-is; only a
 * prepare-eligible failure runs one prepare sequence and one retry of
 * the original action. Any other failure — and any failure after the
 * prepare — passes through unchanged, so the recovery policy classifies
 * it exactly as it would have without the wrapper. A failure the wrapper
 * returns carries the prepare notes after the operative failure line, so
 * the step's result names what the prepare did; a retry that succeeds
 * leaves the prepare in the task evidence only.
 *
 * The wrapper is built per step execution, so `prepared` allows one
 * sequence per execution: a resumed re-run of the same step gets a fresh
 * wrapper, and a recovery retry that re-invokes the wrapper after the
 * prepare ran calls the action directly, never a second prepare.
 */
export function withElementPrepare(
  task: Task,
  step: TaskStep,
  validated: Record<string, unknown>,
  invoke: () => Promise<ToolResult>,
  deps: PrepareDeps,
): () => Promise<ToolResult> {
  let prepared = false;
  const where = whereOf(task, step);

  return async (): Promise<ToolResult> => {
    let firstResult: ToolResult | undefined;
    let firstError: Error | undefined;
    let firstDetail: string | undefined;
    try {
      firstResult = await invoke();
      if (!firstResult.isError) return firstResult;
      firstDetail = resultText(firstResult);
    } catch (error) {
      firstError = error instanceof Error ? error : new Error(String(error));
      firstDetail = firstError.message;
    }

    if (prepared || !isPrepareEligible(step.tool, errorCodeOf(firstDetail))) {
      if (firstError) throw firstError;
      return firstResult!;
    }
    prepared = true;

    const { retry, notes } = await runPrepare(validated, deps);
    if (!retry) {
      task.evidence.push(`prepare ${where}: first attempt failed ${firstDetail}; ${notes.join('; ')}; no retry`);
      const augmented = `${firstDetail} — prepare: ${notes.join('; ')}`;
      if (firstError) throw new Error(augmented, { cause: firstError });
      return failureResult(augmented);
    }

    try {
      const retryResult = await invoke();
      if (!retryResult.isError) {
        task.evidence.push(`prepare ${where}: first attempt failed ${firstDetail}; ${notes.join('; ')}; retry succeeded`);
        return retryResult;
      }
      const retryDetail = resultText(retryResult);
      task.evidence.push(`prepare ${where}: first attempt failed ${firstDetail}; ${notes.join('; ')}; retry failed ${retryDetail}`);
      return failureResult(`${retryDetail} — prepare: ${notes.join('; ')}`);
    } catch (error) {
      const retryError = error instanceof Error ? error : new Error(String(error));
      const retryDetail = retryError.message;
      task.evidence.push(`prepare ${where}: first attempt failed ${firstDetail}; ${notes.join('; ')}; retry failed ${retryDetail}`);
      throw new Error(`${retryDetail} — prepare: ${notes.join('; ')}`, { cause: error });
    }
  };
}
