/**
 * Recording a failure on the task record.
 *
 * Moved out of `runner.ts`: the runner sits exactly on the 600-line
 * maintenance gate (`tests/architecture-maintenance.test.ts`), so the
 * failure recorders live here and the runner imports them. The rules are
 * unchanged from where they lived.
 *
 * Two recorders, and the difference between them is the point:
 * - `failStep` fails one step: the step's result becomes `failed` (or
 *   `verify-failed`) with the detail, the task fails with the same detail
 *   as evidence, and the record is saved. That is the right shape when
 *   the step itself is what failed — an unknown tool, a refused mutation,
 *   a failed verification.
 * - `failTask` fails the whole task without touching any step's result:
 *   the state becomes `failed` with the detail as evidence, and the
 *   record is saved. That is the right shape when no single step is the
 *   failure — the login check (`login-gates.ts`) fails after the fill
 *   already ran `ok`, so rewriting the fill's result as a failure would
 *   claim the fill never happened.
 *
 * Both saves go through `saveTaskUnlessCancelled`: a cancel landing from
 * another process throws `TaskCancelledExternally` instead of letting the
 * failure overwrite the cancellation.
 */
import { saveTaskUnlessCancelled } from './cancel-guard.js';
import type { Task, TaskStep } from './types.js';

/** Fail one step (and so the task) with the detail as evidence, and save the record. */
export async function failStep(
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
  await saveTaskUnlessCancelled(task, tasksDir);
}

/**
 * Fail the whole task without rewriting any step's result: the login
 * check fails after the fill already ran `ok`, so no single step is the
 * failure — the task is, and the fill's recorded outcome stays honest.
 */
export async function failTask(task: Task, detail: string, tasksDir?: string): Promise<void> {
  task.state = 'failed';
  task.evidence.push(`failed: ${detail}`);
  await saveTaskUnlessCancelled(task, tasksDir);
}
