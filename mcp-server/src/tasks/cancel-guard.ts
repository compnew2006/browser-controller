/**
 * The cross-process cancel guard (Task 8, fix round 1).
 *
 * The product runs in two processes — the MCP process owns the
 * `browser_task_*` tools, the daemon owns the bridge — and each keeps
 * its own in-flight set (`runningTasks`, `wiring.ts`), so a cancel
 * from one process cannot refuse a run in flight in the other. The
 * first version reconciled only after the run finished
 * (`runTaskWithReport`): that covers a cancel landing between the
 * runner's final save and the wrapper's load, and nothing else — the
 * runner saves after every step, so a cancel landing mid-run was
 * overwritten by the next step save and the task continued, even
 * though the cancel had returned success.
 *
 * The guard makes the cancel durable instead: every save in the run
 * goes through `saveTaskUnlessCancelled`, which re-reads the stored
 * record first. A stored cancel marker (`Task.cancelled`, set only by
 * `browser_task_cancel` alongside the `failed` state and the
 * cancellation evidence) aborts the run at that save — the save never
 * happens, no further step executes, and the run returns the stored
 * cancelled record. The check is the marker, not the stored state:
 * the run fails tasks itself, so a stored `failed` alone cannot tell
 * the run's own failure from a cancel from outside; the marker is the
 * cancel's own signal. The marker is cleaned up when the run's
 * wrapper saves the terminal record (`runTaskWithReport`), so the
 * stored record keeps the cancellation as evidence and state, not as
 * a live signal.
 *
 * A stored record that cannot be read is no cancellation evidence:
 * the save goes ahead as before, and the wrapper's post-run
 * reconciliation still covers the window between the final save and
 * its own load.
 */
import { loadTask, saveTask } from './store.js';
import type { Task } from './types.js';

/**
 * Raised when a save finds the task was cancelled by another process
 * while this run was in flight. Carries the stored (cancelled) record,
 * so the caller returns the cancellation instead of the run's own
 * outcome.
 */
export class TaskCancelledExternally extends Error {
  readonly stored: Task;
  constructor(stored: Task) {
    super(`task ${stored.id} was cancelled by another process while this run was in flight`);
    this.name = 'TaskCancelledExternally';
    this.stored = stored;
  }
}

/**
 * Re-read the stored record and abort when it carries the cancel marker:
 * another process cancelled the task while this path was in flight. A
 * stored record that cannot be read is no cancellation evidence. This is
 * the re-check `saveTaskUnlessCancelled` runs, exposed on its own for
 * saves that build something first — `saveTaskWithReportUnlessCancelled`
 * (`reporting.ts`) runs it before attaching the report.
 */
export async function assertNotCancelled(id: string, tasksDir?: string): Promise<void> {
  let stored: Task | null = null;
  try {
    stored = await loadTask(id, tasksDir);
  } catch {
    // The stored record cannot be read: no cancellation to honour, so
    // the save goes ahead as before.
  }
  if (stored?.cancelled === true) throw new TaskCancelledExternally(stored);
}

/**
 * Save the task unless another process cancelled it while this run was
 * in flight: re-read the stored record first, and abort (throw) when
 * it carries the cancel marker instead of overwriting it.
 */
export async function saveTaskUnlessCancelled(task: Task, tasksDir?: string): Promise<void> {
  await assertNotCancelled(task.id, tasksDir);
  await saveTask(task, tasksDir);
}
