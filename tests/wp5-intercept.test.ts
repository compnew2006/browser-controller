import { beforeEach, describe, expect, it } from "vitest";

/**
 * WP5 regression tests for browser_intercept: scope ownership (TAB_REQUIRED),
 * RE2 validation, Chrome refusing a set (rollback), resource-type aliases and
 * mock honesty, ledger for blocked requests, and the restore after a worker restart.
 * Stateful declarativeNetRequest + chrome.storage.session mocks.
 */
type DnrRule = { id: number; action: Record<string, unknown>; condition: Record<string, unknown> };
const sessionRules = new Map<number, DnrRule>();
const stored = new Map<string, unknown>();
let refuse: (addRules: DnrRule[]) => string | null = () => null;
let re2Rejects: (regex: string) => boolean = () => false;

(globalThis as unknown as { chrome: unknown }).chrome = {
  tabs: { get: async (id: number) => ({ id, url: "https://x.test/", windowId: 1 }), query: async () => [] },
  scripting: { executeScript: async () => [{ result: null }] },
  storage: {
    session: {
      get: async (key: string) => (stored.has(key) ? { [key]: JSON.parse(JSON.stringify(stored.get(key))) } : {}),
      set: async (items: Record<string, unknown>) => {
        for (const [k, v] of Object.entries(items)) stored.set(k, JSON.parse(JSON.stringify(v)));
      },
    },
  },
  runtime: { getManifest: () => ({ version: "9.9.9" }) },
  declarativeNetRequest: {
    getSessionRules: async () => [...sessionRules.values()],
    updateSessionRules: async ({ removeRuleIds = [], addRules = [] }: { removeRuleIds?: number[]; addRules?: DnrRule[] }) => {
      const why = refuse(addRules);
      if (why) throw new Error(why);
      const next = new Map(sessionRules);
      for (const id of removeRuleIds) next.delete(id);
      for (const r of addRules) {
        if (next.has(r.id)) throw new Error(`Rule with id ${r.id} does not have a unique ID.`);
        next.set(r.id, r);
      }
      sessionRules.clear();
      for (const [id, r] of next) sessionRules.set(id, r);
    },
    isRegexSupported: async ({ regex }: { regex: string }) =>
      re2Rejects(regex) ? { isSupported: false, reason: "syntaxError" } : { isSupported: true },
  },
};

const { handleIntercept, rulesByScope, interceptLedgerByTab, enrichCapture, initIntercept } = await import("../extension/handlers/intercept.js");
const { networkByTab, getTabBuffer } = await import("../extension/lib/state.js");
const { pushNetworkEntry } = await import("../extension/lib/network-capture.js");

function reset() {
  sessionRules.clear();
  stored.clear();
  rulesByScope.clear();
  interceptLedgerByTab.clear();
  networkByTab.clear();
  refuse = () => null;
  re2Rejects = () => false;
}

describe("scope ownership", () => {
  beforeEach(reset);

  it("set-rules without tabId, tabIds or global fails with TAB_REQUIRED and changes nothing", async () => {
    const res = await handleIntercept({ action: "set-rules", rules: [{ match: "https://ads\\.test/", action: "block" }] });
    expect(res).toMatchObject({ success: false });
    expect(res.error).toMatch(/^TAB_REQUIRED/);
    expect(rulesByScope.size).toBe(0);
    expect(sessionRules.size).toBe(0);
  });

  it("read-only actions keep working without tabId", async () => {
    expect(await handleIntercept({ action: "list-rules" })).toMatchObject({ success: true, rules: [] });
    expect(await handleIntercept({ action: "clear-rules" })).toMatchObject({ success: true, cleared: 0 });
  });

  it("global:true applies the rule to every tab and reports the global scope", async () => {
    const res = await handleIntercept({ action: "set-rules", global: true, rules: [{ id: "g", match: "https://ads\\.test/", action: "block" }] });
    expect(res).toMatchObject({ success: true, enforcement: "full", scope: "global", enforced: 1 });
    expect([...sessionRules.values()][0].condition).not.toHaveProperty("tabIds");
    const listed = await handleIntercept({ action: "list-rules", tabId: 15 });
    expect(listed.rules.map((r: { id: string }) => r.id)).toEqual(["g"]);
  });

  it("global:true combined with tabId is refused", async () => {
    const res = await handleIntercept({ action: "set-rules", tabId: 15, global: true, rules: [{ match: "https://ads\\.test/", action: "block" }] });
    expect(res).toMatchObject({ success: false });
    expect(res.error).toMatch(/^INVALID_ARGUMENT/);
    expect(rulesByScope.size).toBe(0);
  });

  it("rules that each name their own tabIds need no tabId", async () => {
    const res = await handleIntercept({ action: "set-rules", rules: [{ id: "t", match: "https://ads\\.test/", action: "block", tabIds: [15] }] });
    expect(res).toMatchObject({ success: true, scope: "rules:15" });
    expect([...sessionRules.values()][0].condition).toMatchObject({ tabIds: [15] });
  });

  it("a tabless call with one rule lacking tabIds still needs global", async () => {
    const res = await handleIntercept({
      action: "set-rules",
      rules: [{ match: "https://a\\.test/", action: "block", tabIds: [15] }, { match: "https://b\\.test/", action: "block" }],
    });
    expect(res.error).toMatch(/^TAB_REQUIRED/);
  });

  it("a call for one tab cannot overwrite the rules another tab owns", async () => {
    await handleIntercept({ action: "set-rules", tabId: 1, rules: [{ id: "a", match: "https://a\\.test/", action: "block" }] });
    await handleIntercept({ action: "set-rules", tabId: 5, rules: [{ id: "b", match: "https://b\\.test/", action: "block", tabIds: [1] }] });
    const tab1 = await handleIntercept({ action: "list-rules", tabId: 1 });
    expect(tab1.rules.map((r: { id: string }) => r.id).sort()).toEqual(["a", "b"]);
  });

  it("a tabless call naming tab 1 does not replace tab 1's own rules", async () => {
    await handleIntercept({ action: "set-rules", tabId: 1, rules: [{ id: "a", match: "https://a\\.test/", action: "block" }] });
    await handleIntercept({ action: "set-rules", rules: [{ id: "b", match: "https://b\\.test/", action: "block", tabIds: [1] }] });
    const tab1 = await handleIntercept({ action: "list-rules", tabId: 1 });
    expect(tab1.rules.map((r: { id: string }) => r.id).sort()).toEqual(["a", "b"]);
    expect(sessionRules.size).toBe(2);
  });
});

describe("RE2 validation", () => {
  beforeEach(reset);

  it("one RE2-invalid regex fails the whole call, names the rule and applies nothing", async () => {
    re2Rejects = (regex) => regex.includes("(?=");
    const res = await handleIntercept({
      action: "set-rules", tabId: 15,
      rules: [
        { id: "ok", match: "https://a\\.test/", action: "block" },
        { id: "bad", match: "https://b\\.test/(?=x)", action: "block" },
      ],
    });
    expect(res).toMatchObject({ success: false, rejected: [{ id: "bad", match: "https://b\\.test/(?=x)" }] });
    expect(res.error).toMatch(/^INVALID_REGEX: .*bad/);
    expect(rulesByScope.size).toBe(0);
    expect(sessionRules.size).toBe(0);
  });

  it("a regex check that throws is reported for that rule, not as a crash", async () => {
    const dnr = (globalThis as unknown as { chrome: { declarativeNetRequest: { isRegexSupported: unknown } } }).chrome.declarativeNetRequest;
    const original = dnr.isRegexSupported;
    dnr.isRegexSupported = async ({ regex }: { regex: string }) => {
      if (regex.includes("boom")) throw new Error("checker unavailable");
      return { isSupported: true };
    };
    try {
      const res = await handleIntercept({
        action: "set-rules", tabId: 15,
        rules: [{ id: "x", match: "https://boom\\.test/", action: "block" }, { id: "y", match: "https://ok\\.test/", action: "block" }],
      });
      expect(res).toMatchObject({ success: false, rejected: [{ id: "x", reason: "checker unavailable" }] });
      expect(rulesByScope.size).toBe(0);
    } finally {
      dnr.isRegexSupported = original;
    }
  });

  it("a rule Chrome refuses leaves the previous rule set in place", async () => {
    await handleIntercept({ action: "set-rules", tabId: 15, rules: [{ id: "a", match: "https://a\\.test/", action: "block" }] });
    refuse = () => "Number of regex rules exceeds the limit";
    await expect(
      handleIntercept({ action: "set-rules", tabId: 15, rules: [{ id: "b", match: "https://b\\.test/", action: "block" }] }),
    ).rejects.toThrow(/DNR_REJECTED.*nothing was changed/);
    const listed = await handleIntercept({ action: "list-rules", tabId: 15 });
    expect(listed.rules.map((r: { id: string }) => r.id)).toEqual(["a"]);
    expect([...sessionRules.values()].map((r) => r.condition.regexFilter)).toEqual(["https://a\\.test/"]);
  });
});

describe("resource types and mock honesty", () => {
  beforeEach(reset);

  it("xhr is stored, enforced and ledgered as xmlhttprequest", async () => {
    const res = await handleIntercept({
      action: "set-rules", tabId: 15,
      rules: [{ id: "api", match: "https://api\\.x\\.test/", action: "block", types: ["xhr"] }],
    });
    expect(res).toMatchObject({ enforcement: "full", enforced: 1 });
    expect(rulesByScope.get("tabs:15")?.[0].types).toEqual(["xmlhttprequest"]);
    expect([...sessionRules.values()][0].condition).toMatchObject({ resourceTypes: ["xmlhttprequest"] });
    const entry = enrichCapture(15, { url: "https://api.x.test/v1", type: "xmlhttprequest", method: "GET" }) as {
      intercept: { applied: Array<{ outcome: string }> };
    };
    expect(entry.intercept.applied[0].outcome).toBe("enforced");
  });

  it("an unknown resource type is refused before anything is stored", async () => {
    await expect(
      handleIntercept({ action: "set-rules", tabId: 15, rules: [{ match: "https://a\\.test/", action: "block", types: ["pictures"] }] }),
    ).rejects.toThrow(/Unknown resource type "pictures"/);
    expect(rulesByScope.size).toBe(0);
  });

  it("a mock rule with xhr type is recorded only, never reported as enforced", async () => {
    const res = await handleIntercept({
      action: "set-rules", tabId: 15,
      rules: [{ id: "m", match: "https://api\\.x\\.test/", action: "mock", types: ["xhr"], mockStatus: 200, mockBody: "{}" }],
    });
    expect(res).toMatchObject({ success: true, enforcement: "partial", enforced: 0 });
    expect(res.unsupported).toEqual([expect.objectContaining({ id: "m", action: "mock", reason: expect.stringMatching(/recorded only/) })]);
    expect(sessionRules.size).toBe(0);
    const listed = await handleIntercept({ action: "list-rules", tabId: 15 });
    expect(listed.enforcement).toBe("partial");
  });

  it("log rules are recorded only and make the enforcement partial", async () => {
    const res = await handleIntercept({ action: "set-rules", tabId: 15, rules: [{ id: "l", match: "https://a\\.test/", action: "log" }] });
    expect(res).toMatchObject({ enforcement: "partial", enforced: 0 });
  });

  it("URL matching is case-sensitive, in the ledger as in Chrome", async () => {
    await handleIntercept({ action: "set-rules", tabId: 15, rules: [{ id: "api", match: "api\\.x\\.test", action: "block" }] });
    expect([...sessionRules.values()][0].condition).toMatchObject({ isUrlFilterCaseSensitive: true });
    const upper = enrichCapture(15, { url: "https://API.X.TEST/v1", type: "xmlhttprequest" });
    expect(upper).not.toHaveProperty("intercept");
  });
});

describe("captures", () => {
  beforeEach(reset);

  it("a blocked request is ledgered with its outcome; the network buffer entry stays plain", async () => {
    await handleIntercept({ action: "set-rules", global: true, rules: [{ id: "ads", match: "https://ads\\.test/", action: "block" }] });
    const entry = { id: "9", method: "GET", url: "https://ads.test/x.js", type: "script", error: "net::ERR_BLOCKED_BY_CLIENT", timestamp: 5 };
    pushNetworkEntry(getTabBuffer(networkByTab, 15), entry);
    const annotated = enrichCapture(15, entry) as { intercept?: { applied: Array<{ outcome: string }> } };
    expect(annotated.intercept?.applied[0].outcome).toBe("enforced");
    expect(entry).not.toHaveProperty("intercept");
    const res = await handleIntercept({ action: "list-captures", tabId: 15 });
    expect(res.captures).toHaveLength(1);
    expect(res.captures[0]).toMatchObject({ error: "net::ERR_BLOCKED_BY_CLIENT", intercept: { matchedRuleIds: ["ads"] } });
  });
});

describe("worker restart", () => {
  beforeEach(reset);

  it("stored rules are restored and Chrome's surviving rules re-synced", async () => {
    await handleIntercept({ action: "set-rules", tabId: 15, rules: [{ id: "a", match: "https://a\\.test/", action: "block" }] });
    expect(stored.get("bcInterceptRules")).toEqual([["tabs:15", [expect.objectContaining({ id: "a" })]]]);
    // Simulated worker restart: memory is gone, Chrome keeps its session rules.
    rulesByScope.clear();
    await initIntercept();
    expect([...rulesByScope.keys()]).toEqual(["tabs:15"]);
    expect([...sessionRules.keys()]).toEqual([1000]);
    const listed = await handleIntercept({ action: "list-rules", tabId: 15 });
    expect(listed.rules).toEqual([expect.objectContaining({ id: "a", enforced: true })]);
  });

  it("Chrome rules nothing stored accounts for are removed at startup", async () => {
    sessionRules.set(1001, { id: 1001, action: { type: "block" }, condition: { regexFilter: "stale" } });
    await initIntercept();
    expect(sessionRules.size).toBe(0);
    expect(rulesByScope.size).toBe(0);
  });
});
