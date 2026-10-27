/**
 * webRequest → per-tab network buffer: request ids, durations, redacted headers
 * and a bounded, redacted request-body preview, plus the lean list view. Pure (no chrome global) so tests
 * can drive it; events.js wires the listeners. Response bodies are out of reach
 * here: webRequest never sees them (that needs the debugger's Network domain).
 */
import { PER_TAB_CAP } from './state.js';
import { isSecretKey } from './secret-keys.js';

export const REDACTED = '[redacted]';

// Credential and session header values never leave the browser; the names stay visible.
const SENSITIVE_HEADER = /^(authorization|proxy-authorization|cookie|set-cookie)$|api[-_]?key|token|secret|passw|session|auth/i;

// Requests that started but never completed (long polls, aborted pages) must not leak.
const PENDING_CAP = 2000;

// Analytics hits carry ~1 KB query strings; the list keeps the start of each URL.
const LIST_URL_MAX = 200;

// The fields a list row carries: network facts only (intercept data and bodies never appear there).
const LIST_FIELDS = ['id', 'method', 'url', 'status', 'type', 'timestamp', 'durationMs', 'error'];

// Request bodies: a bounded preview, never the raw payload.
export const BODY_PREVIEW_MAX = 2048;
// Bodies up to this size are parsed whole (JSON) so redaction sees every value; larger ones get a text-level pass.
const BODY_PARSE_MAX = 64 * 1024;
// Keys whose values are never shown, at any depth: the shared policy in secret-keys.js.
// key=value and "key": value pairs in JSON, form or plain text (for bodies that cannot be parsed whole).
// The lookbehind starts a key only at the beginning of a word, so a long run of base64 or hex is not
// rescanned from every position (that took seconds on 64 KB). A value never starts a nested object or
// array: the scan goes on inside it, so a secret under a plain key is still found.
const PAIR = /(?<![\w.[\]-])("?)([\w.[\]-]+)\1(\s*[:=]\s*)("(?:[^"\\]|\\.)*"|[^&,;}\]\s{[]*)/g;

// Static assets are evicted before API calls, documents and scripts when a tab's buffer is full.
const STATIC_TYPES = new Set(['image', 'font', 'stylesheet', 'media']);

/** [{name, value}] with credential-bearing values replaced; undefined when absent. */
export function redactHeaders(headers) {
  if (!Array.isArray(headers)) return undefined;
  return headers.map(({ name, value }) => ({ name, value: SENSITIVE_HEADER.test(name) ? REDACTED : value ?? '' }));
}

const clip = (text, max) => (text.length > max ? `${text.slice(0, max)}…[+${text.length - max} chars]` : text);

/** Secret-looking values replaced anywhere inside a parsed JSON value. */
function redactDeep(value) {
  if (Array.isArray(value)) return value.map(redactDeep);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, isSecretKey(k) ? REDACTED : redactDeep(v)]));
  }
  return value;
}

/**
 * Text-level pass for bodies that cannot be parsed whole: secret-looking key/value pairs only.
 * Returns the text and the names of the keys redacted.
 */
export function redactTextKeys(text) {
  const keys = new Set();
  const out = text.replace(PAIR, (match, quote, key, sep, value) => {
    if (!isSecretKey(key)) return match;
    keys.add(key);
    return `${quote}${key}${quote}${sep}${value.startsWith('"') ? `"${REDACTED}"` : REDACTED}`;
  });
  return { text: out, redacted: [...keys] };
}

function redactText(text) {
  return redactTextKeys(text).text;
}

/**
 * The URL with the values of secret-looking query keys replaced by `***` (the keys stay, so
 * the request is still readable). Only the query string is touched (L3).
 */
export function redactUrl(url) {
  const start = url.indexOf('?');
  if (start === -1) return url;
  const hash = url.indexOf('#', start);
  const end = hash === -1 ? url.length : hash;
  const query = url.slice(start + 1, end).split('&').map((pair) => {
    const eq = pair.indexOf('=');
    if (eq === -1) return pair;
    let key;
    try { key = decodeURIComponent(pair.slice(0, eq)); } catch { key = pair.slice(0, eq); }
    return isSecretKey(key) ? `${pair.slice(0, eq)}=***` : pair;
  }).join('&');
  return `${url.slice(0, start + 1)}${query}${url.slice(end)}`;
}

/** Control characters (other than tab, newline, carriage return) or several replacement characters mean binary data; one replacement is a multi-byte character cut by the head. */
function looksBinary(text) {
  let replacements = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code === 0xfffd) replacements++;
    else if (code < 32 && code !== 9 && code !== 10 && code !== 13) return true;
  }
  return replacements > 3;
}

/** Concatenate the first `max` bytes of the raw body parts (each part has a bytes ArrayBuffer, or a file path). */
function headBytes(parts, size, max) {
  const out = new Uint8Array(Math.min(size, max));
  let offset = 0;
  for (const part of parts) {
    if (offset >= out.length) break;
    const bytes = new Uint8Array(part.bytes);
    const n = Math.min(bytes.length, out.length - offset);
    out.set(bytes.subarray(0, n), offset);
    offset += n;
  }
  return out;
}

/**
 * What browser_logs shows for a request body (webRequest requestBody), or
 * undefined when there is none:
 *   { kind: 'form', fields }            form data: values of secret-looking keys redacted
 *   { kind: 'raw', size, preview }      text body: first BODY_PREVIEW_MAX chars, secrets redacted
 *   { kind: 'binary', size }            non-text body: size only
 *   { kind: 'files', files }             file upload parts only: counted, never read
 * plus `files` (upload parts, by count) and `truncated` when the preview is not the whole body.
 */
export function summarizeRequestBody(body) {
  if (!body || typeof body !== 'object') return undefined;
  if (body.formData && typeof body.formData === 'object') {
    const entries = Object.entries(body.formData);
    const fields = {};
    for (const [key, values] of entries.slice(0, 50)) {
      fields[key] = (Array.isArray(values) ? values : [values]).map((v) => (isSecretKey(key) ? REDACTED : clip(String(v), 200)));
    }
    return { kind: 'form', fields, ...(entries.length > 50 ? { truncated: true } : {}) };
  }
  const raw = Array.isArray(body.raw) ? body.raw : [];
  const parts = raw.filter((part) => part && part.bytes);
  const files = raw.length - parts.length;
  const size = parts.reduce((n, part) => n + part.bytes.byteLength, 0);
  if (size === 0) return files ? { kind: 'files', files } : undefined;
  const head = headBytes(parts, size, BODY_PARSE_MAX);
  const text = new TextDecoder('utf-8').decode(head);
  if (looksBinary(text)) return { kind: 'binary', size, ...(files ? { files } : {}) };
  let redacted = null;
  if (size <= BODY_PARSE_MAX && /^\s*[{[]/.test(text)) {
    try { redacted = JSON.stringify(redactDeep(JSON.parse(text))); } catch { redacted = null; }
  }
  if (redacted === null) redacted = redactText(text);
  return {
    kind: 'raw',
    size,
    preview: clip(redacted, BODY_PREVIEW_MAX),
    ...(files ? { files } : {}),
    ...(size > BODY_PREVIEW_MAX || redacted.length > BODY_PREVIEW_MAX ? { truncated: true } : {}),
  };
}

/**
 * Listener bodies for chrome.webRequest. `store(tabId, entry)` receives each
 * finished request (completed or failed) of a real tab.
 */
export function createNetworkCapture({ store }) {
  const pending = new Map(); // requestId → { start, requestHeaders, requestBody }

  function finish(d, outcome) {
    const started = pending.get(d.requestId);
    pending.delete(d.requestId);
    if (d.tabId == null || d.tabId < 0) return; // service workers, extension pages
    const entry = { id: String(d.requestId), method: d.method, url: redactUrl(d.url), ...outcome, type: d.type, timestamp: d.timeStamp };
    if (started && typeof started.start === 'number') entry.durationMs = Math.max(0, Math.round(d.timeStamp - started.start));
    if (started && started.requestHeaders) entry.requestHeaders = started.requestHeaders;
    if (started && started.requestBody) entry.requestBody = started.requestBody;
    store(d.tabId, entry);
  }

  return {
    onBeforeRequest(d) {
      if (d.tabId == null || d.tabId < 0) return;
      const requestBody = summarizeRequestBody(d.requestBody); // only present when the listener asks for requestBody
      pending.set(d.requestId, { start: d.timeStamp, ...(requestBody ? { requestBody } : {}) });
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

/** Append one entry to a tab's network buffer; when full, static assets go first, then the oldest entry. */
export function pushNetworkEntry(buf, entry, cap = PER_TAB_CAP) {
  buf.push(entry);
  while (buf.length > cap) {
    const i = buf.findIndex((e) => STATIC_TYPES.has(e.type));
    buf.splice(i === -1 ? 0 : i, 1);
  }
}

/** One entry as a list row carries it: network fields only, long URLs cut unless fullUrls. */
export function listView(entry, { fullUrls = false } = {}) {
  const lean = {};
  for (const key of LIST_FIELDS) if (entry[key] !== undefined) lean[key] = entry[key];
  if (!fullUrls && typeof lean.url === 'string' && lean.url.length > LIST_URL_MAX) {
    lean.url = `${lean.url.slice(0, LIST_URL_MAX)}…[+${lean.url.length - LIST_URL_MAX} chars]`;
  }
  return lean;
}

