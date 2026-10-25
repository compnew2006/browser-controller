/**
 * Ownership operations shared by the navigate handler (a tab a session opens),
 * the tabs handler (close) and the popup event wiring (pin / unpin): the
 * lock → persist → broadcast and release → persist → broadcast sequences live
 * here once. The input shield is not drawn here: it is shown only while a tool
 * call runs on the tab (dispatch/router.js).
 * Note the asymmetry these helpers encode: lockTabUi throws on a foreign
 * owner (TabLockMap.lock refuses to steal); releaseTabUi releases
 * unconditionally (used when the caller has already established the right to
 * release).
 */
import { tabLocks, tabControl, persistSessionState } from './state.js';
import { hideLockShield } from './overlay.js';
import { broadcastStatus } from './connection.js';

/**
 * Lock a tab for `owner`, persist the lock, broadcast. Throws when another
 * session already owns the tab (TabLockMap.lock refuses to steal). Draws no
 * frame: between calls a lock leaves the page's input alone.
 */
export function lockTabUi(tabId, owner, message) {
  tabLocks.lock(tabId, owner);
  persistSessionState();
  if (message) broadcastStatus(message);
}

/**
 * Release a tab's lock unconditionally, persist, drop any shield still on the
 * tab, broadcast. The tab is handed back, so it shows free at once (no control
 * linger). Returns the previous owner (for previousSession-style payloads).
 */
export function releaseTabUi(tabId, message) {
  const was = tabLocks.owner(tabId);
  tabLocks.release(tabId);
  tabControl.settle(tabId);
  persistSessionState();
  hideLockShield(tabId);
  if (message) broadcastStatus(message);
  return was;
}
