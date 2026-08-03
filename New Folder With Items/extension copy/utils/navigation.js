/**
 * Pure navigation helpers (framework-free → unit-testable without Chrome).
 *
 * `background.js` imports `isHashOnlyChange` to decide whether
 * `handleNavigate` must wait for `chrome.tabs.onUpdated` `status === 'complete'`.
 * A hash/fragment-only change does NOT reload the document, so that event never
 * fires and the wait hangs for the full 55s timeout. Detecting the case lets
 * the handler skip the wait and settle on the SPA-settle delay alone.
 */

/**
 * Does `toUrl` differ from `fromUrl` only by the hash/fragment?
 *
 * Same protocol/host/port/pathname/search AND a different hash → true.
 * Identical URLs (including hash) → false (no change, wait is a harmless no-op).
 * Invalid/non-absolute input → false (caller falls back to the safe full wait).
 *
 * @param {string|undefined} fromUrl
 * @param {string|undefined} toUrl
 * @returns {boolean}
 */
export function isHashOnlyChange(fromUrl, toUrl) {
  if (!fromUrl || !toUrl) return false;
  try {
    const a = new URL(fromUrl);
    const b = new URL(toUrl);
    return (
      a.protocol === b.protocol &&
      a.host === b.host &&
      a.port === b.port &&
      a.pathname === b.pathname &&
      a.search === b.search &&
      a.hash !== b.hash
    );
  } catch {
    // One of them wasn't a valid absolute URL (e.g. relative). Treat as a full
    // navigate — the `onUpdated` wait is the safe default.
    return false;
  }
}
