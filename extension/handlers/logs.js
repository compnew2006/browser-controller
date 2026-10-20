/**
 * browser_logs: what a tab's page logged and what it requested, as lines.
 *   console  the page's console calls and uncaught errors (Runtime replay, lib/browser-log.js)
 *   network  the tab's requests (webRequest buffer, lib/network-capture.js), no debugger needed
 *   requestId  one request in full; bodies (CDP Network, opt-in) add the response body
 */
import { resolveTab } from '../lib/page-exec.js';
import { networkByTab, bodyCaptureByTab, getTabBuffer, PER_TAB_CAP } from '../lib/state.js';
import { withCdp, subscribeCdpEvents, pinCdp, unpinCdp, isCdpPinned } from '../lib/cdp-session.js';
import { collectPageConsole } from '../lib/browser-log.js';
import { listView } from '../lib/network-capture.js';
import { createBodyCapture, MAX_BODIES } from '../lib/response-bodies.js';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
/** The latest console entries the filters look through (Chrome keeps more). */
const CONSOLE_SCAN = 200;
const URL_MAX = 120;
const STACK_LINES = 3;
const STACK_LINE_MAX = 160;
const BODY_PIN = 'network-bodies';
const ERROR_LEVELS = new Set(['error']);
const TYPE_NAMES = { xmlhttprequest: 'xhr', main_frame: 'document', sub_frame: 'frame' };
const FRAME = /^\s*at\s/;

function checkParams({ kind, filter, limit, clear, bodies, requestId }) {
  if (kind !== undefined && kind !== 'console' && kind !== 'network') throw new Error('INVALID_ARGUMENT: kind must be "console" or "network"');
  if (filter !== undefined && typeof filter !== 'string') throw new Error('INVALID_ARGUMENT: filter must be a string');
  if (limit !== undefined && limit !== null && !(Number.isInteger(limit) && limit >= 1 && limit <= MAX_LIMIT)) {
    throw new Error(`INVALID_ARGUMENT: limit must be an integer from 1 to ${MAX_LIMIT}`);
  }
  if (bodies !== undefined && typeof bodies !== 'boolean') throw new Error('INVALID_ARGUMENT: bodies must be true or false');
  if (requestId != null) {
    if (kind === 'console') throw new Error('INVALID_ARGUMENT: requestId reads one network request: leave kind out or use "network"');
    if (clear) throw new Error('INVALID_ARGUMENT: clear cannot be combined with requestId');
  } else if (bodies !== undefined && kind === 'console') {
    throw new Error('INVALID_ARGUMENT: bodies applies to network requests: leave kind out or use "network"');
  }
}

/** Run fn(send) on the tab's debugger; an attach failure is DEBUGGER_UNAVAILABLE (errors from fn pass through). */
async function withDebugger(tabId, fn) {
  let attached = false;
  try {
    return await withCdp(tabId, (send) => { attached = true; return fn(send); });
  } catch (err) {
    if (attached) throw err;
    throw new Error(`DEBUGGER_UNAVAILABLE: cannot attach the debugger to tab ${tabId} (${err?.message || err}).`, { cause: err });
  }
}

/** Is the tab's body capture still running? Its session detaching (banner closed) ends it. */
function bodyCaptureActive(tabId) {
  const cap = bodyCaptureByTab.get(tabId);
  if (!cap?.unsubscribe) return false;
  if (isCdpPinned(tabId, BODY_PIN)) return true;
  cap.unsubscribe();
  cap.unsubscribe = null;
  return false;
}

/**
 * Network domain on the tab's debugger session, bodies read as responses finish, session
 * pinned so it is not idle-detached. Network.disable is never sent on stop: browser_emulate's
 * throttling shares the domain.
 */
async function startBodyCapture(tabId) {
  if (bodyCaptureActive(tabId)) return;
  await withDebugger(tabId, async (send) => {
    let cap = bodyCaptureByTab.get(tabId);
    if (!cap) {
      cap = { bodies: createBodyCapture({ getBody: (requestId) => send('Network.getResponseBody', { requestId }) }), unsubscribe: null };
      bodyCaptureByTab.set(tabId, cap);
    }
    cap.unsubscribe = subscribeCdpEvents(tabId, (method, p) => {
      if (method.startsWith('Network.')) cap.bodies.onEvent(method, p);
    });
    try {
      await send('Network.enable', {});
    } catch (err) {
      cap.unsubscribe();
      cap.unsubscribe = null;
      throw err;
    }
    pinCdp(tabId, BODY_PIN);
  });
}

function stopBodyCapture(tabId) {
  const cap = bodyCaptureByTab.get(tabId);
  if (cap?.unsubscribe) {
    cap.unsubscribe();
    cap.unsubscribe = null;
  }
  unpinCdp(tabId, BODY_PIN);
}

const captureState = (tabId) => ({ active: bodyCaptureActive(tabId), bodies: bodyCaptureByTab.get(tabId)?.bodies.size ?? 0 });

// --- console lines -----------------------------------------------------------

const clock = (ts) => new Date(ts).toTimeString().slice(0, 8);

/** `error 12:01:02 message (src:line)`, then continuation lines and, for errors, up to STACK_LINES frames. */
function consoleLines(m) {
  const [first, ...rest] = String(m.text).split('\n');
  const time = typeof m.timestamp === 'number' ? ` ${clock(m.timestamp)}` : '';
  const where = m.source ? ` (${m.source})` : '';
  const lines = [`${m.level}${time} ${first}${where}`];
  const more = rest.filter((l) => l.trim());
  if (m.level !== 'error') return [...lines, ...more.map((l) => `    ${l.trim()}`)];
  const frames = m.stack?.length ? m.stack : more.filter((l) => FRAME.test(l));
  lines.push(...more.filter((l) => !FRAME.test(l)).map((l) => `    ${l.trim()}`));
  lines.push(...frames.slice(0, STACK_LINES).map((f) => `  ${f.trim().slice(0, STACK_LINE_MAX)}`));
  return lines;
}

// --- network lines ----------------------------------------------------------

const errorName = (error) => String(error).replace(/^net::/, '');
const typeName = (type) => TYPE_NAMES[type] || type || 'other';
const shortUrl = (url) => (url.length > URL_MAX ? `${url.slice(0, URL_MAX - 1)}…` : url);

/** Response size from its Content-Length header (decimal kB, as Chrome's network panel shows). */
function sizeOf(entry) {
  const header = entry.responseHeaders?.find((h) => h.name.toLowerCase() === 'content-length');
  const n = Number(header?.value);
  if (!header || !Number.isFinite(n) || n < 0) return '';
  if (n < 1000) return `${n}B`;
  return n < 1_000_000 ? `${(n / 1000).toFixed(1)}kB` : `${(n / 1_000_000).toFixed(1)}MB`;
}

/** `r17 GET 200 xhr 1.2kB 120ms https://…`: failed requests show their error instead of the status. */
function networkLine(r) {
  const outcome = r.error ? errorName(r.error) : (r.status ?? '-');
  const parts = [`r${r.id}`, r.method || 'GET', outcome, typeName(r.type)];
  const size = sizeOf(r);
  if (size) parts.push(size);
  if (typeof r.durationMs === 'number') parts.push(`${r.durationMs}ms`);
  parts.push(shortUrl(String(r.url)));
  return parts.join(' ');
}

const isFailed = (r) => !!r.error || (typeof r.status === 'number' && r.status >= 400);

// --- one request in full ----------------------------------------------------

const headerLine = (h) => `  ${h.name}: ${h.value}`;

function payloadLine(p) {
  if (p.kind === 'form') {
    const pairs = Object.entries(p.fields).flatMap(([key, values]) => values.map((v) => `${key}=${v}`));
    return `payload (form): ${pairs.join('&')}`;
  }
  if (p.kind === 'raw') {
    const files = p.files ? `, ${p.files} file part(s) not read` : '';
    return `payload (${p.size} bytes${p.truncated ? ', preview cut' : ''}${files}): ${p.preview}`;
  }
  if (p.kind === 'binary') return `payload: binary, ${p.size} bytes (not shown)`;
  return `payload: ${p.files} file part(s), not read`;
}

function bodyLines(b) {
  if (b.unavailable) return [`response body: ${b.unavailable}`];
  if (b.tooLarge) return ['response body: over 5 MB, not read'];
  if (b.binary) return [`response body: binary, ${b.length} bytes (not shown)`];
  if (b.error) return [`response body: unavailable (${b.error})`];
  if (b.text === undefined) return ['response body: none'];
  const shown = b.truncated ? ` of ${b.length}` : '';
  const redacted = b.redacted ? ', secrets redacted' : '';
  return [`response body (${b.text.length}${shown} chars${redacted}):`, b.text];
}

/** The body of a captured request, or why there is none. */
function responseBodyOf(capture, entry) {
  const body = capture?.bodies.find(entry);
  if (body) return body;
  if (!capture) return { unavailable: 'capture is off: call browser_logs with bodies:true, then repeat the request' };
  return { unavailable: `not captured: only document, xhr and fetch responses that start while capture is on are kept (the newest ${MAX_BODIES})` };
}

async function requestDetail(tabId, requestId, bodies) {
  const id = String(requestId).replace(/^r/, '');
  const hit = [...getTabBuffer(networkByTab, tabId)].reverse().find((r) => r.id === id);
  if (!hit) throw new Error(`NOT_FOUND: request ${requestId} (only the latest ${PER_TAB_CAP} requests of a tab are kept; list them first)`);
  if (bodies === true) await startBodyCapture(tabId);
  const capture = bodyCaptureByTab.get(tabId);
  const responseBody = hit.error ? undefined : responseBodyOf(capture, hit);
  const request = { ...hit, ...(responseBody ? { responseBody } : {}) };
  const lines = [`r${hit.id} ${hit.method || 'GET'} ${hit.url}`];
  lines.push(hit.error ? `error: ${errorName(hit.error)}` : `status: ${hit.status ?? '-'}`);
  lines.push(`type: ${typeName(hit.type)}`);
  if (typeof hit.durationMs === 'number') lines.push(`timing: ${hit.durationMs}ms`);
  if (hit.requestHeaders?.length) lines.push('request headers:', ...hit.requestHeaders.map(headerLine));
  if (hit.responseHeaders?.length) lines.push('response headers:', ...hit.responseHeaders.map(headerLine));
  if (hit.requestBody) lines.push(payloadLine(hit.requestBody));
  if (responseBody) lines.push(...bodyLines(responseBody));
  const state = capture || bodies !== undefined ? { bodyCapture: captureState(tabId) } : {};
  return { success: true, text: lines.join('\n'), request, ...state };
}

// --- the handler ------------------------------------------------------------

/** One section: `console (N):` with N entries, then its lines, then a note when the limit cut older ones. */
function section(name, rows, hidden, limit) {
  const lines = rows.flat();
  const note = hidden > 0 ? [`… ${hidden} older not shown (limit ${limit}; raise limit or narrow with filter)`] : [];
  return [`${name} (${rows.length}):`, ...lines, ...note];
}

export async function handleLogs(params = {}) {
  const { tabId, kind, filter = '', errors = false, clear = false, requestId, bodies } = params;
  const limit = params.limit ?? DEFAULT_LIMIT;
  checkParams({ kind, filter, limit, clear, bodies, requestId });
  await resolveTab(tabId);
  if (requestId != null) return requestDetail(tabId, requestId, bodies);

  if (bodies === true) await startBodyCapture(tabId);
  else if (bodies === false) stopBodyCapture(tabId);

  const needle = filter.toLowerCase();
  const want = { console: !kind || kind === 'console', network: !kind || kind === 'network' };
  const sections = [];
  const out = {};

  if (want.console) {
    const all = await withDebugger(tabId, (send) => collectPageConsole(
      send,
      (fn) => subscribeCdpEvents(tabId, fn),
      { clear, levels: errors ? ERROR_LEVELS : null, max: CONSOLE_SCAN },
    ));
    const matched = all.filter((m) => !needle || m.text.toLowerCase().includes(needle));
    const picked = matched.slice(-limit);
    sections.push(section('console', picked.map((m) => consoleLines(m)), matched.length - picked.length, limit));
    out.messages = picked;
  }

  if (want.network) {
    const capture = bodyCaptureByTab.get(tabId);
    const matched = [...getTabBuffer(networkByTab, tabId)]
      .filter((r) => (!needle || String(r.url).toLowerCase().includes(needle)) && (!errors || isFailed(r)));
    const picked = matched.slice(-limit);
    sections.push(section('network', picked.map((r) => [networkLine(r)]), matched.length - picked.length, limit));
    out.requests = picked.map((r) => {
      const hasBody = capture?.bodies.size ? capture.bodies.find(r)?.text !== undefined : false;
      return { ...listView(r, { fullUrls: true }), ...(hasBody ? { hasBody: true } : {}) };
    });
    if (clear) {
      networkByTab.set(tabId, []);
      bodyCaptureByTab.get(tabId)?.bodies.clear();
    }
  }

  const notes = [];
  if (bodies === true) notes.push(`response bodies: capture on for tab ${tabId}. Repeat the request, then read its body: browser_logs { tabId, requestId }.`);
  else if (bodies === false) notes.push(`response bodies: capture off for tab ${tabId}.`);
  const state = bodies !== undefined || bodyCaptureByTab.has(tabId) ? { bodyCapture: captureState(tabId) } : {};
  return { success: true, text: [...sections.flat(), ...notes].join('\n'), ...out, ...state };
}
