/**
 * browser_mock: fake answers for one tab's requests (CDP Fetch domain, tab-scoped only).
 * `rules` replaces the tab's set: a request matching a rule is failed (block) or answered
 * with its status, body and headers; every other request continues unchanged. The rules
 * stay in the worker, but they are enforced only while the tab's debugger session lives:
 * when the user closes the debugger banner the rules are kept and listed as inactive.
 */
import { resolveTab } from '../lib/page-exec.js';
import { withCdp, subscribeCdpEvents, pinCdp, unpinCdp, isCdpPinned } from '../lib/cdp-session.js';
import { mockByTab } from '../lib/state.js';

export const MAX_MOCK_RULES = 50;
export const MAX_MOCK_BODY = 20_000;
const PIN = 'browser-mock';

const invalid = (message) => new Error(`INVALID_ARGUMENT: ${message}`);
const countOf = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

function parseRule(rule, i) {
  const at = `rules[${i}]`;
  if (!rule || typeof rule !== 'object' || Array.isArray(rule)) throw invalid(`${at} must be an object`);
  const { match, block = false, status, body, headers } = rule;
  if (typeof match !== 'string' || match === '') throw invalid(`${at}.match must be a non-empty string`);
  if (typeof block !== 'boolean') throw invalid(`${at}.block must be true or false`);
  if (block && (status !== undefined || body !== undefined || headers !== undefined)) {
    throw invalid(`${at}: block:true takes no status, body or headers`);
  }
  if (status !== undefined && !(Number.isInteger(status) && status >= 100 && status <= 599)) {
    throw invalid(`${at}.status must be an HTTP status code (100-599)`);
  }
  if (body !== undefined && (typeof body !== 'string' || body.length > MAX_MOCK_BODY)) {
    throw invalid(`${at}.body must be a string of at most ${MAX_MOCK_BODY} chars`);
  }
  const plainHeaders = headers === undefined || (headers && typeof headers === 'object' && !Array.isArray(headers));
  if (!plainHeaders || Object.values(headers ?? {}).some((v) => typeof v !== 'string')) {
    throw invalid(`${at}.headers must map header names to string values`);
  }
  return { match, block, status: status ?? 200, body: body ?? '', headers: headers ?? {}, hits: 0 };
}

/** The rule set a call asks for, validated whole: one bad rule stops the call before anything changes. */
function parseRules(rules) {
  if (!Array.isArray(rules)) throw invalid('rules must be an array of {match, block?, status?, body?, headers?}');
  if (rules.length > MAX_MOCK_RULES) throw invalid(`${rules.length} rules; the limit is ${MAX_MOCK_RULES} per tab`);
  return rules.map(parseRule);
}

function base64Utf8(text) {
  let bin = '';
  for (const byte of new TextEncoder().encode(text)) bin += String.fromCharCode(byte);
  return btoa(bin);
}

function looksLikeJson(text) {
  if (!/^\s*[[{]/.test(text)) return false;
  try { JSON.parse(text); return true; } catch { return false; }
}

/**
 * Fetch.fulfillRequest params for an answer {status, body, headers} and the paused request:
 * the answer's headers are the response headers, a cross-origin caller is
 * allowed (its Origin echoed), and the CORS preflight Chrome sends before a
 * non-simple cross-origin request is answered too — it pauses like the request.
 */
export function fulfillParams({ status, body, headers } = {}, request) {
  const text = body ?? '';
  const sent = Object.entries(request.headers || {});
  const get = (name) => sent.find(([k]) => k.toLowerCase() === name)?.[1];
  const custom = Object.entries(headers || {}).map(([name, value]) => ({ name, value: String(value) }));
  const has = (name) => custom.some((h) => h.name.toLowerCase() === name);
  const origin = get('origin');
  const cors = origin && !has('access-control-allow-origin')
    ? [{ name: 'Access-Control-Allow-Origin', value: origin }, { name: 'Access-Control-Allow-Credentials', value: 'true' }]
    : [];
  // A cross-origin page only sees the mock's own headers when they are exposed.
  if (cors.length && custom.length && !has('access-control-expose-headers')) {
    cors.push({ name: 'Access-Control-Expose-Headers', value: custom.map((h) => h.name).join(', ') });
  }
  const preflightMethod = request.method === 'OPTIONS' && get('access-control-request-method');
  if (preflightMethod) {
    const asked = get('access-control-request-headers');
    return {
      responseCode: 204,
      responseHeaders: [...cors, ...custom.filter((h) => /^access-control-/i.test(h.name)),
        ...(has('access-control-allow-methods') ? [] : [{ name: 'Access-Control-Allow-Methods', value: preflightMethod }]),
        ...(asked && !has('access-control-allow-headers') ? [{ name: 'Access-Control-Allow-Headers', value: asked }] : [])],
    };
  }
  const type = has('content-type') ? [] : [{ name: 'Content-Type', value: looksLikeJson(text) ? 'application/json' : 'text/plain; charset=utf-8' }];
  return { responseCode: status ?? 200, responseHeaders: [...type, ...cors, ...custom], body: base64Utf8(text) };
}

/**
 * URL pattern of a mock rule: with a `*` it is a glob over the whole URL (`*` is any run of
 * characters, nothing else is special); without one it is a case-sensitive substring.
 */
export function urlMatches(pattern, url) {
  if (!pattern.includes('*')) return url.includes(pattern);
  // Two-pointer wildcard match: linear in practice, no regex, so no backtracking blow-up on long URLs.
  let p = 0;
  let t = 0;
  let star = -1;
  let resume = 0;
  while (t < url.length) {
    if (p < pattern.length && pattern[p] === '*') { star = p++; resume = t; }
    else if (p < pattern.length && pattern[p] === url[t]) { p++; t++; }
    else if (star !== -1) { p = star + 1; t = ++resume; }
    else return false;
  }
  while (p < pattern.length && pattern[p] === '*') p++;
  return p === pattern.length;
}

function mockActive(tabId) {
  return !!mockByTab.get(tabId)?.off && isCdpPinned(tabId, PIN);
}

/** Answer one paused request: the first matching rule decides; a request nothing matches goes on. */
async function answer(tabId, send, paused) {
  const rule = mockByTab.get(tabId)?.rules.find((r) => urlMatches(r.match, paused.request?.url ?? ''));
  if (rule) {
    try {
      if (rule.block) await send('Fetch.failRequest', { requestId: paused.requestId, errorReason: 'BlockedByClient' });
      else await send('Fetch.fulfillRequest', { requestId: paused.requestId, ...fulfillParams(rule, paused.request) });
      rule.hits++;
      return;
    } catch { /* the real request goes ahead instead */ }
  }
  await send('Fetch.continueRequest', { requestId: paused.requestId }).catch(() => {});
}

/**
 * Start Fetch interception on the tab (every request pauses: Chrome cannot filter a CORS
 * preflight by type, and a rule must answer it too). Any failure, attach or enable, is
 * DEBUGGER_UNAVAILABLE and leaves the stored rules as they were.
 */
async function attachMock(tabId) {
  if (mockActive(tabId)) return;
  const prior = mockByTab.get(tabId);
  prior?.off?.(); // a subscription left by a session the user closed
  try {
    await withCdp(tabId, async (send) => {
      const off = subscribeCdpEvents(tabId, (method, params) => {
        if (method !== 'Fetch.requestPaused') return false;
        answer(tabId, send, params);
        return true;
      });
      try {
        await send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] });
      } catch (err) {
        off();
        throw err;
      }
      pinCdp(tabId, PIN);
      mockByTab.set(tabId, { rules: prior?.rules ?? [], off, send });
    });
  } catch (err) {
    throw new Error(`DEBUGGER_UNAVAILABLE: cannot intercept requests on tab ${tabId} (${err?.message || err}); no rules were stored.`, { cause: err });
  }
}

/**
 * Stop interception and forget the tab's rules: `rules: []`, the session that set them
 * being released (releaseSession), or the tab closing.
 */
export function releaseMock(tabId) {
  const entry = mockByTab.get(tabId);
  mockByTab.delete(tabId);
  if (!entry) return;
  entry.off?.();
  if (isCdpPinned(tabId, PIN)) entry.send('Fetch.disable').catch(() => {});
  unpinCdp(tabId, PIN);
}

function summaryOf(rules) {
  return rules.map(({ match, block, status, hits }) => ({ match, block, status: block ? undefined : status, hits }));
}

function listRules(tabId) {
  const rules = mockByTab.get(tabId)?.rules ?? [];
  if (rules.length === 0) return { success: true, text: `no rules on tab ${tabId}`, tabId, active: false, rules: [] };
  const active = mockActive(tabId);
  const head = active
    ? `${countOf(rules.length, 'rule')} active on tab ${tabId}:`
    : `inactive (debugger detached): ${countOf(rules.length, 'rule')} on tab ${tabId}, not applied:`;
  const lines = rules.map((r, i) => `${i + 1}. ${r.match} → ${r.block ? 'blocked' : r.status} (${countOf(r.hits, 'hit')})`);
  return { success: true, text: [head, ...lines].join('\n'), tabId, active, rules: summaryOf(rules) };
}

export async function handleMock(params = {}) {
  const { tabId, rules } = params;
  await resolveTab(tabId);
  if (rules === undefined) return listRules(tabId);
  const next = parseRules(rules);
  if (next.length === 0) {
    releaseMock(tabId);
    return { success: true, text: `cleared: no rules on tab ${tabId}`, tabId, active: false, rules: [] };
  }
  await attachMock(tabId);
  mockByTab.get(tabId).rules = next;
  return { success: true, text: `${countOf(next.length, 'rule')} active on tab ${tabId}`, tabId, active: true, rules: summaryOf(next) };
}
