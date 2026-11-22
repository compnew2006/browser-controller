import {
  getAdoptedDaemonInstance,
  persistSessionState,
  setAdoptedDaemonInstance,
  tabControl,
  tabLocks,
} from './state.js';
import { clearAgentCursor, hideLockShield } from './overlay.js';
import { clearTaskLockShields } from './task-locks.js';

/**
 * Locks, control entries and shields belong to the daemon instance that granted
 * them. A hello from a different instance means the daemon restarted, so release
 * its stale browser state. A hello without an instance id changes nothing.
 * Returns how many tab locks were released.
 */
export function adoptDaemonInstance(instanceId, reportStatus) {
  if (typeof instanceId !== 'string' || !instanceId) return 0;
  if (getAdoptedDaemonInstance() === instanceId) return 0;
  setAdoptedDaemonInstance(instanceId);
  const stale = tabLocks.snapshot();
  const controlled = [...tabControl.entries.keys()];
  const taskShieldTabs = clearTaskLockShields();
  tabLocks.unlockAll();
  tabControl.clear();
  persistSessionState();
  for (const tabId of new Set([...stale.map((entry) => entry.tabId), ...controlled, ...taskShieldTabs])) {
    hideLockShield(tabId);
    clearAgentCursor(tabId);
  }
  if (stale.length) reportStatus(`Released ${stale.length} tab lock(s) left by a previous daemon`);
  return stale.length;
}
