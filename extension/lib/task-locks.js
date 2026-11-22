/** Task-scoped leases that keep the page input shield active between tool calls. */
import { persistSessionState, taskLockShields } from './state.js';
import { TASK_ID_PATTERN } from './generated-contract.js';

const TASK_ID_RE = new RegExp(`^${TASK_ID_PATTERN}$`, 'u');

function taskLockKey(sessionId, taskId) {
  return `${sessionId}\u0000${taskId}`;
}

function taskLocksFor(tabId) {
  return taskLockShields.get(tabId);
}

/** Whether one or more running tasks require the page shield to remain active. */
export function hasTaskLockShield(tabId, sessionId, taskId) {
  const leases = taskLocksFor(tabId);
  if (!leases) return false;
  return sessionId === undefined || taskId === undefined
    ? leases.size > 0
    : leases.has(taskLockKey(sessionId, taskId));
}

/** Retain an already-installed shield across the gaps between one task's tool calls. */
export function retainTaskLockShield(tabId, sessionId, taskId) {
  if (typeof sessionId !== 'string' || !sessionId || typeof taskId !== 'string' || !TASK_ID_RE.test(taskId)) return false;
  let leases = taskLockShields.get(tabId);
  if (!leases) {
    leases = new Map();
    taskLockShields.set(tabId, leases);
  }
  leases.set(taskLockKey(sessionId, taskId), { sessionId, taskId });
  persistSessionState();
  return true;
}

/** Release every tab held by one task after its run settles, including pause or failure. */
export async function releaseTaskLockShields(taskId, sessionId, hideLockShield) {
  const released = [];
  for (const [tabId, leases] of taskLockShields) {
    if (!leases.delete(taskLockKey(sessionId, taskId))) continue;
    released.push(tabId);
    if (leases.size === 0) taskLockShields.delete(tabId);
  }
  if (released.length) persistSessionState();
  await Promise.all(released.filter((tabId) => !hasTaskLockShield(tabId)).map((tabId) => hideLockShield(tabId)));
  return released;
}

/** Drop task leases owned by a disconnected MCP session; caller performs common tab cleanup. */
export function releaseTaskLockShieldsForSession(sessionId) {
  const released = [];
  for (const [tabId, leases] of taskLockShields) {
    let removed = false;
    for (const [key, lease] of leases) {
      if (lease.sessionId !== sessionId) continue;
      leases.delete(key);
      removed = true;
    }
    if (!removed) continue;
    released.push(tabId);
    if (leases.size === 0) taskLockShields.delete(tabId);
  }
  if (released.length) persistSessionState();
  return released;
}

/** The session owners that must be considered when a reconnect reconciles its roster. */
export function taskShieldOwners() {
  const owners = new Set();
  for (const leases of taskLockShields.values()) {
    for (const lease of leases.values()) owners.add(lease.sessionId);
  }
  return owners;
}

/** Forget every transient task shield when the daemon instance changes. */
export function clearTaskLockShields() {
  const tabIds = [...taskLockShields.keys()];
  taskLockShields.clear();
  return tabIds;
}

/** Move every lease when Chrome replaces the tab that it belongs to. */
export function moveTaskLockShield(fromTabId, toTabId) {
  if (fromTabId === toTabId) return false;
  const leases = taskLockShields.get(fromTabId);
  if (!leases) return false;
  const replacement = taskLockShields.get(toTabId) ?? new Map();
  for (const [key, lease] of leases) replacement.set(key, lease);
  taskLockShields.delete(fromTabId);
  taskLockShields.set(toTabId, replacement);
  persistSessionState();
  return true;
}

export function forgetTaskLockShield(tabId) {
  if (!taskLockShields.delete(tabId)) return false;
  persistSessionState();
  return true;
}

export function discardTaskLockShields(tabId, targetTabId) {
  const removedFromTab = taskLockShields.delete(tabId);
  const removedFromTarget = tabId !== targetTabId && taskLockShields.delete(targetTabId);
  if (removedFromTab || removedFromTarget) persistSessionState();
}
