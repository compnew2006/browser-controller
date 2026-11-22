/**
 * The save-into-task-record hook for the evidence report (specs/
 * 011-professional-browsing-layer, Design §4; Task 5 handoff, Task 8).
 *
 * `buildEvidenceReport` (Task 5) is the pure builder; this module is the
 * composition that persists its result on the task record. Every settled
 * state gets one: the terminal states (`done` / `failed`) and the pause
 * states (`paused-question` / `paused-login`). The runner itself never
 * calls this — `runner.ts` sits exactly on the 600-line maintenance gate,
 * so the composition wraps it instead (`runTaskWithReport`, `wiring.ts`),
 * and the other terminal/pause paths that save a task themselves
 * (`answerQuestion`'s `no` path, `resumeAfterLogin`'s still-paused
 * returns, `browser_task_cancel`) call `saveTaskWithReport` directly —
 * except `resumeAfterLogin`, whose saves go through
 * `saveTaskWithReportUnlessCancelled` below: a cancel landing between
 * its load and its save must not be overwritten with a fresh report.
 *
 * A report is replaced, never merged: it describes the task as it stands
 * when it settles, so a resume that settles the task again overwrites the
 * earlier report with a fresh build. A task that never settles has no
 * report at all — the field is absent, not empty.
 *
 * Size: a report roughly doubles the stored record (text plus JSON of the
 * same sections), and the store caps a task file at 256 KiB. A task whose
 * record with a report would pass the cap is saved without one instead,
 * with the omission recorded as evidence — a missing report is better
 * than a final save that throws and loses the settled state itself.
 */
import { buildEvidenceReport } from './evidence.js';
import { assertNotCancelled } from './cancel-guard.js';
import { MAX_TASK_BYTES, defaultTasksDir, saveTask } from './store.js';
import type { Task } from './types.js';

/** Build the report for the task as it stands and attach it to the record. */
export function attachEvidenceReport(task: Task): Task {
  task.report = buildEvidenceReport(task);
  return task;
}

/**
 * Attach the report and save the task. When the record with its report
 * would pass the store's size cap, the report is dropped, the omission is
 * recorded as evidence, and the task is saved without it.
 */
export async function saveTaskWithReport(task: Task, tasksDir: string = defaultTasksDir()): Promise<Task> {
  attachEvidenceReport(task);
  if (Buffer.byteLength(`${JSON.stringify(task)}\n`) > MAX_TASK_BYTES) {
    delete task.report;
    task.evidence.push('evidence report omitted: the task record with its report would pass the 256 KiB file limit');
  }
  await saveTask(task, tasksDir);
  return task;
}

/**
 * Attach the report and save the task, unless another process cancelled
 * it while this path was in flight: the re-check (`cancel-guard.ts`)
 * runs before the report is built, so a cancel landing between the
 * caller's load and this save is not overwritten with a fresh report —
 * the throw carries the stored cancelled record instead.
 */
export async function saveTaskWithReportUnlessCancelled(
  task: Task,
  tasksDir: string = defaultTasksDir(),
): Promise<Task> {
  await assertNotCancelled(task.id, tasksDir);
  return saveTaskWithReport(task, tasksDir);
}
