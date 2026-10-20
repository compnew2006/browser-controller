import { beforeEach, describe, expect, it } from "vitest";

/**
 * Enforcement against a STATEFUL declarativeNetRequest mock: what Chrome
 * actually has installed must match what browser_intercept reports.
 */
type DnrRule = { id: number; action: Record<string, unknown>; condition: Record<string, unknown> };
const sessionRules = new Map<number, DnrRule>();
const dynamicRules = new Map<number, DnrRule>();

(globalThis as unknown as { chrome: unknown }).chrome = {
  tabs: { get: async (id: number) => ({ id, url: "https://x.test/", windowId: 1 }), query: async () => [] },
  scripting: { executeScript: async () => [{ result: null }] },
  storage: { session: { get: async () => ({}), set: async () => {} } },
  declarativeNetRequest: {
    getSessionRules: async () => [...sessionRules.values()],
    updateSessionRules: async ({ removeRuleIds = [], addRules = [] }: { removeRuleIds?: number[]; addRules?: DnrRule[] }) => {
      for (const id of removeRuleIds) sessionRules.delete(id);
      for (const r of addRules) {
        if (sessionRules.has(r.id)) throw new Error(`Rule with id ${r.id} does not have a unique ID.`);
        sessionRules.set(r.id, r);
      }
    },
    // RE2: no lookarounds or backreferences.
    isRegexSupported: async ({ regex }: { regex: string }) => (/\(\?[=!<]|\\\d/.test(regex) ? { isSupported: false, reason: "syntaxError" } : { isSupported: true }),
    getDynamicRules: async () => [...dynamicRules.values()],
    updateDynamicRules: async ({ removeRuleIds = [], addRules = [] }: { removeRuleIds?: number[]; addRules?: DnrRule[] }) => {
      for (const id of removeRuleIds) dynamicRules.delete(id);
      for (const r of addRules) dynamicRules.set(r.id, r);
    },
  },
};

const { handleIntercept, rulesByScope, enrichCapture } = await import("../extension/handlers/intercept.js");

describe("browser_intercept enforcement (stateful DNR)", () => {
  beforeEach(async () => {
    sessionRules.clear();
    dynamicRules.clear();
    rulesByScope.clear();
  });

  it("a tab-scoped block is installed as a tab-scoped session rule with its resource types", async () => {
    const res = await handleIntercept({
      action: "set-rules", tabId: 15,
      rules: [{ id: "api", match: "https://api\\.x\\.test/", action: "block", types: ["xmlhttprequest"] }],
    });
    expect(res).toMatchObject({ success: true, enforcement: "full", scope: "tabs:15", enforced: 1 });
    expect(dynamicRules.size).toBe(0); // never browser-wide dynamic rules
    const [rule] = [...sessionRules.values()];
    expect(rule.condition).toEqual({ regexFilter: "https://api\\.x\\.test/", tabIds: [15], resourceTypes: ["xmlhttprequest"] });
  });

  it("a rule without a tab is refused: it would change every tab of the user's browser", async () => {
    await expect(handleIntercept({ action: "set-rules", rules: [{ match: "ads\\.test", action: "block" }] })).rejects.toThrow(/tabId is required/);
    expect(sessionRules.size).toBe(0);
  });

  it("a regex Chrome cannot use is refused by name, and the other rules keep working", async () => {
    await handleIntercept({ action: "set-rules", tabId: 15, rules: [{ id: "ok", match: "https://ads\\.test/", action: "block" }] });
    await expect(handleIntercept({ action: "set-rules", tabId: 15, rules: [
      { id: "ok", match: "https://ads\\.test/", action: "block" },
      { id: "look", match: "/api/(?!public)", action: "block" },
    ] })).rejects.toThrow(/rules\[1\] \(look\).*syntaxError.*Nothing was changed/);
    expect([...sessionRules.values()].map((r) => r.condition.regexFilter)).toEqual(["https://ads\\.test/"]);
    expect((await handleIntercept({ action: "list-rules", tabId: 15 })).rules.map((r: { id: string }) => r.id)).toEqual(["ok"]);
  });

  it("when Chrome rejects the update, the tab's previous rules stay and the call fails", async () => {
    await handleIntercept({ action: "set-rules", tabId: 15, rules: [{ id: "a", match: "https://a\\.test/", action: "block" }] });
    const dnr = (globalThis as any).chrome.declarativeNetRequest;
    const update = dnr.updateSessionRules;
    let calls = 0;
    dnr.updateSessionRules = async (args: unknown) => { if (calls++ === 0) throw new Error("quota"); return update(args); };
    try {
      const res = await handleIntercept({ action: "set-rules", tabId: 15, rules: [{ id: "b", match: "https://b\\.test/", action: "block" }] });
      expect(res).toMatchObject({ success: false });
      expect(res.error).toMatch(/quota.*nothing was changed/);
    } finally {
      dnr.updateSessionRules = update;
    }
    expect((await handleIntercept({ action: "list-rules", tabId: 15 })).rules.map((r: { id: string }) => r.id)).toEqual(["a"]);
    expect([...sessionRules.values()].map((r) => r.condition.regexFilter)).toEqual(["https://a\\.test/"]);
  });

  it("clearing removes the rules from Chrome too (not just from the list)", async () => {
    await handleIntercept({ action: "set-rules", tabId: 15, rules: [{ match: "https://ads\\.test/", action: "block" }] });
    await handleIntercept({ action: "set-rules", tabId: 16, rules: [{ match: "https://old\\.test/", action: "redirect", redirectUrl: "https://new.test/" }] });
    expect(sessionRules.size).toBe(2);
    await handleIntercept({ action: "clear-rules", tabId: 15 });
    expect([...sessionRules.values()].map((r) => r.condition.regexFilter)).toEqual(["https://old\\.test/"]);
    await handleIntercept({ action: "clear-rules" });
    expect(sessionRules.size).toBe(0);
    expect((await handleIntercept({ action: "list-rules" })).rules).toEqual([]);
  });

  it("replacing a tab's rules replaces them (scope keys are deduplicated)", async () => {
    await handleIntercept({
      action: "set-rules", tabId: 15,
      rules: [{ id: "a", match: "https://a\\.test/", action: "block" }, { id: "b", match: "https://b\\.test/", action: "block" }],
    });
    expect([...rulesByScope.keys()]).toEqual(["tabs:15"]);
    await handleIntercept({ action: "set-rules", tabId: 15, rules: [{ id: "c", match: "https://c\\.test/", action: "block" }] });
    expect([...rulesByScope.keys()]).toEqual(["tabs:15"]);
    expect([...sessionRules.values()].map((r) => r.condition.regexFilter)).toEqual(["https://c\\.test/"]);
  });

  it("header rules are enforced as request-header modifications", async () => {
    const res = await handleIntercept({
      action: "set-rules", tabId: 15,
      rules: [{ id: "h", match: "https://api\\.x\\.test/", action: "header", headers: { "X-Test": "1" } }],
    });
    expect(res).toMatchObject({ enforcement: "full", enforced: 1 });
    expect([...sessionRules.values()][0].action).toEqual({
      type: "modifyHeaders", requestHeaders: [{ header: "X-Test", operation: "set", value: "1" }],
    });
  });

  it("mock rules are not claimed as enforced when the debugger is unavailable", async () => {
    const res = await handleIntercept({
      action: "set-rules", tabId: 15,
      rules: [
        { id: "m", match: "https://api\\.x\\.test/v1", action: "mock", mockStatus: 200, mockBody: "{}" },
        { id: "b", match: "https://ads\\.test/", action: "block" },
      ],
    });
    expect(res).toMatchObject({ enforcement: "partial", enforced: 1 });
    expect(res.unsupported).toEqual([expect.objectContaining({ id: "m", action: "mock" })]);
    expect(sessionRules.size).toBe(1);
    const entry = enrichCapture(15, { url: "https://api.x.test/v1/users", type: "xmlhttprequest", method: "GET" }) as { intercept: { applied: Array<{ ruleId: string; outcome: string }> } };
    expect(entry.intercept.applied).toEqual([{ ruleId: "m", outcome: "ledger-only" }]);
    const blocked = enrichCapture(15, { url: "https://ads.test/x.js", type: "script", method: "GET" }) as { intercept: { applied: Array<{ outcome: string }> } };
    expect(blocked.intercept.applied[0].outcome).toBe("enforced");
    const listed = await handleIntercept({ action: "list-rules", tabId: 15 });
    expect(listed.enforcement).toBe("partial");
    expect(listed.rules.map((r: { id: string; enforced: boolean }) => [r.id, r.enforced])).toEqual([["m", false], ["b", true]]);
  });

  it("rules installed by a previous service worker are removed on the next sync", async () => {
    sessionRules.set(1003, { id: 1003, action: { type: "block" }, condition: { regexFilter: "stale" } });
    sessionRules.set(42, { id: 42, action: { type: "block" }, condition: { regexFilter: "not ours" } });
    await handleIntercept({ action: "set-rules", tabId: 15, rules: [{ match: "https://a\\.test/", action: "block" }] });
    expect([...sessionRules.keys()].sort((a, b) => a - b)).toEqual([42, 1000]);
  });
});
