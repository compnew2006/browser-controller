/**
 * The daemon → popup task list (specs/011-professional-browsing-layer, FR-018;
 * docs/superpowers/plans/2026-11-22-professional-browsing-layer-endpoint-followup.md).
 *
 * The task files under the local tasks dir are already the source of truth,
 * so there is no new wire action and no new task field: on each push the
 * daemon re-reads them with `listTasks` plus the per-task report (the
 * `report` already persisted on each settled/paused record by
 * `saveTaskWithReport`) and sends the result down the existing
 * daemon↔extension channel as the `taskStatus` control message, via
 * `bridge.sendControl` on the same channel as `taskQuestion`.
 *
 * Pushes happen ONLY on pause, resume, settle, and (re)connect — never by
 * polling the task files. The MCP process does NOT notify the daemon: the
 * daemon re-reads at the moments it can observe — the question wire action
 * (pause), the lock-release wire action (an MCP-side run ending, i.e. a
 * pause or a settle), the daemon-side answer continuation (resume, and the
 * settle of the run it backgrounds), and an extension (re)connect (the
 * pending-questions provider in `daemon-bridge.ts` pushes the list too —
 * it runs in the bridge's markExtensionReady on every (re)connect, so no
 * second bridge hook was added: bridge.ts sits at the 600-line gate).
 * `browser_task_cancel` saves its failed record without a run ending, so
 * it has no daemon-visible moment of its own and appears at the next push.
 *
 * Visibility: the popup shows ALL tasks in the local tasks dir,
 * most-recent-first (by task file mtime — the last save is the last
 * pause/resume/settle — since task ids are random UUIDs and carry no
 * order), capped at 20, regardless of `sessionId`. `sessionId` stays on
 * the task record for choosing the daemon-side resume host, not for
 * filtering this list.
 *
 * A push never throws: a read failure is logged and the push is skipped,
 * so a stale task list can never break a question delivery or an answer
 * ack that shares the call path.
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import { defaultTasksDir, listTasks } from './store.js';
import type { TaskState } from './types.js';
import type { EvidenceReport } from './evidence.js';
import { createLogger } from '../core/logger.js';

const log = createLogger('TaskStatus');

/** The popup shows at most this many tasks, most-recent-first. */
export const TASK_STATUS_MAX_TASKS = 20;

/** One step as the popup shows it: the same per-step status `browser_task_status` returns. */
export interface TaskStatusStep {
  step: number;
  tool: string;
  status: string;
}

/** One task as the popup shows it: state, goal, steps, and the settled report when one exists. */
export interface TaskStatusEntry {
  id: string;
  goal: string;
  state: TaskState;
  steps: TaskStatusStep[];
  report?: { text: string; json: EvidenceReport };
}

/** The bridge's control channel, structurally — this module never imports the bridge itself. */
export interface TaskStatusBridge {
  sendControl(type: string, payload?: Record<string, unknown>): void;
}

/** Every saved task as a popup entry, most-recent-first, capped at 20. */
export async function buildTaskStatus(tasksDir: string = defaultTasksDir()): Promise<TaskStatusEntry[]> {
  let tasks;
  try {
    tasks = await listTasks(tasksDir);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    log.warn(`task list could not be read from ${tasksDir}: ${detail}`);
    return [];
  }
  // Most-recent-first is file mtime: every pause/resume/settle saves the
  // record, so the newest file is the task the user last heard about.
  const stamped = await Promise.all(
    tasks.map(async (task) => {
      let mtimeMs = 0;
      try {
        mtimeMs = (await fsp.stat(path.join(tasksDir, `${task.id}.json`))).mtimeMs;
      } catch {
        // A task whose file vanished mid-list sorts last; it is still listed.
      }
      return { task, mtimeMs };
    }),
  );
  stamped.sort((a, b) => b.mtimeMs - a.mtimeMs || (a.task.id < b.task.id ? 1 : a.task.id > b.task.id ? -1 : 0));
  return stamped.slice(0, TASK_STATUS_MAX_TASKS).map(({ task }) => ({
    id: task.id,
    goal: task.goal,
    state: task.state,
    steps: task.steps.map((step, index) => ({
      step: index + 1,
      tool: step.tool,
      status: step.result?.status ?? 'not-run',
    })),
    ...(task.report ? { report: task.report } : {}),
  }));
}

/** Re-read the task files and send the list down the daemon↔extension channel. Never throws. */
export async function pushTaskStatus(bridge: TaskStatusBridge, tasksDir?: string): Promise<void> {
  try {
    const tasks = await buildTaskStatus(tasksDir);
    bridge.sendControl('taskStatus', { tasks });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    log.warn(`taskStatus push failed: ${detail}`);
  }
}
