/**
 * webRequest → per-tab network buffer: request ids, durations and redacted
 * headers, plus the lean list view and resource-type filter browser_network
 * uses. Pure (no chrome global) so tests can drive it; events.js wires the
 * listeners. Response bodies are out of reach here: webRequest never sees them
 * (that needs the debugger's Network domain).
 */

export const REDACTED = '[redacted]';

// Credential and session header values never leave the browser; the names stay visible.
const SENSITIVE_HEADER = /^(authorization|proxy-authorization|cookie|set-cookie)$|api[-_]?key|token|secret|passw|session|auth/i;

// Requests that started but never completed (long polls, aborted pages) must not leak.
const PENDING_CAP = 2000;

// Analytics hits carry ~1 KB query strings; the list keeps the start of each URL.
const LIST_URL_MAX = 200;

/** [{name, value}] with credential-bearing values replaced; undefined when absent. */
export function redactHeaders(headers) {
  if (!Array.isArray(headers)) return undefined;
  return headers.map(({ name, value }) => ({ name, value: SENSITIVE_HEADER.test(name) ? REDACTED : value ?? '' }));
}

/**
 * Listener bodies for chrome.webRequest. `store(tabId, entry)` receives each
 * finished request (completed or failed) of a real tab.
 */
export function createNetworkCapture({ store }) {
  const pending = new Map(); // requestId → { start, requestHeaders }

  function finish(d, outcome) {
    const started = pending.get(d.requestId);
    pending.delete(d.requestId);
    if (d.tabId == null || d.tabId < 0) return; // service workers, extension pages
    const entry = { id: String(d.requestId), method: d.method, url: d.url, ...outcome, type: d.type, timestamp: d.timeStamp };
    if (started && typeof started.start === 'number') entry.durationMs = Math.max(0, Math.round(d.timeStamp - started.start));
    if (started && started.requestHeaders) entry.requestHeaders = started.requestHeaders;
    store(d.tabId, entry);
  }

  return {
    onBeforeRequest(d) {
      if (d.tabId == null || d.tabId < 0) return;
      pending.set(d.requestId, { start: d.timeStamp });
      if (pending.size > PENDING_CAP) pending.delete(pending.keys().next().value);
    },
    onSendHeaders(d) {
      const started = pending.get(d.requestId);
      if (started) started.requestHeaders = redactHeaders(d.requestHeaders);
    },
    onCompleted(d) {
      const responseHeaders = redactHeaders(d.responseHeaders);
      finish(d, { status: d.statusCode, ...(responseHeaders ? { responseHeaders } : {}) });
    },
    onErrorOccurred(d) {
      finish(d, { error: d.error });
    },
  };
}

/** One entry as browser_network lists it: no headers, long URLs cut unless fullUrls. */
export function listView(entry, { fullUrls = false } = {}) {
  const { requestHeaders: _req, responseHeaders: _res, ...lean } = entry;
  if (!fullUrls && typeof lean.url === 'string' && lean.url.length > LIST_URL_MAX) {
    lean.url = `${lean.url.slice(0, LIST_URL_MAX)}…[+${lean.url.length - LIST_URL_MAX} chars]`;
  }
  return lean;
}

const RESOURCE_TYPES = ['main_frame', 'sub_frame', 'stylesheet', 'script', 'image', 'font', 'object', 'xmlhttprequest',
  'ping', 'csp_report', 'media', 'websocket', 'webbundle', 'other'];
const TYPE_ALIASES = {
  xhr: ['xmlhttprequest'], fetch: ['xmlhttprequest'], document: ['main_frame', 'sub_frame'],
  frame: ['sub_frame'], css: ['stylesheet'], js: ['script'], img: ['image'],
};

/** Predicate for a resource-type filter (string or list, webRequest names or aliases); null = no filter. */
export function typeMatcher(type) {
  if (type == null || (Array.isArray(type) && type.length === 0)) return null;
  const wanted = new Set();
  for (const raw of Array.isArray(type) ? type : [type]) {
    const t = String(raw).toLowerCase();
    if (TYPE_ALIASES[t]) TYPE_ALIASES[t].forEach((x) => wanted.add(x));
    else if (RESOURCE_TYPES.includes(t)) wanted.add(t);
    else throw new Error(`Unknown resource type "${raw}". Use ${[...Object.keys(TYPE_ALIASES), ...RESOURCE_TYPES].join(', ')}.`);
  }
  return (entry) => wanted.has(entry.type);
}
