/**
 * The latest task list in the extension (specs/011-professional-browsing-layer, FR-018).
 *
 * Pure module — no DOM, no chrome.* — so it is unit-tested in Node
 * (tests/popup-task-panels.test.ts). The router records a `taskStatus`
 * payload the daemon sent over the WebSocket; the popup reads the list
 * through the status payload and renders the Tasks/Evidence panels. The
 * store keeps the last payload across popup reopens in memory only — like
 * the question store, it is rehydrated from the next `getStatus`.
 *
 * One entry per task, most-recent-first, capped at 20 — the daemon sends
 * it that way, and the store keeps the same bound so a stale or
 * hand-built payload cannot grow the panels without limit.
 */

/** The most tasks the popup ever shows, mirroring the daemon's cap. */
export const TASK_STATUS_MAX_TASKS = 20;

const TASK_STATES = new Set(['planned', 'running', 'paused-question', 'paused-login', 'done', 'failed']);
const STEP_STATUSES = new Set(['ok', 'failed', 'verify-failed', 'unknown', 'not-run']);

/** The latest task list, keyed by task id, in payload (most-recent-first) order. */
const tasksById = new Map();

/** Whether a value is one step of a taskStatus entry: number, tool name, known status. */
export function isTaskStatusStep(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  if (typeof value.step !== 'number' || !Number.isSafeInteger(value.step) || value.step < 1) return false;
  if (typeof value.tool !== 'string' || value.tool === '') return false;
  if (typeof value.status !== 'string' || !STEP_STATUSES.has(value.status)) return false;
  return true;
}

/** Whether a value is a taskStatus entry: id, goal, known state, steps, and an optional report. */
export function isTaskStatusEntry(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  if (typeof value.id !== 'string' || value.id === '') return false;
  if (typeof value.goal !== 'string' || value.goal === '') return false;
  if (typeof value.state !== 'string' || !TASK_STATES.has(value.state)) return false;
  if (!Array.isArray(value.steps) || !value.steps.every(isTaskStatusStep)) return false;
  if (value.report !== undefined) {
    if (!value.report || typeof value.report !== 'object' || Array.isArray(value.report)) return false;
    if (typeof value.report.text !== 'string') return false;
    if (value.report.json !== undefined && (typeof value.report.json !== 'object' || value.report.json === null)) return false;
  }
  return true;
}

/** Whether a daemon WebSocket message is a task list to record. */
export function isTaskStatusMessage(msg) {
  return !!msg && msg.type === 'taskStatus' && Array.isArray(msg.tasks) && msg.tasks.every(isTaskStatusEntry);
}

/**
 * Record the latest task list, replacing the previous one. An entry that
 * fails validation is dropped, not recorded — one bad entry must not blank
 * the panels — and a non-list is refused outright.
 */
export function recordTaskStatus(tasks) {
  if (!Array.isArray(tasks)) return false;
  tasksById.clear();
  for (const task of tasks.slice(0, TASK_STATUS_MAX_TASKS)) {
    if (isTaskStatusEntry(task)) tasksById.set(task.id, task);
  }
  return true;
}

/** Every recorded task, most-recent-first. */
export function taskStatusList() {
  return [...tasksById.values()];
}

/** Drop the recorded list (tests; a daemon restart pushes it again). */
export function clearTaskStatus() {
  tasksById.clear();
}
