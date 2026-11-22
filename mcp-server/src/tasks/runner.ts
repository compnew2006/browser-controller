/**
 * The sequential task runner (specs/011-professional-browsing-layer, FR-002/FR-003/FR-020).
 *
 * `runTask` loads a task, runs its steps in order through the MCP tools
 * registered in `tools/registry.ts`, and stops at the first failure: a tool
 * error, a failed verification, an unknown tool, a refused mutating step, or
 * a step whose params fail the tool's schema all end the task as `failed`
 * with the evidence recorded, and the next step never runs. Progress is saved
 * after every step, so a paused task resumes from its first unfinished step
 * instead of starting over.
 *
 * Two seams, both explicit:
 * - Verification is the real verifier from `verify.ts`: after a step's tool
 *   call succeeds, the runner reads the page again and applies the step's
 *   verify rules to that snapshot — the tool result alone is never evidence
 *   of success. `runTask` takes an injectable `verify` with the same
 *   `(step, snapshot)` signature for tests; the default is `verifyStep`.
 * - Tool resolution defaults to the registry's `toolMap`; tests pass a small
 *   map of fake tools instead. Registry tools need a `ToolHost` to invoke;
 *   injected tools run with whatever host the caller passes (fakes ignore it).
 *
 * How the runner obtains the snapshot for verification: after a step's tool
 * call succeeds, it reads the page again with `browser_snapshot` on the
 * tab the step acted on — unless the step itself was `browser_snapshot`,
 * in which case its own result already is the snapshot. When no snapshot
 * tool is available, or no host is available to call it with, the step
 * fails as `verify-failed` instead of falling back to its own result: a
 * tool result alone is never evidence of success, so verification must
 * never pass on a page that was never read. The snapshot read is an extra
 * `browser_snapshot` call after most steps; that is the cost of verifying
 * against the page instead of the tool result.
 *
 * Params are validated before a step runs: `prepareToolParams` applies the
 * tool's own schema (plus its `normalize`, for borrowed parameter names), so
 * a step that cannot be executed fails here with an `INVALID_ARGUMENT`
 * detail instead of reaching the handler — or the extension — unvalidated.
 * Validation runs before the P4 gate, because the gate reads the params.
 *
 * Tab binding: several tools require `tabId`, which a plan cannot know up
 * front. The runner keeps the current tab — the tab a step without `tabId`
 * opened, or the first tab a `browser_tabs list` step returned (the
 * session's own tab, else the user's focused tab) — and injects it into a
 * later step that takes `tabId` and names none, mirroring the default-tab
 * logic in `tools/batch.ts`. The tab a step acted on is recorded on that
 * step's params, so a resumed run rebinds to it instead of losing it. A
 * step that still has no tab to bind to fails validation with the
 * evidence, never executes silently.
 *
 * Session check (Design §2): after each step's snapshot read, and before
 * its verification, the runner asks the session agent what page the task is
 * on. A landing on a login URL the task did not mean to be on is an expiry:
 * the task pauses in `paused-login` at that step — the step is recorded
 * `unknown`, so the resume reconciles it (re-reads the page and confirms
 * whether its effect happened) before re-running it — and the user
 * completes login by takeover; the task is not failed. A security-warning
 * page fails the step as `verify-failed`: it is never a login page and never
 * a successful target page, and it has to be dismissed explicitly first. A
 * login page without redirect proof is not an expiry, so verification
 * judges it. The redirect proof for a non-navigate step is the page the
 * task was on before the step, seeded at run start from the completed
 * steps (last navigate target, else the URL the last completed step
 * verified against), so a resumed run still proves expiry on its first
 * unfinished step. Re-checking the page before continuing is
 * `resumeAfterLogin`'s job in `session.ts`, not this runner's: `runTask`
 * refuses a `paused-login` task outright and directs the caller there —
 * the single resume entry point — instead of executing a step blind on
 * whatever page is showing.
 *
 * Recovery (Design §6, `recovery.ts`): retryable failures retry inside
 * the policy's attempt budget under the first attempt's approval, and an
 * unknown outcome is reconciled before any retry — so a paused-then-
 * resumed mutating step is never executed twice blind.
 *
 * Read-only default (FR-020, binding ruling P4): a step that can change site
 * data (save/send/delete) is refused unless the task explicitly allows
 * mutations. What counts as mutating is a per-tool, per-action
 * classification in `isMutatingTool` — NOT the retry-safety `idempotent`
 * flag, which only says whether re-running the tool is safe. A refused step
 * fails the task with the refusal in its evidence; it never executes
 * silently. There are two approval paths: the `allow-mutations` constraint,
 * and — when the caller wires `options.questions.ask` — a mutation-approval
 * question (Design §5): the runner pauses in `paused-question` and asks the
 * user whether to allow this mutation; a `yes` records a per-step approval
 * and the resume continues from the same step, a `no` fails the task with
 * the refusal as evidence. The question path adds an approval route; it
 * never weakens the gate — without a wired ask, the refusal stands.
 */
import { toolMap } from '../tools/registry.js';
import type { ToolDefinition, ToolHost, ToolResult } from '../tools/types.js';
import { rawResultOf } from '../tools/types.js';
import { NO_DEFAULT_TAB, TAB_OR_ORIGIN } from '../tools/batch-limits.js';
import { prepareToolParams } from '../tools/params.js';
import { loadTask, saveTask } from './store.js';
import type { Task, TaskStep } from './types.js';
import type { PageSnapshot, VerifyOutcome } from './verify.js';
import { readFreshSnapshot, readSnapshotAfterStep, verifyStep } from './verify.js';
import type { DetectSessionFn, SessionPage, SessionState } from './session.js';
import { detectSession, originOf, pauseForLogin } from './session.js';
import type { Question, QuestionContext, QuestionKind } from './questions.js';
import { mutationApprovalConstraint } from './questions.js';
import type { RetryPolicy } from './recovery.js';
import { executeStepWithRecovery, reconcileUnknownStep } from './recovery.js';
import { ERROR_CODES, formatError } from '../core/error-codes.js';

/** Verify one step against the page snapshot taken after it. */
export type VerifyStepFn = (step: TaskStep, snapshot: PageSnapshot) => VerifyOutcome | Promise<VerifyOutcome>;

/** Ask the user a question, pausing the task in `paused-question` — the question protocol (`questions.ts`). */
export type AskQuestionFn = (input: {
  taskId: string;
  text: string;
  options?: string[];
  kind: QuestionKind;
  context?: QuestionContext;
}) => Promise<Question>;

export interface RunTaskOptions {
  tasksDir?: string;
  host?: ToolHost;
  /** Tool definitions to resolve steps against; defaults to the registry's `toolMap`. */
  tools?: ReadonlyMap<string, ToolDefinition>;
  /** Verifier to apply after each step; defaults to `verifyStep`. */
  verify?: VerifyStepFn;
  /**
   * The human question protocol (Design §5): when a mutating step lacks
   * approval and an ask is wired, the runner pauses in `paused-question`
   * and asks the user whether to allow this mutation instead of failing
   * outright. Without one the step is refused and the task fails, as
   * before — the question path adds an approval route, it never weakens
   * the gate.
   */
  questions?: {
    ask?: AskQuestionFn;
  };
  /**
   * Session checking (Design §2): after each step's snapshot read, the
   * runner asks the session agent what page the task is on. `profile` is
   * the browser profile the task runs in; `knownLoginUrls` is the caller's
   * per-(profile, origin) slice of site knowledge (008). `detectSession`
   * is injectable for tests; the default is the real `detectSession`.
   */
  session?: {
    profile?: string;
    knownLoginUrls?: readonly string[];
    detectSession?: DetectSessionFn;
  };
  /**
   * The recovery policy (Design §6, `recovery.ts`): retryable failures
   * retry inside the attempt budget; an unknown outcome is reconciled
   * before any retry. `readPage` re-reads the page for reconciliation
   * (default: a fresh `browser_snapshot` on the bound tab); `sleep`
   * waits between retries (default: a real timer); `policy` overrides
   * the Design values (tests only).
   */
  recovery?: {
    policy?: RetryPolicy;
    readPage?: () => Promise<PageSnapshot>;
    sleep?: (ms: number) => Promise<void>;
  };
}

/** The constraint that explicitly approves mutating steps in a task (FR-020). */
export const ALLOW_MUTATIONS = 'allow-mutations';

/** `browser_navigate` forms that move history or reload instead of opening a URL. */
const NAVIGATE_HISTORY_ACTIONS = new Set(['back', 'forward', 'reload']);

/**
 * Whether a plain-URL `browser_navigate` is the only read form: it changes
 * the viewed page, not site data, so a read-only audit task may navigate.
 * History moves and reloads can resubmit or revisit, and `incognito:true`
 * opens a new private window, so those are mutating and need approval.
 */
function isMutatingNavigate(params: Record<string, unknown>): boolean {
  if (params.incognito === true) return true;
  return typeof params.url === 'string' && NAVIGATE_HISTORY_ACTIONS.has(params.url);
}

/**
 * Whether a `browser_tabs` call changes anything: closing a tab, selecting
 * a browser profile, or setting session policy does. Listing, listing
 * profiles, focusing a tab (a view change, like navigating), and reading the
 * session policy do not.
 */
function isMutatingTabs(params: Record<string, unknown>): boolean {
  if (params.action === 'close') return true;
  if (params.browser !== undefined) return true;
  if (params.action === 'session' && (params.isolation !== undefined || params.access !== undefined)) return true;
  return false;
}

/**
 * Whether running this tool with these params can change site data
 * (save/send/delete) — the FR-020 question — and so needs explicit approval.
 *
 * The classification is per tool and, for the mixed tools, per action; it is
 * deliberately NOT derived from `idempotent`, which documents retry-safety
 * ("re-running this tool with the same params has no side effects") rather
 * than mutation. A tool that only reads is `idempotent: true` and so is
 * never mutating here; a non-idempotent tool is mutating unless one of the
 * mixed-tool rules below says its form is a read. Anything not listed is
 * mutating: the gate fails closed on tools it does not know.
 */
export function isMutatingTool(def: ToolDefinition, params: Record<string, unknown> = {}): boolean {
  if (def.idempotent === true) return false;
  switch (def.name) {
    case 'browser_navigate':
      return isMutatingNavigate(params);
    case 'browser_logs':
      // `clear:true` empties the log buffer; reading the logs does not.
      return params.clear === true;
    case 'browser_tabs':
      return isMutatingTabs(params);
    default:
      return true;
  }
}

/**
 * Whether the task carries explicit approval for mutating steps: the
 * blanket `allow-mutations` constraint, or a per-step approval recorded by
 * a `yes` answer to a mutation-approval question
 * (`mutationApprovalConstraint`, `questions.ts`) — that step only.
 */
export function taskAllowsMutations(task: Task, stepIndex?: number): boolean {
  if (task.constraints.includes(ALLOW_MUTATIONS)) return true;
  return stepIndex !== undefined && task.constraints.includes(mutationApprovalConstraint(stepIndex));
}

/**
 * The tab a step's result names, if any: the `tabId` a navigate/snapshot
 * result carries, or the first tab of a `browser_tabs list` result — the
 * session's own tab, else the user's focused tab
 * (`extension/handlers/tabs.js`, `listTabs`).
 */
function tabIdFromResult(result: ToolResult): number | undefined {
  const raw = rawResultOf(result);
  if (!raw) return undefined;
  if (typeof raw.tabId === 'number') return raw.tabId;
  const tabs = raw.tabs;
  if (Array.isArray(tabs)) {
    for (const entry of tabs) {
      if (entry && typeof entry === 'object' && typeof (entry as Record<string, unknown>).tabId === 'number') {
        return (entry as Record<string, unknown>).tabId as number;
      }
    }
  }
  return undefined;
}

/** The tab the completed steps already bound, if any — the resume rebind. A step recorded `unknown` executed too, so its tab counts: it is the tab the resume must reconcile — and re-run — on. */
function boundTabFromCompletedSteps(task: Task): number | undefined {
  let bound: number | undefined;
  for (const step of task.steps) {
    if (step.result?.status !== 'ok' && step.result?.status !== 'unknown') continue;
    if (typeof step.params.tabId === 'number') bound = step.params.tabId;
  }
  return bound;
}

/** The URL of the page a completed step verified against, from its recorded evidence (`verifyStep` writes `verified N rule(s) at <url>; ...`). */
const VERIFIED_URL = /verified \d+ rule\(s\) at (\S+); snapshot=/u;

function verifiedUrlOf(step: TaskStep): string | undefined {
  if (step.result?.status !== 'ok' || !step.result.detail) return undefined;
  return VERIFIED_URL.exec(step.result.detail)?.[1];
}

/**
 * The page the task was on when its last completed step finished — the
 * redirect proof for the first unfinished step. A resumed run skips `ok`
 * steps without running them, so without this the first unfinished step —
 * a snapshot, a click, anything but a navigate — would have no expected URL
 * and a landing on a login URL would read as `login-page`, not `expired`.
 * Prefer the last completed navigate's target; otherwise the URL the last
 * completed step verified against. A history navigate (`back` / `forward` /
 * `reload`) names no URL, so it falls through to the verified URL instead.
 */
function lastUrlFromCompletedSteps(task: Task): string | undefined {
  let last: string | undefined;
  for (const step of task.steps) {
    if (step.result?.status !== 'ok') continue;
    if (
      step.tool === 'browser_navigate' &&
      typeof step.params.url === 'string' &&
      !NAVIGATE_HISTORY_ACTIONS.has(step.params.url)
    ) {
      last = step.params.url;
    } else {
      last = verifiedUrlOf(step) ?? last;
    }
  }
  return last;
}

async function failStep(
  task: Task,
  step: TaskStep,
  index: number,
  status: 'failed' | 'verify-failed',
  detail: string,
  tasksDir?: string,
): Promise<void> {
  step.result = { status, detail };
  task.evidence.push(`step ${index + 1} (${step.tool}): ${status} — ${detail}`);
  task.state = 'failed';
  await saveTask(task, tasksDir);
}

/**
 * Run a saved task from its first unfinished step. Returns the task in its
 * final state: `done` when every step verified, `failed` at the first step
 * that did not. Throws when the task was never saved, and when the task is
 * `paused-login` — that state resumes only through `resumeAfterLogin`,
 * which re-checks the page first.
 */
export async function runTask(id: string, options: RunTaskOptions = {}): Promise<Task> {
  const tools = options.tools ?? toolMap;
  const verify = options.verify ?? verifyStep;
  const hostRequired = options.tools === undefined;

  const task = await loadTask(id, options.tasksDir);
  if (!task) throw new Error(`task not found: ${id}`);

  // A task paused for login resumes only through `resumeAfterLogin`, which
  // re-checks the page first: running it directly would execute the next
  // step blind on whatever page is showing — possibly still the login page.
  if (task.state === 'paused-login') {
    throw new Error(
      `cannot run task ${id} directly: task is paused-login — resume it with resumeAfterLogin, which re-checks the page first`,
    );
  }

  // A task paused for a question resumes only through `answerQuestion`,
  // which records the answer first: running it directly would execute the
  // next step without the answer the task is waiting for — and, for a
  // mutation-approval question, without the approval. Same rule as
  // `paused-login` above, which resumes only through `resumeAfterLogin`.
  if (task.state === 'paused-question') {
    throw new Error(
      `cannot run task ${id} directly: task is paused-question — answer it with answerQuestion, which resumes the task from the same step`,
    );
  }

  task.state = 'running';
  await saveTask(task, options.tasksDir);

  // The tab the completed steps already bound (a resumed run rebinds to it).
  let boundTabId = boundTabFromCompletedSteps(task);

  // The session agent (Design §2): what page the task is on, and where it
  // meant to be. The default is the real detector; tests inject a fake.
  const sessionDetect = options.session?.detectSession ?? detectSession;
  const sessionProfile = options.session?.profile ?? 'default';
  const knownLoginUrls = options.session?.knownLoginUrls ?? [];
  // The page the task was on before the current step — the redirect proof:
  // a landing on a login URL only counts as an expiry when the task meant
  // to be somewhere else. A navigate step's target is that proof instead.
  // Seeded from the completed steps, so a resumed run whose first
  // unfinished step is not a navigate still has a proof to check against.
  let lastUrl: string | undefined = lastUrlFromCompletedSteps(task);

  // The page re-read reconciliation runs against: a fresh snapshot on
  // the tab the task is bound to (or the caller's injected reader).
  const reconcileReadPage =
    options.recovery?.readPage ??
    (() => readFreshSnapshot(tools, options.host, boundTabId, 'to reconcile the step'));

  for (let index = 0; index < task.steps.length; index++) {
    const step = task.steps[index];
    // Resume: a step that already verified keeps its result and never re-runs.
    if (step.result?.status === 'ok') continue;

    // Resume after a pause left this step's outcome unknown: reconcile
    // it (`recovery.ts`) before running it again — never blindly
    // re-execute a step that may already have run (Design §6).
    if (step.result?.status === 'unknown') {
      const resumed = await reconcileUnknownStep(task, step, {
        readPage: reconcileReadPage,
        verify,
        save: () => saveTask(task, options.tasksDir),
        fail: (detail) => failStep(task, step, index, 'failed', detail, options.tasksDir),
      });
      if (resumed.url !== undefined) lastUrl = resumed.url;
      if (resumed.outcome === 'confirmed') continue;
      if (resumed.outcome === 'unknown') return task;
      // `not-happened`: fall through to execute the step.
    }

    const def = tools.get(step.tool);
    if (!def) {
      await failStep(task, step, index, 'failed', `unknown tool: ${step.tool}`, options.tasksDir);
      return task;
    }

    // Bind the current tab into a step that takes tabId and names none.
    // Mirrors the default-tab logic in tools/batch.ts.
    const effectiveParams: Record<string, unknown> = { ...step.params };
    const namesOrigin = TAB_OR_ORIGIN.has(def.name) && effectiveParams.origin !== undefined;
    if (
      boundTabId !== undefined &&
      effectiveParams.tabId === undefined &&
      !NO_DEFAULT_TAB.has(def.name) &&
      !namesOrigin &&
      'tabId' in def.inputSchema.shape
    ) {
      effectiveParams.tabId = boundTabId;
    }

    // Validate against the tool's own schema before anything executes.
    let validated: Record<string, unknown>;
    let notes: string[];
    try {
      const prepared = prepareToolParams(def, effectiveParams);
      validated = prepared.params;
      notes = prepared.notes;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      await failStep(task, step, index, 'failed', detail, options.tasksDir);
      return task;
    }

    if (isMutatingTool(def, validated) && !taskAllowsMutations(task, index)) {
      if (options.questions?.ask) {
        // Second approval path (Design §5): instead of failing outright,
        // ask the user whether to allow this mutation. The question carries
        // the tool and its params so the user can judge; a `yes` records a
        // per-step approval on the task (see `answerQuestion`) and the
        // resume continues from this same step, a `no` fails it with the
        // refusal as evidence. The ask pauses the task — return it paused.
        try {
          await options.questions.ask({
            taskId: id,
            text: `Allow step ${index + 1} (${step.tool}) to change site data? ${JSON.stringify(validated)}`,
            options: ['yes', 'no'],
            kind: 'confirm',
            context: { stepIndex: index, tool: step.tool, params: validated },
          });
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          await failStep(task, step, index, 'failed', detail, options.tasksDir);
          return task;
        }
        const paused = await loadTask(id, options.tasksDir);
        return paused ?? task;
      }
      await failStep(
        task,
        step,
        index,
        'failed',
        `refused: mutating tool ${step.tool} needs explicit approval (add '${ALLOW_MUTATIONS}' to the task constraints)`,
        options.tasksDir,
      );
      return task;
    }
    if (hostRequired && !options.host) {
      await failStep(task, step, index, 'failed', `no tool host available to run ${step.tool}`, options.tasksDir);
      return task;
    }

    // The tool call runs under the recovery policy (`recovery.ts`):
    // attempts share the one validation and the one approval above, so a
    // retry runs under the same approval the first attempt had — it
    // neither re-asks for approval nor executes without it.
    const attempt = await executeStepWithRecovery(
      task,
      step,
      // Registry tools need the host (checked above); injected tools ignore it.
      () => def.handler(options.host as ToolHost, validated),
      {
        policy: options.recovery?.policy,
        sleep: options.recovery?.sleep,
        readPage: reconcileReadPage,
        verify,
        fail: (detail) => failStep(task, step, index, 'failed', detail, options.tasksDir),
      },
    );
    if (attempt.reconciledUrl !== undefined) lastUrl = attempt.reconciledUrl;
    if (attempt.kind === 'failed') return task;
    if (attempt.kind === 'reconciled') {
      // Reconciliation confirmed the step after an uncoded failure: its
      // result is already ok — verification already ran, against the fresh
      // read, inside the reconciliation — so the step is done.
      await saveTask(task, options.tasksDir);
      continue;
    }
    const result = attempt.result;

    // The tab this step acted on, so the verification snapshot reads the
    // same tab — and the binding is recorded on the step if it opened one.
    let openedTabId: number | undefined;
    if (step.params.tabId === undefined) {
      openedTabId = tabIdFromResult(result);
      if (openedTabId !== undefined) boundTabId = openedTabId;
    }

    // The tab to verify against: the tab the step's result names (a tab it
    // opened), else the tab the step ran on — its explicit tabId, or the
    // bound tab injected into it — else the bound tab. The explicit tabId
    // must win over the bound tab.
    const verifyTabId =
      openedTabId ?? (typeof validated.tabId === 'number' ? validated.tabId : boundTabId);

    let outcome: VerifyOutcome;
    let snapshot: PageSnapshot;
    try {
      snapshot = await readSnapshotAfterStep(step, result, tools, options.host, verifyTabId);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      await failStep(task, step, index, 'verify-failed', detail, options.tasksDir);
      return task;
    }

    // Session check, on the same fresh snapshot verification uses — no
    // extra read. Where the task meant to be is the navigate target for a
    // navigate step, else the page it was on before this step.
    const navigateTarget =
      step.tool === 'browser_navigate' &&
      typeof validated.url === 'string' &&
      !NAVIGATE_HISTORY_ACTIONS.has(validated.url)
        ? validated.url
        : undefined;
    const expectedUrl = navigateTarget ?? lastUrl;
    const sessionPage: SessionPage = { ...snapshot, expectedUrl };
    const sessionState: SessionState = sessionDetect(
      sessionProfile,
      originOf(expectedUrl ?? snapshot.url),
      sessionPage,
      knownLoginUrls,
    );
    if (sessionState === 'expired') {
      // The session ended mid-task: the step executed — its tool call
      // returned — but it was never verified, so its outcome is unknown.
      // Record it as unknown, not blank, so the resume reconciles it
      // before re-running it, instead of executing it a second time
      // blind. The tab the step acted on is recorded with it, so the
      // resume reconciles — and re-runs — on that tab. Then pause in
      // `paused-login` and hand the login to the user (takeover).
      if (openedTabId !== undefined && 'tabId' in def.inputSchema.shape) {
        step.params = { ...step.params, tabId: openedTabId };
      }
      step.result = {
        status: 'unknown',
        detail: formatError(
          ERROR_CODES.OUTCOME_UNKNOWN,
          `the step executed but the session expired before verification — the outcome is unknown until the resume reconciles it; url=${snapshot.url}`,
        ),
      };
      task.evidence.push(`step ${index + 1} (${step.tool}): unknown — ${step.result.detail}`);
      await saveTask(task, options.tasksDir);
      return pauseForLogin(id, index, options.tasksDir);
    }
    if (sessionState === 'warning-page') {
      // A security warning is never a login page and never a successful
      // target page: the step fails with the warning as its evidence, and
      // the warning has to be dismissed explicitly before anything continues.
      await failStep(
        task,
        step,
        index,
        'verify-failed',
        `page is a security warning page (warning-page), not the target page — dismiss the warning explicitly before continuing; url=${snapshot.url}`,
        options.tasksDir,
      );
      return task;
    }
    // `login-page` without redirect proof is not an expiry: the step may
    // have meant to be there, so verification judges it. `logged-in` and
    // `unknown` proceed the same way.
    if (snapshot.url !== '') lastUrl = snapshot.url;

    try {
      outcome = await verify(step, snapshot);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      await failStep(task, step, index, 'verify-failed', detail, options.tasksDir);
      return task;
    }
    if (!outcome.ok) {
      await failStep(task, step, index, 'verify-failed', outcome.evidence, options.tasksDir);
      return task;
    }

    if (openedTabId !== undefined && 'tabId' in def.inputSchema.shape) {
      step.params = { ...step.params, tabId: openedTabId };
    }
    const detail = notes.length > 0 ? `${outcome.evidence} (${notes.join('; ')})` : outcome.evidence;
    step.result = { status: 'ok', detail };
    task.evidence.push(`step ${index + 1} (${step.tool}): ok — ${detail}`);
    await saveTask(task, options.tasksDir);
  }

  task.state = 'done';
  await saveTask(task, options.tasksDir);
  return task;
}
