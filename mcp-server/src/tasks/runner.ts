/**
 * The sequential task runner (specs/011-professional-browsing-layer, FR-002/FR-003/FR-020).
 *
 * `runTask` loads a task, runs its steps in order through the MCP tools
 * registered in `tools/registry.ts`, and stops at the first failure: a tool
 * error, a failed verification, an unknown tool, or a refused mutating step
 * all end the task as `failed` with the evidence recorded, and the next step
 * never runs. Progress is saved after every step, so a paused task resumes
 * from its first unfinished step instead of starting over.
 *
 * Two seams, both explicit:
 * - Verification is a TEMPORARY placeholder until Task 3 lands `verify.ts`:
 *   it only rejects a tool result that already carries an error. Task 3
 *   replaces `VerifyStepFn` with `verifyStep(step, snapshot)`.
 * - Tool resolution defaults to the registry's `toolMap`; tests pass a small
 *   map of fake tools instead. Registry tools need a `ToolHost` to invoke;
 *   injected tools run with whatever host the caller passes (fakes ignore it).
 *
 * Read-only default (FR-020, binding ruling P4): a step whose tool is not
 * idempotent is mutating — it can save, send or delete — and the runner
 * refuses it unless the task explicitly allows mutations. Navigation is the
 * one exception: `browser_navigate` changes the viewed page, not site data,
 * so a read-only audit task may navigate. A refused step fails the task with
 * the refusal in its evidence; it never executes silently.
 */
import { toolMap } from '../tools/registry.js';
import type { ToolDefinition, ToolHost, ToolResult } from '../tools/types.js';
import { loadTask, saveTask } from './store.js';
import type { Task, TaskStep } from './types.js';

/** The outcome of verifying one step. Temporary seam — see the header. */
export interface VerifyOutcome {
  ok: boolean;
  evidence: string;
}

/** TEMPORARY: Task 3 replaces this with `verifyStep(step, snapshot)` from verify.ts. */
export type VerifyStepFn = (step: TaskStep, result: ToolResult) => VerifyOutcome | Promise<VerifyOutcome>;

export interface RunTaskOptions {
  tasksDir?: string;
  host?: ToolHost;
  /** Tool definitions to resolve steps against; defaults to the registry's `toolMap`. */
  tools?: ReadonlyMap<string, ToolDefinition>;
  /** Verifier to apply after each step; defaults to the placeholder below. */
  verify?: VerifyStepFn;
}

/** The constraint that explicitly approves mutating steps in a task (FR-020). */
export const ALLOW_MUTATIONS = 'allow-mutations';

/** Tools the runner treats as reads even though the registry marks them non-idempotent. */
const READ_DESPITE_NON_IDEMPOTENT = new Set(['browser_navigate']);

/**
 * Whether a tool can change site data (save/send/delete). Derived from the
 * tool's own `idempotent` flag — the registry's single source of truth —
 * with navigation excepted: it changes the viewed page, not site data.
 */
export function isMutatingTool(def: ToolDefinition): boolean {
  return def.idempotent !== true && !READ_DESPITE_NON_IDEMPOTENT.has(def.name);
}

/** Whether the task carries explicit approval for mutating steps. */
export function taskAllowsMutations(task: Task): boolean {
  return task.constraints.includes(ALLOW_MUTATIONS);
}

/**
 * TEMPORARY verifier (Task 3 replaces it with verify.ts): a step passes when
 * its tool result carries no error. It cannot apply the step's verify rules —
 * those need the page snapshot, which the real verifier reads.
 */
function placeholderVerify(step: TaskStep, result: ToolResult): VerifyOutcome {
  if (result.isError) return { ok: false, evidence: `tool ${step.tool} failed: ${resultText(result)}` };
  return { ok: true, evidence: `tool ${step.tool} returned without error` };
}

function resultText(result: ToolResult): string {
  const first = result.content.find((item) => item.type === 'text');
  return first && first.type === 'text' ? first.text : '';
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
  const verify = options.verify ?? placeholderVerify;
  const hostRequired = options.tools === undefined;

  const task = await loadTask(id, options.tasksDir);
  if (!task) throw new Error(`task not found: ${id}`);

  task.state = 'running';
  await saveTask(task, options.tasksDir);

  for (let index = 0; index < task.steps.length; index++) {
    const step = task.steps[index];
    // Resume: a step that already verified keeps its result and never re-runs.
    if (step.result?.status === 'ok') continue;

    const def = tools.get(step.tool);
    if (!def) {
      await failStep(task, step, index, 'failed', `unknown tool: ${step.tool}`, options.tasksDir);
      return task;
    }
    if (isMutatingTool(def) && !taskAllowsMutations(task)) {
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
      result = await def.handler(options.host as ToolHost, step.params);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      await failStep(task, step, index, 'failed', detail, options.tasksDir);
      return task;
    }
    if (result.isError) {
      await failStep(task, step, index, 'failed', resultText(result), options.tasksDir);
      return task;
    }

    const outcome = await verify(step, result);
    if (!outcome.ok) {
      await failStep(task, step, index, 'verify-failed', outcome.evidence, options.tasksDir);
      return task;
    }
    step.result = { status: 'ok', detail: outcome.evidence };
    task.evidence.push(`step ${index + 1} (${step.tool}): ok — ${outcome.evidence}`);
    await saveTask(task, options.tasksDir);
  }

  task.state = 'done';
  await saveTask(task, options.tasksDir);
  return task;
}
