/**
 * The recovery policy (specs/011-professional-browsing-layer, Design §6).
 *
 * Two questions, answered in this order, before anything is retried:
 * - May this failure be retried at all? `shouldRetry` answers from the
 *   error code and the attempt number: only the transient codes retry, and
 *   only inside the attempt budget. A rate limit, a permission denial, or
 *   a locked tab stops immediately — retrying those cannot help and, for a
 *   rate limit, actively harms.
 * - Did the action actually happen? `reconcileUnknown` answers for the
 *   failure with no answer at all — an action was sent but no reply
 *   arrived. It re-reads the page and applies the step's own verify rules
 *   to that fresh read before any retry: confirmed present means the step
 *   is done and must never run again; confirmed absent means a retry is
 *   safe; anything inconclusive stays unknown and nothing is retried.
 *   Retrying an unknown outcome blind would execute the action twice.
 *
 * The P2 mapping (Design §6 code → the registered code it surfaces as in
 * `core/error-codes.ts`; the Design names are not registered, so they are
 * never invented as codes — they are aliases into the registry):
 * - `TIMEOUT` → `TIMEOUT` (registered as-is).
 * - `TAB_FROZEN` → `TAB_WEDGED`, the extension's frozen-tab code
 *   (`extension/handlers/navigation.js`: "A frozen page (TAB_WEDGED)
 *   would hold the navigation hostage").
 * - `NETWORK` → `NOT_CONNECTED` (the daemon↔extension link down: "no
 *   extension connected", "browser disconnected") and `NAVIGATION_FAILED`
 *   (`mcp-server/src/tools/navigate.ts`: "network failures are
 *   NAVIGATION_FAILED").
 * - `429` / rate limit → `RATE_LIMITED` (immediate stop, never retried).
 * - permission denial → `VAULT_PERMISSION_DENIED` (immediate stop).
 * - `TAB_LOCKED` → `TAB_LOCKED` (registered as-is; immediate stop).
 * `shouldRetry` accepts both spellings — the Design alias and the
 * registered code — so a caller reasoning in either vocabulary gets the
 * same answer, and `RetryPolicy.retryableCodes` keeps the Design values
 * verbatim.
 *
 * `maxAttempts` counts retries, not attempts in total (controller ruling,
 * fix round 1): the Design §6 policy pairs `maxAttempts: 3` with a
 * 3-entry backoff table, and a policy author writes one backoff per
 * retry — with 3 attempts in total only 2 backoffs would exist, so the
 * third entry is decisive evidence the design intends 3 retries. A
 * policy of 3 therefore runs at most 4 attempts in total: `attempt` is
 * the 1-based count of attempts already made, the first failure is
 * attempt 1, and a retry is allowed while `attempt <= maxAttempts`.
 * `backoffMs[attempt - 1]` is the wait before the next attempt (500ms
 * after the first failure, 1500ms after the second, 4000ms after the
 * third — the wait before the fourth attempt).
 *
 * A coded retryable failure on a mutating step is an unknown outcome,
 * not a known failure: the action may have executed and only its reply
 * was lost, so it is reconciled before any retry — exactly like an
 * uncoded failure — and retries only when reconciliation says
 * `not-happened` (controller ruling, fix round 2). This holds for every
 * retryable code, not just `TIMEOUT`: no per-code "never ran" reasoning
 * survives the evidence. `bridge.ts` `rejectAllPending` rejects an
 * already-sent call as `NOT_CONNECTED` with "it may have run in the
 * page before the browser went away", indistinguishable by code from a
 * call that never connected; and `extension/lib/page-exec.js`
 * `safeExec` races an in-flight `executeScript` — which "can't be
 * aborted" — against a timer that throws `TAB_WEDGED`, so the script
 * may still run to completion after the error, indistinguishable by
 * code from the `assertResponsive` pre-check path where the call
 * genuinely never ran. A retryable failure on a mutating step is an
 * unknown outcome by definition, so reconcile first. A retryable
 * failure on a read-only step retries without reconciling: there is no
 * effect to double. The availability cost is accepted: when the link or
 * tab is down the reconcile read itself fails and the step fails as
 * unknown instead of retrying blind — double execution is the harm to
 * avoid, and the task can be re-run once connectivity returns. For a
 * genuine failed navigation the reconcile read shows the effect absent
 * (`not-happened`) and permits the retry anyway, at the cost of one
 * extra snapshot read.
 *
 * The runner-facing application of the policy lives here too, so the
 * runner stays orchestration: `executeStepWithRecovery` runs one step's
 * tool call with retries and reconciliation, and `reconcileUnknownStep`
 * reconciles a step the resume found `unknown` before it runs again.
 */
import { ERROR_CODES, formatError, isKnownErrorCode, type ErrorCode } from '../core/error-codes.js';
import type { ToolResult } from '../tools/types.js';
import type { Task, TaskStep } from './types.js';
import type { PageSnapshot, VerifyOutcome } from './verify.js';
import { resultText, verifyStep } from './verify.js';

/** The retry policy, with the Design §6 values verbatim. */
export interface RetryPolicy {
  /** Maximum retries — attempts after the first try. The policy runs at most `maxAttempts + 1` attempts in total. */
  maxAttempts: number;
  /** Wait before the next attempt, indexed by the attempt that just failed (1-based). */
  backoffMs: readonly number[];
  /** The failure codes a retry may follow, in the Design's own vocabulary. */
  retryableCodes: readonly string[];
}

/** The Design §6 policy: 3 retries (4 attempts in total), 500ms / 1500ms / 4000ms, transient codes only. */
export const RETRY_POLICY: RetryPolicy = Object.freeze({
  maxAttempts: 3,
  backoffMs: Object.freeze([500, 1500, 4000]),
  retryableCodes: Object.freeze(['TIMEOUT', 'TAB_FROZEN', 'NETWORK']),
});

/**
 * The registered codes the Design's retryable codes surface as. Kept
 * beside the policy so the mapping is one table, not a second vocabulary
 * hidden in a comment (see the module header for the P2 mapping).
 */
const RETRYABLE_REGISTERED: ReadonlySet<ErrorCode> = new Set([
  'TIMEOUT',
  'TAB_WEDGED',
  'NOT_CONNECTED',
  'NAVIGATION_FAILED',
]);

/** The Design aliases that name a retryable failure without being registered codes. */
const RETRYABLE_ALIASES: ReadonlySet<string> = new Set(['TAB_FROZEN', 'NETWORK']);

/** Whether this code — Design alias or registered code — names a retryable failure. */
function isRetryableCode(code: string): boolean {
  return RETRYABLE_ALIASES.has(code) || (RETRYABLE_REGISTERED as ReadonlySet<string>).has(code);
}

/**
 * Whether a failure with this code may be retried after `attempt` attempts
 * already made (1-based). True only for a retryable code inside the retry
 * budget: `maxAttempts` counts retries, so attempts 1 through
 * `maxAttempts` may retry and attempt `maxAttempts + 1` may not. A rate
 * limit, a permission denial, a locked tab, any other definite failure —
 * and any attempt past `maxAttempts` — never retries.
 */
export function shouldRetry(code: string, attempt: number, policy: RetryPolicy = RETRY_POLICY): boolean {
  if (!Number.isSafeInteger(attempt) || attempt < 1 || attempt > policy.maxAttempts) return false;
  return isRetryableCode(code);
}

/**
 * The wait before the next attempt after `attempt` attempts already made
 * (1-based): 500ms after the first failure, 1500ms after the second,
 * 4000ms after the third. Clamped to the table, so an attempt past its
 * end still waits the longest configured backoff instead of failing.
 */
export function backoffForAttempt(attempt: number, policy: RetryPolicy = RETRY_POLICY): number {
  if (policy.backoffMs.length === 0) return 0;
  const index = Math.min(Math.max(attempt - 1, 0), policy.backoffMs.length - 1);
  return policy.backoffMs[index]!;
}

/**
 * The code at the head of a `CODE: message` line, or undefined when the
 * line names no code this policy knows: a registered code, or one of the
 * Design aliases (`TAB_FROZEN`, `NETWORK`, `429`). An uncoded message —
 * a failure with no code at all — is not a coded failure: it is an
 * unknown outcome, and the caller must reconcile it, not classify it.
 */
export function errorCodeOf(text: string): string | undefined {
  const separator = text.indexOf(': ');
  if (separator <= 0) return undefined;
  const head = text.slice(0, separator);
  if (head === 'TAB_FROZEN' || head === 'NETWORK' || head === '429') return head;
  return isKnownErrorCode(head) ? head : undefined;
}

/** What reconciling an unknown outcome found. */
export type ReconcileOutcome = 'confirmed' | 'not-happened' | 'unknown';

/** The result of reconciling one unknown outcome. */
export interface ReconcileResult {
  outcome: ReconcileOutcome;
  /** What was found, in the task's evidence vocabulary. */
  evidence: string;
  /** The URL of the page the re-read saw, when it saw one. */
  url?: string;
}

/** How `reconcileUnknown` re-reads the page and checks the effect. */
export interface ReconcileUnknownOptions {
  /**
   * Re-read the page for the re-check — normally a fresh `browser_snapshot`
   * on the tab the step acted on. Without one there is no re-read, so the
   * outcome stays unknown: reconciling without reading is not reconciling.
   */
  readPage?: () => Promise<PageSnapshot>;
  /**
   * Check the step's effect against the fresh read; the step's own verify
   * rules are the definition of "the effect happened". Defaults to the
   * real verifier.
   */
  verify?: (step: TaskStep, snapshot: PageSnapshot) => VerifyOutcome | Promise<VerifyOutcome>;
}

/** The step's place in its task, for the evidence line. */
function whereOf(task: Task, step: TaskStep): string {
  const index = task.steps.indexOf(step);
  return index >= 0 ? `step ${index + 1} (${step.tool})` : step.tool;
}

/**
 * Whether a failed verification is inconclusive rather than proof the
 * effect is absent: the re-read page itself shows an error, or is empty.
 * The wording is the real verifier's own failure wording for those pages
 * (`verify.ts`), so no second error-phrase table is kept here — an
 * injected verifier that fails for another reason still reads as
 * "effect absent", as its own evidence says.
 */
function isInconclusiveFailure(outcome: VerifyOutcome): boolean {
  return outcome.evidence.includes('page shows an error') || outcome.evidence.includes('page is empty');
}

/**
 * Reconcile an unknown outcome: an action was sent but no reply arrived.
 * Re-reads the page and applies the step's own verify rules to that fresh
 * read, and records the finding on the task's evidence:
 * - `confirmed`: the effect is present — the step is marked `ok` with the
 *   finding as its detail, and must never be re-run.
 * - `not-happened`: the effect is absent on a readable page — the step
 *   keeps its unknown result, and the caller may retry it now that a
 *   retry cannot execute the action twice.
 * - `unknown`: the page could not be re-read, was empty, or shows an
 *   error page — nothing was confirmed either way, the step keeps its
 *   unknown result, and nothing may be retried.
 * The caller persists the task: this function mutates the in-memory task
 * only (one evidence line, and the step's result on `confirmed`).
 */
export async function reconcileUnknown(
  task: Task,
  step: TaskStep,
  options: ReconcileUnknownOptions = {},
): Promise<ReconcileResult> {
  const where = whereOf(task, step);
  const verify = options.verify ?? verifyStep;

  if (!options.readPage) {
    const evidence = formatError(
      ERROR_CODES.OUTCOME_UNKNOWN,
      `cannot reconcile ${where} — no page reader was supplied, so the outcome stays unknown; do not retry`,
    );
    task.evidence.push(`reconciled ${where}: unknown — ${evidence}`);
    return { outcome: 'unknown', evidence };
  }

  let snapshot: PageSnapshot;
  try {
    snapshot = await options.readPage();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const evidence = formatError(
      ERROR_CODES.OUTCOME_UNKNOWN,
      `could not re-read the page to reconcile ${where} — ${detail}; the outcome stays unknown; do not retry`,
    );
    task.evidence.push(`reconciled ${where}: unknown — ${evidence}`);
    return { outcome: 'unknown', evidence };
  }

  if (snapshot.text.trim() === '') {
    const evidence = formatError(
      ERROR_CODES.OUTCOME_UNKNOWN,
      `the re-read page is empty, so ${where} cannot be checked against it; the outcome stays unknown; do not retry`,
    );
    task.evidence.push(`reconciled ${where}: unknown — ${evidence}`);
    return { outcome: 'unknown', evidence, url: snapshot.url };
  }

  const outcome = await verify(step, snapshot);
  if (outcome.ok) {
    const evidence = `reconciled ${where}: confirmed — the effect is present on a fresh read — ${outcome.evidence}; the step will not be re-run`;
    step.result = { status: 'ok', detail: evidence };
    task.evidence.push(evidence);
    return { outcome: 'confirmed', evidence, url: snapshot.url };
  }
  if (isInconclusiveFailure(outcome)) {
    const evidence = formatError(
      ERROR_CODES.OUTCOME_UNKNOWN,
      `the re-read page cannot show whether ${where} happened — ${outcome.evidence}; the outcome stays unknown; do not retry`,
    );
    task.evidence.push(`reconciled ${where}: unknown — ${evidence}`);
    return { outcome: 'unknown', evidence, url: snapshot.url };
  }
  const evidence = `reconciled ${where}: not-happened — the effect is absent on a fresh read — ${outcome.evidence}; safe to retry`;
  task.evidence.push(evidence);
  return { outcome: 'not-happened', evidence, url: snapshot.url };
}

/**
 * The default wait between retries: a real timer.
 */
function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** What executing one step's tool call with the recovery policy returned. */
export type StepAttemptOutcome =
  | { kind: 'result'; result: ToolResult; reconciledUrl?: string }
  | { kind: 'reconciled'; reconciledUrl?: string }
  | { kind: 'failed'; reconciledUrl?: string };

/** How `executeStepWithRecovery` runs one step's tool call. */
export interface ExecuteStepOptions {
  policy?: RetryPolicy;
  /**
   * Whether the step can change site data — the runner's P4 mutating
   * classification (`isMutatingTool`). A coded retryable failure on such
   * a step is reconciled before any retry: the action may have executed
   * and only its reply was lost. A read-only step retries a retryable
   * failure without reconciling, since there is no effect to double.
   */
  mutating: boolean;
  /** Wait between retries; defaults to a real timer. */
  sleep?: (ms: number) => Promise<void>;
  /**
   * Re-read the page to reconcile an unknown outcome; without one the
   * outcome stays unknown and nothing is retried.
   */
  readPage?: () => Promise<PageSnapshot>;
  /**
   * Check the step's effect against the fresh read; defaults to the real
   * verifier.
   */
  verify?: (step: TaskStep, snapshot: PageSnapshot) => VerifyOutcome | Promise<VerifyOutcome>;
  /**
   * Fail the step with this detail. The caller returns the task once this
   * resolves: the failure is already recorded.
   */
  fail: (detail: string) => Promise<void>;
}

/**
 * Execute one step's tool call under the recovery policy, and report what
 * happened: `result` carries the successful tool result; `reconciled`
 * means an unknown outcome — an uncoded failure, or a retryable coded
 * failure on a mutating step — was reconciled and the step's effect
 * confirmed present, so the step is already `ok` and must never run
 * again; `failed`
 * means the step was failed through `fail` (a definite failure, an
 * unreconcilable unknown, or no attempts left). `reconciledUrl` is the
 * page a reconciliation saw, when one ran — the caller uses it as the
 * redirect proof for the next step.
 *
 * Validation and the P4 approval gate are the caller's job and run once,
 * before the first attempt, so a retry runs under the same approval the
 * first attempt had — it neither re-asks for approval nor executes
 * without it — and with the same validated params.
 */
export async function executeStepWithRecovery(
  task: Task,
  step: TaskStep,
  invoke: () => Promise<ToolResult>,
  options: ExecuteStepOptions,
): Promise<StepAttemptOutcome> {
  const policy = options.policy ?? RETRY_POLICY;
  const sleep = options.sleep ?? defaultSleep;
  const verify = options.verify ?? verifyStep;
  let reconciledUrl: string | undefined;

  /**
   * Reconcile before a retry, and report what the retry decision is:
   * `'done'` — the effect is confirmed present, so the step is already
   * `ok` and must never run again; `'failed'` — the outcome stayed
   * unknown, so the step was failed through `fail` and nothing was
   * retried blind; `'not-happened'` — the effect is absent on a readable
   * page, so a retry cannot execute the action twice. The evidence is
   * returned for the caller's message when no retry follows.
   */
  async function reconcileBeforeRetry(): Promise<{
    decision: 'done' | 'failed' | 'not-happened';
    evidence: string;
  }> {
    const reconciliation = await reconcileUnknown(task, step, { readPage: options.readPage, verify });
    if (reconciliation.url !== undefined) reconciledUrl = reconciliation.url;
    if (reconciliation.outcome === 'confirmed') return { decision: 'done', evidence: reconciliation.evidence };
    if (reconciliation.outcome === 'unknown') {
      await options.fail(reconciliation.evidence);
      return { decision: 'failed', evidence: reconciliation.evidence };
    }
    return { decision: 'not-happened', evidence: reconciliation.evidence };
  }

  /**
   * Classify one failed attempt. Returns what happens next: `'retry'`
   * runs the next attempt after the policy backoff; `'done'` means
   * reconciliation confirmed the step; `'failed'` means the step was
   * failed through `fail`. A coded retryable failure retries — except
   * on a mutating step, where it is an unknown outcome (the action may
   * have executed and only its reply was lost) and is reconciled
   * first, like an uncoded failure: no per-code "never ran" reasoning
   * survives the evidence (see the module header), so every retryable
   * code reconciles on a mutating step. Any other coded failure — rate
   * limit, permission denial, locked tab, or any definite failure —
   * stops at once. An uncoded failure has no code to branch on, so its
   * outcome is unknown: it is reconciled before any retry, and only a
   * confirmed-absent effect retries.
   */
  async function classify(
    code: string | undefined,
    detail: string,
    attempt: number,
  ): Promise<'retry' | 'done' | 'failed'> {
    if (code !== undefined) {
      if (shouldRetry(code, attempt, policy)) {
        if (options.mutating) {
          const { decision } = await reconcileBeforeRetry();
          if (decision !== 'not-happened') return decision;
        }
        await sleep(backoffForAttempt(attempt, policy));
        return 'retry';
      }
      await options.fail(detail);
      return 'failed';
    }
    const { decision, evidence } = await reconcileBeforeRetry();
    if (decision === 'done') return 'done';
    if (decision === 'failed') return 'failed';
    // `not-happened`: the effect is absent, so a retry cannot execute the
    // action twice — retry while retries remain.
    if (attempt <= policy.maxAttempts) {
      await sleep(backoffForAttempt(attempt, policy));
      return 'retry';
    }
    await options.fail(`${evidence} — no attempts remain, so the step will not be retried`);
    return 'failed';
  }

  for (let attempt = 1; ; attempt++) {
    let result: ToolResult;
    try {
      result = await invoke();
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const next = await classify(errorCodeOf(detail), detail, attempt);
      if (next === 'failed') return { kind: 'failed', reconciledUrl };
      if (next === 'done') return { kind: 'reconciled', reconciledUrl };
      continue;
    }
    if (result.isError) {
      const detail = resultText(result);
      const next = await classify(errorCodeOf(detail), detail, attempt);
      if (next === 'failed') return { kind: 'failed', reconciledUrl };
      if (next === 'done') return { kind: 'reconciled', reconciledUrl };
      continue;
    }
    return { kind: 'result', result, reconciledUrl };
  }
}

/** How `reconcileUnknownStep` persists the reconciliation. */
export interface ReconcileUnknownStepOptions {
  /** Re-read the page for the re-check; without one the outcome stays unknown. */
  readPage?: () => Promise<PageSnapshot>;
  /** Check the step's effect against the fresh read; defaults to the real verifier. */
  verify?: (step: TaskStep, snapshot: PageSnapshot) => VerifyOutcome | Promise<VerifyOutcome>;
  /** Persist the task after the reconciliation is recorded. */
  save: () => Promise<void>;
  /** Fail the step with this detail. */
  fail: (detail: string) => Promise<void>;
}

/**
 * Reconcile a step the resume found `unknown` — it executed but was never
 * verified — before running it again. Returns the reconciliation outcome
 * and the page it saw, when it saw one. `confirmed` means the step is
 * already `ok` (marked by `reconcileUnknown`) and must never be re-run;
 * `not-happened` means the effect is absent, so the caller may run the
 * step; `unknown` means the step was failed through `fail` and the caller
 * returns the task. Reconciliation is a read: it executes nothing, so it
 * runs before the P4 gate.
 */
export async function reconcileUnknownStep(
  task: Task,
  step: TaskStep,
  options: ReconcileUnknownStepOptions,
): Promise<{ outcome: ReconcileOutcome; url?: string }> {
  const reconciliation = await reconcileUnknown(task, step, {
    readPage: options.readPage,
    verify: options.verify,
  });
  if (reconciliation.outcome === 'confirmed') {
    // `reconcileUnknown` already marked the step ok; persist and move on.
    await options.save();
    return { outcome: 'confirmed', url: reconciliation.url };
  }
  if (reconciliation.outcome === 'unknown') {
    await options.fail(
      `${reconciliation.evidence} — the step will not be re-run without knowing whether it already ran`,
    );
    return { outcome: 'unknown', url: reconciliation.url };
  }
  // `not-happened`: the effect is absent on a readable page, so the step
  // is safe to run; clear the unknown result and fall through to execute
  // it under the same approval the step already had.
  step.result = undefined;
  await options.save();
  return { outcome: 'not-happened', url: reconciliation.url };
}
