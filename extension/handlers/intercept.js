/**
 * Intercept handler: rule CRUD + capture ledger + HAR export.
 * Enforcement via declarativeNetRequest is best-effort — when DNR is absent
 * (tests, denied permission) every response reports enforcement:'capture-only'
 * and matches are ledger-marked instead of applied (arch ADR-1/ADR-2).
 */
import { resolveTab } from "../lib/page-exec.js";
import { getTabBuffer, networkByTab, PER_TAB_CAP } from "../lib/state.js";
import { validateRuleSet, matchRule, scopeKey } from "../lib/intercept.js";

/** scopeKey -> rules[] */
export const rulesByScope = new Map();
/** tabId -> enriched capture entries (capped) */
export const interceptLedgerByTab = new Map();

// Privacy note: captures store method/url/status/type/timestamp (+ intercept
// metadata) only — headers and bodies are never captured, so HAR export is
// redacted by omission (response._redacted: true marks this guarantee).

function allRules() {
  const out = [];
  for (const rules of rulesByScope.values()) out.push(...rules);
  return out;
}

/** Rules that apply to a tab, each with the scope it is stored under. */
function scopedRulesForTab(tabId) {
  const out = [];
  for (const [scope, rules] of rulesByScope) {
    const ids = scope === "global" ? null : scope.replace(/^tabs:/, "").split(",").map(Number);
    if (ids === null || (tabId != null && ids.includes(tabId))) {
      for (const rule of rules) out.push({ scope, rule });
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

/** Our session-rule id range (other extension code may use other ids). */
const DNR_ID_BASE = 1000;
const DNR_ID_MAX = 5999;
/** Chrome resource types a DNR condition accepts. */
const DNR_TYPES = new Set([
  "main_frame", "sub_frame", "stylesheet", "script", "image", "font", "object",
  "xmlhttprequest", "ping", "csp_report", "media", "websocket", "webtransport", "webbundle", "other",
]);

/**
 * Result of the last sync: which stored rules Chrome actually enforces.
 * installed: Map<"scope|ruleId", dnrId>; unsupported: [{id, scope, action, reason}].
 */
let lastSync = { enforcement: "capture-only", installed: new Map(), unsupported: [], reason: "not synced" };

/** Tab ids a stored scope applies to (null = every tab). */
function scopeTabs(scope) {
  if (scope === "global") return null;
  return [...new Set(scope.replace(/^tabs:/, "").split(",").map(Number).filter(Number.isInteger))];
}

/** One stored rule → a DNR session rule, or {reason} when Chrome can't enforce it. */
function toDnrRule(rule, scope, id) {
  const condition = { regexFilter: rule.match };
  const tabs = rule.tabIds && rule.tabIds.length ? [...new Set(rule.tabIds)] : scopeTabs(scope);
  if (tabs) condition.tabIds = tabs; // tab scoping: session rules only
  if (rule.types && rule.types.length) {
    const types = rule.types.filter((t) => DNR_TYPES.has(t));
    if (types.length === 0) return { reason: `no enforceable resource type in [${rule.types.join(", ")}]` };
    condition.resourceTypes = types;
  }
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
  if (rule.action === "mock") {
    return { reason: "mock responses cannot be enforced with declarativeNetRequest (ledger-only)" };
  }
  return { reason: null }; // log: capture-only by design
}

/**
 * Sync every enabled rule to Chrome as SESSION rules (the only kind that can
 * be tab-scoped): remove every session rule we installed before — including
 * after a clear, or from a previous service worker — then add the current
 * set. Never throws; degrades to capture-only.
 */
async function syncDnr() {
  if (!dnrAvailable()) {
    lastSync = { enforcement: "capture-only", installed: new Map(), unsupported: [], reason: "no-dnr" };
    return lastSync;
  }
  const dnr = globalThis.chrome.declarativeNetRequest;
  const installed = new Map();
  const unsupported = [];
  const addRules = [];
  let next = DNR_ID_BASE;
  for (const [scope, rules] of rulesByScope) {
    for (const r of rules) {
      if (r.enabled === false || r.action === "log") continue;
      if (next > DNR_ID_MAX) {
        unsupported.push({ id: r.id, scope, action: r.action, reason: "too many rules to enforce" });
        continue;
      }
      const out = toDnrRule(r, scope, next);
      if (!out.rule) {
        if (out.reason) unsupported.push({ id: r.id, scope, action: r.action, reason: out.reason });
        continue;
      }
      addRules.push(out.rule);
      installed.set(`${scope}|${r.id}`, next);
      next++;
    }
  }
  try {
    const existing = (await dnr.getSessionRules()) || [];
    const removeRuleIds = existing.map((x) => x.id).filter((id) => id >= DNR_ID_BASE && id <= DNR_ID_MAX);
    await dnr.updateSessionRules({ removeRuleIds, addRules });
    lastSync = {
      enforcement: unsupported.length ? "partial" : "full",
      installed,
      unsupported,
      reason: unsupported.length ? "some rules are ledger-only (see unsupported)" : undefined,
    };
  } catch (err) {
    lastSync = { enforcement: "capture-only", installed: new Map(), unsupported, reason: err?.message || String(err) };
  }
  return lastSync;
}

/** Is this stored rule actually installed in Chrome? */
function isEnforced(scope, ruleId) {
  return lastSync.installed.has(`${scope}|${ruleId}`);
}

/** Enrich one network capture with rule matches (called from events.js; never throws). */
export function enrichCapture(tabId, entry) {
  try {
    const req = { url: entry.url, type: entry.type, tabId };
    const matches = scopedRulesForTab(tabId).filter((x) => matchRule(x.rule, req));
    if (matches.length === 0) return entry;
    entry.intercept = {
      matchedRuleIds: matches.map((m, i) => m.rule.id ?? `r${i + 1}`),
      applied: matches.map((m, i) => ({
        ruleId: m.rule.id ?? `r${i + 1}`,
        // "enforced" only when Chrome really has the rule installed.
        outcome: isEnforced(m.scope, m.rule.id) ? "enforced" : "ledger-only",
      })),
    };
    const ledger = getTabBuffer(interceptLedgerByTab, tabId);
    ledger.push({ ...entry, timestamp: entry.timestamp ?? Date.now() });
    if (ledger.length > PER_TAB_CAP)
      ledger.splice(0, ledger.length - PER_TAB_CAP);
    return entry;
  } catch {
    return entry;
  }
}

function captureKey(e) {
  return `${e.method || "GET"}|${e.url}|${e.status ?? 0}|${e.timestamp ?? 0}`;
}

/**
 * All captures for a tab, deduplicated. enrichCapture mutates the network
 * buffer entry in place AND ledgers a copy, so a naive concat would return
 * every matched request twice. The network buffer is the base; the ledger
 * only contributes entries not already present (e.g. injected in tests or by
 * future capture sources).
 */
export function collectCaptures(tabId) {
  const buffered = getTabBuffer(networkByTab, tabId);
  const seen = new Set(buffered.map(captureKey));
  const extra = (interceptLedgerByTab.get(tabId) ?? []).filter(
    (e) => !seen.has(captureKey(e)),
  );
  return [...buffered, ...extra];
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

/** The running extension's version (manifest), reported as the HAR creator version. */
function extensionVersion() {
  try {
    return globalThis.chrome?.runtime?.getManifest?.()?.version || "unknown";
  } catch {
    return "unknown";
  }
}

function buildHar(tabId, entries) {
  const harEntries = entries.map((e) => ({
    startedDateTime: new Date(e.timestamp ?? Date.now()).toISOString(),
    request: { method: e.method || "GET", url: e.url, headers: [] },
    response: { status: e.status ?? 0, headers: [], _redacted: true },
    timings: { wait: 0 },
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

export async function handleIntercept(params) {
  const { action, tabId, rules, filter, limit } = params;
  switch (action) {
    case "set-rules": {
      validateRuleSet(rules ?? []);
      const withIds = (rules ?? []).map((r, i) => ({
        enabled: true,
        ...r,
        id: r.id ?? `r${i + 1}`,
      }));
      const scope = scopeKey(
        withIds.flatMap((r) => r.tabIds ?? (tabId != null ? [tabId] : [])),
      );
      // Replacing a scope's rules replaces them (an empty set removes the scope).
      if (withIds.length) rulesByScope.set(scope, withIds);
      else rulesByScope.delete(scope);
      const sync = await syncDnr();
      const unsupported = sync.unsupported.filter((u) => u.scope === scope);
      return {
        success: true,
        enforcement: sync.enforcement,
        ...(sync.reason ? { reason: sync.reason } : {}),
        scope,
        ruleCount: withIds.length,
        enforced: withIds.filter((r) => isEnforced(scope, r.id)).length,
        ...(unsupported.length ? { unsupported } : {}),
      };
    }
    case "list-rules": {
      const scoped = tabId != null
        ? scopedRulesForTab(tabId)
        : [...rulesByScope].flatMap(([scope, rules]) => rules.map((rule) => ({ scope, rule })));
      return {
        success: true,
        enforcement: currentEnforcement(),
        rules: scoped.map(({ scope, rule }) => ({ ...rule, scope, enforced: isEnforced(scope, rule.id) })),
      };
    }
    case "clear-rules": {
      if (tabId != null) {
        let cleared = 0;
        for (const [scope, scopeRules] of [...rulesByScope]) {
          if (scope === "global") continue;
          if (scopeTabs(scope).includes(tabId)) {
            cleared += scopeRules.length;
            rulesByScope.delete(scope);
          }
        }
        // Global rules stay (they are not tab-scoped); report honestly.
        await syncDnr();
        return {
          success: true,
          cleared,
          note: "global rules retained; omit tabId to clear all",
        };
      }
      const cleared = allRules().length;
      rulesByScope.clear();
      await syncDnr();
      return { success: true, cleared };
    }
    case "list-captures": {
      if (tabId == null) throw new Error("tabId required for list-captures");
      await resolveTab(tabId);
      let entries = collectCaptures(tabId);
      entries = filterByPattern(entries, filter);
      if (limit && Number.isInteger(limit) && limit > 0)
        entries = entries.slice(-limit);
      return {
        success: true,
        enforcement: currentEnforcement(),
        captures: entries,
      };
    }
    case "export-har": {
      if (tabId == null) throw new Error("tabId required for export-har");
      await resolveTab(tabId);
      const entries = collectCaptures(tabId);
      const har = buildHar(tabId, entries);
      return { success: true, entries: har.log.entries.length, har };
    }
    default:
      throw new Error(`Unknown intercept action: ${action}`);
  }
}
