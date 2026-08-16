/**
 * Lock operations shared by the tabs handler and the popup event wiring
 * (dedup: the lock → persist → shield → broadcast quartet lived in both).
 * Note the asymmetry these helpers encode: lockTabUi throws on a foreign
 * owner (TabLockMap.lock refuses to steal); releaseTabUi releases
 * unconditionally (used when the caller has already established the right to
 * release). The owner-CHECKED unlock (browser_tabs unlock) stays inline in
 * handlers/tabs.js because its ordering differs (check before shield removal).
 */
import { tabLocks, persistSessionState } from './state.js';
import { showLockShield, hideLockShield } from './overlay.js';
import { broadcastStatus } from './connection.js';

/**
 * Lock a tab for `owner`, persist the lock, raise the shield, broadcast.
 * Throws when another session already owns the tab.
 */
export function lockTabUi(tabId, owner, message) {
  tabLocks.lock(tabId, owner);
  persistSessionState();
  showLockShield(tabId); // show blue frame + input block for the lock lifetime
  if (message) broadcastStatus(message);
}

/**
 * Release a tab's lock unconditionally, persist, drop the shield, broadcast.
 * Returns the previous owner (for previousSession-style payloads).
 */
export function releaseTabUi(tabId, message) {
  const was = tabLocks.owner(tabId);
  tabLocks.release(tabId);
  persistSessionState();
  hideLockShield(tabId);
  if (message) broadcastStatus(message);
  return was;
}
