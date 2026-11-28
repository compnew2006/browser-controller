/**
 * Task-mode agent cursor (Gap D): the runner's side of the override.
 *
 * The runner enables the cursor when a run starts and disables it only when
 * the task settles (`done` / `failed`, including a stored cancellation) — a
 * pause (`paused-question` / `paused-login`) is still a live task with the
 * user watching, so it keeps the cursor. The signal is cosmetic and
 * best-effort: a failed send never fails the run, the task just runs without
 * the cursor. The extension holds the override in memory only (see
 * `extension/lib/task-cursor.js`), so a stale enable is bounded by the
 * service worker's lifetime and the next run re-enables it.
 */
import type { Task } from './types.js';

/** The runner's task-mode cursor signal: enable at run start, disable at settle. */
export type SetTaskCursorFn = (taskId: string, enabled: boolean) => Promise<unknown>;

/** Enable the cursor for a task run; a failed signal is swallowed — the task runs without the cursor rather than failing for it. */
export async function enableTaskCursor(setTaskCursor: SetTaskCursorFn | undefined, taskId: string): Promise<void> {
  if (!setTaskCursor) return;
  try {
    await setTaskCursor(taskId, true);
  } catch {
    // Cosmetic only: the run proceeds, the cursor just stays off.
  }
}

/** Disable the cursor once a task settles. Paused tasks are still live, so they keep it. */
export async function disableTaskCursorIfSettled(
  setTaskCursor: SetTaskCursorFn | undefined,
  task: Task,
): Promise<void> {
  if (task.state !== 'done' && task.state !== 'failed') return;
  if (!setTaskCursor) return;
  try {
    await setTaskCursor(task.id, false);
  } catch {
    // Cosmetic only; a stale enable is bounded by the extension's in-memory override.
  }
}
