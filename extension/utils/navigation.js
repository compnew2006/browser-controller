/**
 * Pure navigation helpers (framework-free → unit-testable without Chrome).
 *
 * `handlers/navigation.js` imports `isHashOnlyChange` to decide whether
 * `handleNavigate` must wait for `chrome.tabs.onUpdated` `status === 'complete'`.
 * A hash/fragment-only change does NOT reload the document, so that event never
 * fires and the wait hangs until the navigation timeout. Detecting the case lets
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

/** Schemes that are never plain web addresses: a typed value keeps them as they are. */
const NON_WEB_SCHEME = /^(about|blob|chrome|data|devtools|edge|file|javascript|mailto|sms|tel|view-source):/i;
/** A local dev server (no certificate): http, not https. */
const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?([/?#]|$)/i;

/**
 * The address to load for what the agent typed. The scheme is optional:
 * "example.com" → https://example.com, "localhost:3000" → http://localhost:3000.
 * Without this, a bare host was handed to the browser as a relative URL and
 * landed on chrome-extension://<id>/example.com (audit #11).
 *
 * @param {unknown} input
 * @returns {string}
 */
export function normalizeNavigationUrl(input) {
  const s = String(input ?? '').trim();
  if (!s) return s;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s) || NON_WEB_SCHEME.test(s)) return s;
  if (LOCAL_HOST.test(s)) return `http://${s}`;
  return `https://${s}`;
}

/** Response types a browser saves instead of showing: a navigation to one is a download. */
const DOWNLOAD_TYPE = /^application\/(octet-stream|zip|x-tar|gzip|x-gzip|x-7z-compressed|x-msdownload|x-apple-diskimage)\b/i;

function filenameOf(disposition) {
  const m = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disposition);
  if (!m) return null;
  try { return decodeURIComponent(m[1].trim()); } catch { return m[1].trim(); }
}

/**
 * What a main-frame response means for its tab, from its webRequest status and
 * headers. A 204/205 "No Content" never replaces the page, and an attachment (or a
 * type a browser saves) is downloaded, so the tab stays where it was. Neither one
 * fires the tab's `complete` event, which is why waiting for it hung until the timeout.
 *
 * @param {number} statusCode
 * @param {Array<{name: string, value?: string}>} [responseHeaders]
 * @returns {{noContent: boolean, download: boolean, filename: string|null}}
 */
export function classifyMainResponse(statusCode, responseHeaders = []) {
  const header = (name) => String((responseHeaders || []).find((h) => String(h.name).toLowerCase() === name)?.value ?? '');
  const redirect = statusCode >= 300 && statusCode < 400;
  const disposition = header('content-disposition');
  const download = !redirect && (/^\s*attachment\b/i.test(disposition) || DOWNLOAD_TYPE.test(header('content-type').trim()));
  return {
    noContent: statusCode === 204 || statusCode === 205,
    download,
    filename: download ? filenameOf(disposition) : null,
  };
}
