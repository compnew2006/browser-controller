/**
 * Browser Controller — background service worker (v3 architecture).
 *
 * v2 architecture (plan tasks 1.2–1.5, 2.1–2.5) still applies; the code now
 * lives in focused ES modules instead of one 2000+ line file:
 *   - lib/state.js          per-tab buffers, concurrency instances, session
 *                           persistence (MV3 lifetime: locks + fallbacks
 *                           survive service-worker recycles)
 *   - lib/connection.js     daemon WS lifecycle, badge, status broadcast
 *   - lib/router.js         tool dispatch through the per-tab mutex + locks
 *   - lib/page-exec.js      resolveTab / safeExec / locator guard
 *   - lib/overlay.js        action badge overlay + tab-lock shield
 *   - handlers/*.js         the 22 tool implementations, grouped by concern
 *   - events.js             chrome.* event listeners (console capture, popup,
 *                           webRequest, tab lifecycle)
 *
 * This file is wiring only: inject the router into the connection, register
 * the browser events, and start connecting. Handler modules never import the
 * router and the connection never imports the handlers — the dependency graph
 * stays acyclic and every module except this one is importable in tests.
 */
import { setMessageHandler, initConnection } from './lib/connection.js';
import { handleMessage } from './lib/router.js';
import { registerEventListeners } from './events.js';

setMessageHandler(handleMessage);
registerEventListeners();
initConnection();
