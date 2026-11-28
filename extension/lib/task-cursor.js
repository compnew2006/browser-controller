/**
 * Task-mode agent-cursor override (Gap D, specs/011-professional-browsing-layer).
 *
 * The popup switch stays the global default (off): this module only records
 * what the task runner asked for. The runner enables the cursor when a task
 * starts and disables it only when the task settles (done/failed) or is
 * cancelled — a pause (paused-question / paused-login) is still a live task
 * with the user watching, so it never disables here. The state is in-memory
 * only: a service-worker recycle drops it, and the next run re-enables it.
 *
 * The override is scoped per call, not per browser: the router marks the tab
 * a task call is driving (`begin/endTaskCursorCall`) around one dispatch, so
 * a plain call on another tab — or the same tab between task steps — never
 * inherits it. Between steps the cursor stays visible through the task's
 * shield/lease, not through this map; after a step the linger path may hide
 * it, and the next task step re-shows it (the override never fights linger).
 */

const taskCursorTasks = new Set();
const taskCursorCallTabs = new Map();
const taskCursorTabsByTask = new Map();

/** Whether the runner has enabled the task-mode cursor for this task. */
export function isTaskCursorEnabled(taskId) {
  return typeof taskId === 'string' && taskCursorTasks.has(taskId);
}

/** Record the runner's enable for a task (run start). */
export function enableTaskCursor(taskId) {
  if (typeof taskId !== 'string' || taskId === '') return false;
  taskCursorTasks.add(taskId);
  return true;
}

/**
 * Drop the runner's enable for a task (settle/cancel) and return the tabs it
 * drove, so the caller can remove the cursor element from each at once
 * instead of leaving it to the page's 30 s idle fade.
 */
export function disableTaskCursor(taskId) {
  if (typeof taskId !== 'string') return [];
  taskCursorTasks.delete(taskId);
  const tabs = [...(taskCursorTabsByTask.get(taskId) ?? [])];
  taskCursorTabsByTask.delete(taskId);
  for (const [tabId, owner] of taskCursorCallTabs) {
    if (owner === taskId) taskCursorCallTabs.delete(tabId);
  }
  return tabs;
}

/**
 * Mark the tab a task call is driving, for the duration of one dispatch.
 * A call whose task was never enabled marks nothing, so a plain call keeps
 * the opt-in behaviour. One tab runs one call at a time (per-tab mutex), so
 * a single entry per tab cannot cross between concurrent calls.
 */
export function beginTaskCursorCall(tabId, taskId) {
  if (!Number.isInteger(tabId) || typeof taskId !== 'string' || !taskCursorTasks.has(taskId)) return false;
  taskCursorCallTabs.set(tabId, taskId);
  let tabs = taskCursorTabsByTask.get(taskId);
  if (!tabs) {
    tabs = new Set();
    taskCursorTabsByTask.set(taskId, tabs);
  }
  tabs.add(tabId);
  return true;
}

/** Clear the mark, but only for the call that set it. */
export function endTaskCursorCall(tabId, taskId) {
  if (!Number.isInteger(tabId) || taskCursorCallTabs.get(tabId) !== taskId) return false;
  taskCursorCallTabs.delete(tabId);
  return true;
}

/** Whether the tab's in-flight call belongs to a task whose cursor is enabled. */
export function taskCursorActiveForTab(tabId) {
  const taskId = taskCursorCallTabs.get(tabId);
  return taskId !== undefined && taskCursorTasks.has(taskId);
}
