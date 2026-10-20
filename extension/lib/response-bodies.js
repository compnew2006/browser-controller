/**
 * Response bodies for browser_logs (opt-in, `bodies: true`).
 * webRequest never sees bodies, so while capture is on the tab's debugger
 * session has the Network domain enabled: every Document/XHR/Fetch response
 * that finishes loading is read with Network.getResponseBody right away
 * (Chrome evicts it later) and kept here, capped. CDP request ids differ from
 * webRequest's, so a buffered request finds its body by method + final URL +
 * nearest start time. Pure (no chrome global): the handler passes `getBody`.
 */

import { redactTextKeys, redactUrl } from './network-capture.js';

export const REDACTED = '[redacted]';
export const MAX_BODIES = 50;
export const MAX_BODY_CHARS = 100_000;
/** Bodies bigger than this on the wire are not read at all (they would only be cut to MAX_BODY_CHARS). */
const MAX_READ_BYTES = 5_000_000;

const BODY_TYPES = new Set(['Document', 'XHR', 'Fetch']);
// webRequest and CDP stamp the same request a few ms apart.
const MATCH_WINDOW_MS = 3000;
// Requests that never finish (long polls, aborted pages) must not leak.
const INFLIGHT_CAP = 500;
const TEXT_MIME = /^text\/|json|xml|javascript|ecmascript|x-www-form-urlencoded|graphql|csv|yaml/i;
// Narrower than the header pattern: JSON keys such as "author" or "max_tokens" are ordinary data.
const SENSITIVE_KEY = /token|secret|passw|api[-_]?key|^authorization$|^cookie$|^session[-_]?id$/i;

/** Does `text` parse as JSON? */
function parsesAsJson(text) {
  try { JSON.parse(text); return true; } catch { return false; }
}

/**
 * Redact a body for browser_logs. JSON is redacted by key at any depth (redactJsonBody). Any
 * other text, and JSON cut off before its end, is redacted by its secret-looking key/value
 * pairs (redactTextKeys): an HTML page or a form post carries secrets too (L2).
 */
export function redactBody(text) {
  return parsesAsJson(text) ? redactJsonBody(text) : redactTextKeys(text);
}

/**
 * Replace the string values under credential keys (access_token, password,
 * apiKey…) in a JSON body, at any depth below the key ({"tokens": ["…"]},
 * {"secret": {"value": "…"}}); numbers stay ("max_tokens": 50). Text that is
 * not JSON, or has nothing to redact, comes back unchanged.
 */
export function redactJsonBody(text) {
  let data;
  try { data = JSON.parse(text); } catch { return { text, redacted: [] }; }
  const redacted = new Set();
  const walk = (node, under) => {
    if (Array.isArray(node)) {
      node.forEach((value, i) => {
        if (under && typeof value === 'string') { node[i] = REDACTED; redacted.add(under); }
        else walk(value, under);
      });
      return;
    }
    if (!node || typeof node !== 'object') return;
    for (const [key, value] of Object.entries(node)) {
      const owner = under || (SENSITIVE_KEY.test(key) ? key : null);
      if (typeof value !== 'string') walk(value, owner);
      else if (owner) { node[key] = REDACTED; redacted.add(owner); }
    }
  };
  walk(data, null);
  return redacted.size ? { text: JSON.stringify(data), redacted: [...redacted] } : { text, redacted: [] };
}

function bodyView({ body, base64Encoded }, mimeType, maxChars) {
  let text = body ?? '';
  if (base64Encoded) {
    const bytes = Uint8Array.from(atob(text), (ch) => ch.charCodeAt(0));
    if (!TEXT_MIME.test(mimeType || '')) return { binary: true, length: bytes.length };
    text = new TextDecoder().decode(bytes);
  }
  const { text: safe, redacted } = redactBody(text);
  return {
    text: safe.length > maxChars ? safe.slice(0, maxChars) : safe,
    length: safe.length,
    ...(safe.length > maxChars ? { truncated: true } : {}),
    ...(redacted.length ? { redacted } : {}),
  };
}

/**
 * `onEvent(method, params)` takes the tab's CDP events (it returns the body
 * read's promise for loadingFinished, so tests can await it); `find(entry)`
 * returns the stored body for a webRequest entry, or null.
 */
export function createBodyCapture({ getBody, maxBodies = MAX_BODIES, maxChars = MAX_BODY_CHARS }) {
  const inflight = new Map(); // CDP requestId -> { method, url, start, status, mimeType }
  const bodies = [];

  const keep = (record) => {
    bodies.push(record);
    if (bodies.length > maxBodies) bodies.shift();
  };

  return {
    onEvent(method, p) {
      if (method === 'Network.requestWillBeSent') {
        const prev = inflight.get(p.requestId);
        if (!prev && !BODY_TYPES.has(p.type)) return undefined;
        // A redirect re-sends the same id: keep the first hop's start, follow the URL.
        inflight.set(p.requestId, { method: p.request.method, url: redactUrl(p.request.url), start: prev?.start ?? p.wallTime * 1000 });
        if (inflight.size > INFLIGHT_CAP) inflight.delete(inflight.keys().next().value);
      } else if (method === 'Network.responseReceived') {
        const r = inflight.get(p.requestId);
        if (r) Object.assign(r, { status: p.response.status, mimeType: p.response.mimeType });
      } else if (method === 'Network.loadingFailed') {
        inflight.delete(p.requestId);
      } else if (method === 'Network.loadingFinished') {
        const r = inflight.get(p.requestId);
        if (!r) return undefined;
        inflight.delete(p.requestId);
        // Never pull a video or a zip into the service worker just to report its size.
        if (r.mimeType && !TEXT_MIME.test(r.mimeType)) return keep({ ...r, binary: true, transferSize: p.encodedDataLength });
        if (p.encodedDataLength > MAX_READ_BYTES) return keep({ ...r, tooLarge: true, transferSize: p.encodedDataLength });
        return getBody(p.requestId).then(
          (res) => keep({ ...r, ...bodyView(res, r.mimeType, maxChars) }),
          (err) => keep({ ...r, error: String(err?.message || err).slice(0, 200) }),
        );
      }
      return undefined;
    },

    /** The body of a webRequest entry ({method, url, timestamp, durationMs}): same method and URL, closest start. */
    find(entry) {
      const start = entry.timestamp - (entry.durationMs || 0);
      let best = null;
      for (const b of bodies) {
        if (b.method !== entry.method || b.url !== entry.url) continue;
        const gap = Math.abs(b.start - start);
        if (gap <= MATCH_WINDOW_MS && (!best || gap < best.gap)) best = { gap, b };
      }
      if (!best) return null;
      const { method: _m, url: _u, start: _s, ...body } = best.b;
      return body;
    },

    get size() { return bodies.length; },
    clear() { bodies.length = 0; },
  };
}
