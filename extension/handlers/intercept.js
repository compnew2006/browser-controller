/**
 * Intercept handler: rule CRUD + capture ledger + HAR export.
 *
 * Rules belong to a scope: the tab a set-rules call targets (`tabs:<id>`), a
 * rule set whose every rule names its own tabIds (`rules:<ids>`), or every tab
 * of the browser when the caller passes global:true. A rule Chrome can express
 * is enforced with a declarativeNetRequest SESSION rule; a rule it cannot
 * express (mock, log) is recorded in the capture ledger and reported under
 * `unsupported`. Without DNR (tests, denied permission) everything reports
 * enforcement:'capture-only'.
 *
 * Stored rules are mirrored to chrome.storage.session, so a service-worker
 * restart restores them and re-syncs the DNR rules Chrome kept: memory and
 * Chrome never disagree.
 */
import { resolveTab } from "../lib/page-exec.js";
import { getTabBuffer, networkByTab, PER_TAB_CAP } from "../lib/state.js";
import { validateRuleSet, matchRule, scopeKey } from "../lib/intercept.js";
import { resolveTypes } from "../lib/resource-types.js";

/** scopeKey -> rules[] */
export const rulesByScope = new Map();
/** tabId -> enriched capture entries (capped) */
export const interceptLedgerByTab = new Map();

// Privacy note: captures store method/url/status/type/timestamp (+ intercept
// metadata) only — headers and bodies are never captured, so HAR export is
// redacted by omission (response._redacted: true marks this guarantee).

const STORAGE_KEY = "bcInterceptRules";
const ENFORCEABLE = new Set(["block", "redirect", "header"]);
const RECORDED_ONLY = {
  log: "recorded only: log rules capture matches and change no traffic",
  mock: "recorded only: Chrome cannot fake a response body, so mock rules never answer a request",
};

/** Resolves once stored rules are restored and synced with Chrome (initIntercept). */
let ready = Promise.resolve();
/** Rule changes run one at a time: each reads and rewrites the whole rule set. */
let queue = Promise.resolve();

/** Our session-rule id range (other extension code may use other ids). */
const DNR_ID_BASE = 1000;
const DNR_ID_MAX = 5999;

/**
 * Result of the last sync: which stored rules Chrome actually enforces.
 * installed: Map<"scope|ruleId", dnrId>; unsupported: [{id, scope, action, reason}].
 */
let lastSync = { enforcement: "capture-only", installed: new Map(), unsupported: [], reason: "not synced" };

/** Tab ids a stored scope owns (null = not tied to one tab). */
function scopeTabs(scope) {
  const match = /^tabs:(\d+)$/.exec(scope);
  return match ? [Number(match[1])] : null;
}

/** Tab ids one stored rule applies to: its own tabIds win over the scope's tab; null = every tab. */
function ruleTabs(scope, rule) {
  if (rule.tabIds && rule.tabIds.length) return [...new Set(rule.tabIds)];
  return scopeTabs(scope);
}

/** Rules that apply to a tab, each with the scope it is stored under. */
function scopedRulesForTab(tabId) {
  const out = [];
  for (const [scope, rules] of rulesByScope) {
    for (const rule of rules) {
      const tabs = ruleTabs(scope, rule);
      if (tabs === null || tabs.includes(tabId)) out.push({ scope, rule });
    }
  }
  return out;
}

/** What Chrome enforces right now (capture-only without DNR). */
function currentEnforcement() {
  if (!dnrAvailable()) return "capture-only";
  return rulesByScope.size === 0 ? "full" : lastSync.enforcement;
}

function dnrAvailable() {
  try {
    return !!globalThis.chrome?.declarativeNetRequest?.updateSessionRules;
  } catch {
    return false;
  }
}

/** One stored rule → a DNR session rule, or {reason} when Chrome can't enforce it. */
function toDnrRule(rule, scope, id) {
  // Case-sensitive, like the ledger's RegExp: DNR matches case-insensitively by default.
  const condition = { regexFilter: rule.match, isUrlFilterCaseSensitive: true };
  const tabs = ruleTabs(scope, rule);
  if (tabs) condition.tabIds = tabs; // tab scoping: session rules only
  if (rule.types && rule.types.length) condition.resourceTypes = rule.types;
  if (rule.action === "block") return { rule: { id, priority: 1, action: { type: "block" }, condition } };
  if (rule.action === "redirect") {
    return { rule: { id, priority: 1, action: { type: "redirect", redirect: { url: rule.redirectUrl } }, condition } };
  }
  if (rule.action === "header") {
    const headers = Object.entries(rule.headers || {});
    if (headers.length === 0) return { reason: "header rule has no headers" };
    return {
      rule: {
        id, priority: 1, condition,
        action: {
          type: "modifyHeaders",
          // Request headers are set (added or replaced) on matching requests.
          requestHeaders: headers.map(([header, value]) => ({ header, operation: "set", value: String(value) })),
        },
      },
    };
  }
  return { reason: `action ${rule.action} is not enforceable` };
}

/** Which stored rules become DNR rules, which are recorded only, and the rules themselves. */
function planDnr() {
  const installed = new Map();
  const unsupported = [];
  const addRules = [];
  let next = DNR_ID_BASE;
  for (const [scope, rules] of rulesByScope) {
    for (const r of rules) {
      if (r.enabled === false) continue;
      if (!ENFORCEABLE.has(r.action)) {
        unsupported.push({ id: r.id, scope, action: r.action, reason: RECORDED_ONLY[r.action] });
        continue;
      }
      if (next > DNR_ID_MAX) {
        unsupported.push({ id: r.id, scope, action: r.action, reason: "too many rules to enforce" });
        continue;
      }
      const out = toDnrRule(r, scope, next);
      if (!out.rule) {
        unsupported.push({ id: r.id, scope, action: r.action, reason: out.reason });
        continue;
      }
      addRules.push(out.rule);
      installed.set(`${scope}|${r.id}`, next);
      next++;
    }
  }
  return { installed, unsupported, addRules };
}

/**
 * Make Chrome's session rules match rulesByScope: remove every session rule in
 * our id range (including stale ones from an earlier worker), then add the
 * current set in one call, which Chrome applies atomically. Throws when Chrome
 * refuses the set; the caller restores its previous state.
 */
async function syncDnr() {
  const { installed, unsupported, addRules } = planDnr();
  if (!dnrAvailable()) {
    lastSync = { enforcement: "capture-only", installed: new Map(), unsupported, reason: "no-dnr" };
    return lastSync;
  }
  const dnr = globalThis.chrome.declarativeNetRequest;
  try {
    const existing = (await dnr.getSessionRules()) || [];
    const removeRuleIds = existing.map((x) => x.id).filter((id) => id >= DNR_ID_BASE && id <= DNR_ID_MAX);
    await dnr.updateSessionRules({ removeRuleIds, addRules });
  } catch (err) {
    throw new Error(`DNR_REJECTED: Chrome refused the rules (${err?.message || err}); nothing was changed.`, { cause: err });
  }
  lastSync = {
    enforcement: unsupported.length ? "partial" : "full",
    installed,
    unsupported,
    reason: unsupported.length ? "some rules are recorded only (see unsupported)" : undefined,
  };
  return lastSync;
}

/**
 * Rules Chrome's RE2 engine rejects (lookaround, backreferences…), checked
 * before anything is stored. Without isRegexSupported nothing can be checked here.
 */
async function rejectedRegexes(rules) {
  const dnr = globalThis.chrome?.declarativeNetRequest;
  if (typeof dnr?.isRegexSupported !== "function") return [];
  const rejected = [];
  for (const r of rules) {
    if (r.enabled === false || !ENFORCEABLE.has(r.action)) continue;
    try {
      const { isSupported, reason } = await dnr.isRegexSupported({ regex: r.match, isCaseSensitive: true });
      if (!isSupported) rejected.push({ id: r.id, match: r.match, reason: reason || "unsupported" });
    } catch (err) {
      // One rule's check failing must not hide the others' results.
      rejected.push({ id: r.id, match: r.match, reason: err?.message || String(err) });
    }
  }
  return rejected;
}

/**
 * Swap in a new rule set, sync Chrome and persist it. If Chrome refuses the
 * set, the previous set is put back and the error rethrown.
 */
async function commitRules(next) {
  const previous = new Map(rulesByScope);
  rulesByScope.clear();
  for (const [scope, rules] of next) rulesByScope.set(scope, rules);
  try {
    const sync = await syncDnr();
    persistRules();
    return sync;
  } catch (err) {
    rulesByScope.clear();
    for (const [scope, rules] of previous) rulesByScope.set(scope, rules);
    throw err;
  }
}

function persistRules() {
  try {
    const stored = globalThis.chrome?.storage?.session?.set({ [STORAGE_KEY]: [...rulesByScope] });
    Promise.resolve(stored).catch(() => {});
  } catch {
    // Storage unavailable: the rules last until the worker restarts (then the DNR rules are removed on init).
  }
}

/**
 * Startup (called by events.js): restore the stored rule set and sync Chrome to it.
 * If storage is empty, stale DNR rules from an earlier worker are removed; if Chrome
 * refuses the restored set, both sides end up empty. Never rejects.
 */
async function restoreRules() {
  let stored;
  try {
    stored = (await globalThis.chrome?.storage?.session?.get(STORAGE_KEY))?.[STORAGE_KEY];
  } catch {
    stored = undefined;
  }
  rulesByScope.clear();
  if (Array.isArray(stored)) {
    for (const [scope, rules] of stored) {
      if (typeof scope === "string" && Array.isArray(rules) && rules.length) rulesByScope.set(scope, rules);
    }
  }
  try {
    await syncDnr();
  } catch {
    rulesByScope.clear();
    await syncDnr().catch(() => {});
  }
}

/** Start restoring rules at worker startup; rule calls wait for it. */
export function initIntercept() {
  ready = restoreRules();
  queue = ready;
  return ready;
}

/** Run one rule change after the previous one has finished. */
function serialized(fn) {
  const run = queue.then(fn);
  queue = run.catch(() => {});
  return run;
}

/** Is this stored rule actually installed in Chrome? */
function isEnforced(scope, ruleId) {
  return lastSync.installed.has(`${scope}|${ruleId}`);
}

/**
 * Enrich one network capture with rule matches (called from events.js for each
 * finished request, failed ones included; never throws). Returns the annotated
 * copy: the network buffer keeps the plain network entry.
 */
export function enrichCapture(tabId, entry) {
  try {
    const req = { url: entry.url, type: entry.type, tabId };
    const matches = scopedRulesForTab(tabId).filter((x) => matchRule(x.rule, req));
    if (matches.length === 0) return entry;
    const annotated = {
      ...entry,
      intercept: {
        matchedRuleIds: matches.map((m) => m.rule.id),
        applied: matches.map((m) => ({
          ruleId: m.rule.id,
          // "enforced" only when Chrome really has the rule installed.
          outcome: isEnforced(m.scope, m.rule.id) ? "enforced" : "ledger-only",
        })),
      },
    };
    const ledger = getTabBuffer(interceptLedgerByTab, tabId);
    ledger.push({ ...annotated, timestamp: entry.timestamp ?? Date.now() });
    if (ledger.length > PER_TAB_CAP)
      ledger.splice(0, ledger.length - PER_TAB_CAP);
    return annotated;
  } catch {
    return entry;
  }
}

function captureKey(e) {
  return `${e.method || "GET"}|${e.url}|${e.status ?? 0}|${e.timestamp ?? 0}`;
}

/**
 * All captures for a tab, deduplicated. A matched request is in the network
 * buffer AND in the ledger (as its annotated copy): the buffer entry is returned
 * in its place, so each request appears once and carries its intercept fields.
 * Ledger entries whose buffer entry is gone are kept.
 */
export function collectCaptures(tabId) {
  const buffered = getTabBuffer(networkByTab, tabId);
  const ledger = interceptLedgerByTab.get(tabId) ?? [];
  const annotated = new Map(ledger.map((e) => [captureKey(e), e]));
  const seen = new Set();
  const out = buffered.map((e) => {
    const key = captureKey(e);
    seen.add(key);
    return annotated.get(key) ?? e;
  });
  for (const e of ledger) {
    const key = captureKey(e);
    if (!seen.has(key)) {
      seen.add(key);
      out.push(e);
    }
  }
  return out;
}

function filterByPattern(entries, filter) {
  if (!filter) return entries;
  let re;
  try {
    re = new RegExp(filter);
  } catch (err) {
    throw new Error(`Invalid filter regex: ${err?.message || err}`, { cause: err });
  }
  return entries.filter((e) => re.test(e.url));
}

/** Captures for one tab, narrowed by the URL regex and to the latest `limit` (list-captures and export-har). */
function selectCaptures(tabId, filter, limit) {
  const entries = filterByPattern(collectCaptures(tabId), filter);
  return limit && Number.isInteger(limit) && limit > 0 ? entries.slice(-limit) : entries;
}

/** The running extension's version (manifest), reported as the HAR creator version. */
function extensionVersion() {
  try {
    return globalThis.chrome?.runtime?.getManifest?.()?.version || "unknown";
  } catch {
    return "unknown";
  }
}

function buildHar(tabId, entries) {
  // Headers come from the capture already redacted (lib/network-capture.js).
  const harEntries = entries.map((e) => ({
    startedDateTime: new Date(e.timestamp ?? Date.now()).toISOString(),
    time: e.durationMs ?? 0,
    request: { method: e.method || "GET", url: e.url, headers: e.requestHeaders ?? [] },
    response: { status: e.status ?? 0, headers: e.responseHeaders ?? [], _redacted: true },
    timings: { wait: e.durationMs ?? 0 },
    _intercept: e.intercept ?? null,
  }));
  return {
    log: {
      version: "1.2",
      creator: { name: "browser-controller", version: extensionVersion() },
      pages: [{ id: `tab-${tabId}`, title: `Tab ${tabId}` }],
      entries: harEntries,
    },
  };
}

/** The scope a set-rules call owns, or {error} when the call does not say where its rules apply. */
function scopeForCall({ tabId, global, incoming }) {
  if (tabId != null && global === true) {
    return { error: "INVALID_ARGUMENT: pass either tabId or global:true, not both." };
  }
  const untargeted = tabId == null && global !== true
    && (incoming.length === 0 || incoming.some((r) => !(r.tabIds && r.tabIds.length)));
  if (untargeted) {
    return {
      error: "TAB_REQUIRED: set-rules needs tabId (the tab to act on), tabIds on every rule, or global:true to apply to every tab of the browser, including the user's own tabs.",
    };
  }
  if (tabId != null) return { scope: scopeKey([tabId]) };
  if (global === true) return { scope: "global" };
  const ids = [...new Set(incoming.flatMap((r) => r.tabIds))].sort((a, b) => a - b);
  return { scope: `rules:${ids.join(",")}` };
}

async function setRules({ tabId, rules, global }) {
  validateRuleSet(rules ?? []);
  const incoming = (rules ?? []).map((r, i) => ({
    enabled: true,
    ...r,
    id: r.id ?? `r${i + 1}`,
    ...(r.types ? { types: resolveTypes(r.types) } : {}),
  }));
  const { scope, error } = scopeForCall({ tabId, global, incoming });
  if (error) return { success: false, error };
  // All or nothing: one invalid regex stops the whole call, so no partial rule set is ever left behind.
  const rejected = await rejectedRegexes(incoming);
  if (rejected.length) {
    const list = rejected.map((r) => `${r.id} (${r.reason})`).join(", ");
    return {
      success: false,
      error: `INVALID_REGEX: Chrome's rule engine rejected ${list}. It uses RE2 (no lookahead or backreferences). No rule was changed.`,
      rejected,
    };
  }
  const next = new Map(rulesByScope);
  if (incoming.length) next.set(scope, incoming);
  else next.delete(scope);
  const sync = await commitRules(next);
  const unsupported = sync.unsupported.filter((u) => u.scope === scope);
  return {
    success: true,
    enforcement: sync.enforcement,
    ...(sync.reason ? { reason: sync.reason } : {}),
    scope,
    ruleCount: incoming.length,
    enforced: incoming.filter((r) => isEnforced(scope, r.id)).length,
    ...(unsupported.length ? { unsupported } : {}),
  };
}

async function clearRules(tabId) {
  const next = new Map();
  let cleared = 0;
  for (const [scope, rules] of rulesByScope) {
    // With a tab: drop the rules that target it. Global rules are not tab-scoped and stay.
    const kept = tabId == null
      ? []
      : rules.filter((rule) => {
        const tabs = ruleTabs(scope, rule);
        return tabs === null || !tabs.includes(tabId);
      });
    cleared += rules.length - kept.length;
    if (kept.length) next.set(scope, kept);
  }
  await commitRules(next);
  return tabId == null
    ? { success: true, cleared }
    : { success: true, cleared, note: "global rules retained; omit tabId to clear all" };
}

export async function handleIntercept(params) {
  const { action, tabId, rules, filter, limit, global } = params;
  await ready;
  switch (action) {
    case "set-rules":
      return serialized(() => setRules({ tabId, rules, global }));
    case "list-rules": {
      const scoped = tabId != null
        ? scopedRulesForTab(tabId)
        : [...rulesByScope].flatMap(([scope, scopeRules]) => scopeRules.map((rule) => ({ scope, rule })));
      return {
        success: true,
        enforcement: currentEnforcement(),
        rules: scoped.map(({ scope, rule }) => ({ ...rule, scope, enforced: isEnforced(scope, rule.id) })),
      };
    }
    case "clear-rules":
      return serialized(() => clearRules(tabId));
    case "list-captures": {
      if (tabId == null) throw new Error("tabId required for list-captures");
      await resolveTab(tabId);
      return {
        success: true,
        enforcement: currentEnforcement(),
        captures: selectCaptures(tabId, filter, limit),
      };
    }
    case "export-har": {
      if (tabId == null) throw new Error("tabId required for export-har");
      await resolveTab(tabId);
      const har = buildHar(tabId, selectCaptures(tabId, filter, limit));
      return { success: true, entries: har.log.entries.length, har };
    }
    default:
      throw new Error(`Unknown intercept action: ${action}`);
  }
}
