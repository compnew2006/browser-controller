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
 * Throws when another session already owns the tab (TabLockMap.lock refuses
 * to steal). Returns whether the input-blocking shield was actually injected —
 * on a protected page (chrome:// …) it silently never appears, and the lock
 * must not pretend the user is blocked when they aren't (audit HIGH #4).
 */
export async function lockTabUi(tabId, owner, message) {
  tabLocks.lock(tabId, owner);
  persistSessionState();
  const shielded = await showLockShield(tabId); // plain frame, no label
  if (message) broadcastStatus(message);
  if (!shielded) {
    broadcastStatus(`Warning: input shield could not be injected on tab ${tabId} (protected page?) — lock is tracked, but user input is NOT blocked.`);
  }
  return shielded;
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
