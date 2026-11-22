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
 * tool is available (a test map without one, or no host to call it with),
 * the step's own result stands in as the snapshot. The snapshot read is
 * an extra `browser_snapshot` call after most steps; that is the cost of
 * verifying against the page instead of the tool result. A snapshot that
 * cannot be read fails the step as `verify-failed` — verification must
 * never pass on an unread page.
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
 * step's params, so a resumed run rebinds to it from the completed steps
 * instead of losing it. A step that still has no tab to bind to fails
 * validation with the evidence, never executes silently.
 *
 * Read-only default (FR-020, binding ruling P4): a step that can change site
 * data (save/send/delete) is refused unless the task explicitly allows
 * mutations. What counts as mutating is a per-tool, per-action
 * classification in `isMutatingTool` — NOT the retry-safety `idempotent`
 * flag, which only says whether re-running the tool is safe. A refused step
 * fails the task with the refusal in its evidence; it never executes
 * silently.
 */
import { toolMap } from '../tools/registry.js';
import type { ToolDefinition, ToolHost, ToolResult } from '../tools/types.js';
import { rawResultOf } from '../tools/types.js';
import { NO_DEFAULT_TAB, TAB_OR_ORIGIN } from '../tools/batch-limits.js';
import { prepareToolParams } from '../tools/params.js';
import { loadTask, saveTask } from './store.js';
import type { Task, TaskStep } from './types.js';
import type { PageSnapshot, VerifyOutcome } from './verify.js';
import { pageSnapshotFromResult, verifyStep } from './verify.js';

/** Verify one step against the page snapshot taken after it. */
export type VerifyStepFn = (step: TaskStep, snapshot: PageSnapshot) => VerifyOutcome | Promise<VerifyOutcome>;

export interface RunTaskOptions {
  tasksDir?: string;
  host?: ToolHost;
  /** Tool definitions to resolve steps against; defaults to the registry's `toolMap`. */
  tools?: ReadonlyMap<string, ToolDefinition>;
  /** Verifier to apply after each step; defaults to `verifyStep`. */
  verify?: VerifyStepFn;
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

/** Whether the task carries explicit approval for mutating steps. */
export function taskAllowsMutations(task: Task): boolean {
  return task.constraints.includes(ALLOW_MUTATIONS);
}

function resultText(result: ToolResult): string {
  const first = result.content.find((item) => item.type === 'text');
  return first && first.type === 'text' ? first.text : '';
}

/**
 * The page snapshot to verify a step against. A `browser_snapshot` step
 * already read the page, so its own result is the snapshot. Any other step
 * is followed by a fresh `browser_snapshot` read on the tab it acted on —
 * the read is a plain handler call, not a step, so it needs no P4 approval
 * (the snapshot tool is an idempotent read) and no param preparation beyond
 * the tab to read. When no snapshot tool or no host is available, the
 * step's own result stands in. Throws when the snapshot read fails, so the
 * caller fails the step as `verify-failed` instead of passing it unread.
 */
async function readSnapshotAfterStep(
  step: TaskStep,
  result: ToolResult,
  tools: ReadonlyMap<string, ToolDefinition>,
  host: ToolHost | undefined,
  tabId: number | undefined,
): Promise<PageSnapshot> {
  if (step.tool === 'browser_snapshot') return pageSnapshotFromResult(result, 'browser_snapshot result');
  const snapshotDef = tools.get('browser_snapshot');
  if (snapshotDef && host) {
    const params: Record<string, unknown> = {};
    if (tabId !== undefined && 'tabId' in snapshotDef.inputSchema.shape) params.tabId = tabId;
    let snapshotResult: ToolResult;
    try {
      snapshotResult = await snapshotDef.handler(host, params);
    } catch (error) {
      throw new Error(
        `snapshot unavailable after ${step.tool}: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
    if (snapshotResult.isError) {
      throw new Error(`snapshot unavailable after ${step.tool}: ${resultText(snapshotResult)}`);
    }
    return pageSnapshotFromResult(snapshotResult, `browser_snapshot${tabId !== undefined ? ` tab ${tabId}` : ''}`);
  }
  return pageSnapshotFromResult(result, `result of ${step.tool}`);
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

/** The tab the completed steps already bound, if any — the resume rebind. */
function boundTabFromCompletedSteps(task: Task): number | undefined {
  let bound: number | undefined;
  for (const step of task.steps) {
    if (step.result?.status !== 'ok') continue;
    if (typeof step.params.tabId === 'number') bound = step.params.tabId;
  }
  return bound;
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
 * that did not. Throws when the task was never saved.
 */
export async function runTask(id: string, options: RunTaskOptions = {}): Promise<Task> {
  const tools = options.tools ?? toolMap;
  const verify = options.verify ?? verifyStep;
  const hostRequired = options.tools === undefined;

  const task = await loadTask(id, options.tasksDir);
  if (!task) throw new Error(`task not found: ${id}`);

  task.state = 'running';
  await saveTask(task, options.tasksDir);

  // The tab the completed steps already bound (a resumed run rebinds to it).
  let boundTabId = boundTabFromCompletedSteps(task);

  for (let index = 0; index < task.steps.length; index++) {
    const step = task.steps[index];
    // Resume: a step that already verified keeps its result and never re-runs.
    if (step.result?.status === 'ok') continue;

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

    if (isMutatingTool(def, validated) && !taskAllowsMutations(task)) {
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

    let result: ToolResult;
    try {
      // Registry tools need the host (checked above); injected tools ignore it.
      result = await def.handler(options.host as ToolHost, validated);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      await failStep(task, step, index, 'failed', detail, options.tasksDir);
      return task;
    }
    if (result.isError) {
      await failStep(task, step, index, 'failed', resultText(result), options.tasksDir);
      return task;
    }

    // The tab this step acted on, so the verification snapshot reads the
    // same tab — and the binding is recorded on the step if it opened one.
    let openedTabId: number | undefined;
    if (step.params.tabId === undefined) {
      openedTabId = tabIdFromResult(result);
      if (openedTabId !== undefined) boundTabId = openedTabId;
    }

    let outcome: VerifyOutcome;
    try {
      const snapshot = await readSnapshotAfterStep(step, result, tools, options.host, boundTabId);
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
