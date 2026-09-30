import { vi, describe, it, expect, beforeEach } from "vitest";

/**
 * Intercept plane: pure engine (S2) + handler CRUD/degrade/HAR (S3/S4).
 * chrome mock has NO declarativeNetRequest -> every enforcement assertion
 * must expect capture-only degradation, never a throw.
 */

const tabStore = new Map<
  number,
  { id: number; windowId: number; url: string; title: string; active: boolean }
>();
(globalThis as unknown as { chrome: unknown }).chrome = {
  tabs: {
    get: async (id: number) =>
      tabStore.get(id) ?? Promise.reject(new Error(`No tab ${id}`)),
    query: async () => [],
    update: async () => ({}),
    remove: async () => ({}),
    create: async () => ({}),
  },
  scripting: { executeScript: async () => [{ result: null }] },
  storage: { session: { get: async () => ({}), set: async () => {} } },
};

const { validateRule, validateRuleSet, matchRule, evaluateRules } =
  await import("../extension/lib/intercept.js");
const { handleIntercept, enrichCapture, rulesByScope, interceptLedgerByTab } =
  await import("../extension/handlers/intercept.js");
const { networkByTab } = await import("../extension/lib/state.js");

describe("pure engine (S2)", () => {
  it("rejects invalid regex", () => {
    expect(() => validateRule({ match: "([", action: "log" }, 0)).toThrow(
      /invalid match regex/,
    );
  });

  it("rejects match-all patterns", () => {
    expect(() => validateRule({ match: ".*", action: "block" }, 0)).toThrow(
      /match-all/,
    );
    expect(() => validateRule({ match: ".+", action: "block" }, 0)).toThrow(
      /match-all/,
    );
  });

  it("rejects empty match and unknown action", () => {
    expect(() => validateRule({ match: "", action: "log" }, 0)).toThrow(
      /match must be/,
    );
    expect(() =>
      validateRule({ match: "https://x\\.com/", action: "nuke" }, 0),
    ).toThrow(/action must be/);
  });

  it("rejects redirect without redirectUrl and oversize mock", () => {
    expect(() =>
      validateRule({ match: "https://x\\.com/", action: "redirect" }, 0),
    ).toThrow(/redirectUrl/);
    expect(() =>
      validateRule(
        {
          match: "https://x\\.com/",
          action: "mock",
          mockBody: "x".repeat(20_001),
        },
        0,
      ),
    ).toThrow(/mockBody exceeds/);
  });

  it("rejects 51 rules and duplicate ids", () => {
    const many = Array.from({ length: 51 }, (_, i) => ({
      id: `r${i}`,
      match: `https://x${i}\\.com/`,
      action: "log",
    }));
    expect(() => validateRuleSet(many)).toThrow(/Too many rules/);
    expect(() =>
      validateRuleSet([
        { id: "dup", match: "https://a\\.com/", action: "log" },
        { id: "dup", match: "https://b\\.com/", action: "log" },
      ]),
    ).toThrow(/Duplicate rule id/);
  });

  it("match respects regex + type + tab scope; disabled never matches", () => {
    const rule = {
      id: "r1",
      match: "api\\.example\\.com",
      types: ["xmlhttprequest"],
      tabIds: [15],
      action: "log",
    };
    expect(
      matchRule(rule, {
        url: "https://api.example.com/v1",
        type: "xmlhttprequest",
        tabId: 15,
      }),
    ).toBe(true);
    expect(
      matchRule(rule, {
        url: "https://api.example.com/v1",
        type: "image",
        tabId: 15,
      }),
    ).toBe(false);
    expect(
      matchRule(rule, {
        url: "https://api.example.com/v1",
        type: "xmlhttprequest",
        tabId: 16,
      }),
    ).toBe(false);
    expect(
      matchRule(
        { ...rule, enabled: false },
        {
          url: "https://api.example.com/v1",
          type: "xmlhttprequest",
          tabId: 15,
        },
      ),
    ).toBe(false);
    expect(
      evaluateRules([rule], {
        url: "https://other.com/",
        type: "xmlhttprequest",
        tabId: 15,
      }),
    ).toEqual([]);
  });
});

describe("handler CRUD + degrade (S3)", () => {
  beforeEach(() => {
    rulesByScope.clear();
    interceptLedgerByTab.clear();
    networkByTab.clear();
    tabStore.clear();
    tabStore.set(15, {
      id: 15,
      windowId: 1,
      url: "https://app.example.com/",
      title: "App",
      active: true,
    });
  });

  it("set/list/clear round-trips with capture-only enforcement (no DNR in tests)", async () => {
    const set = await handleIntercept({
      action: "set-rules",
      tabId: 15,
      rules: [{ match: "tracker\\.example\\.com", action: "block" }],
    });
    expect(set.success).toBe(true);
    expect(set.enforcement).toBe("capture-only");
    expect(set.ruleCount).toBe(1);

    const list = await handleIntercept({ action: "list-rules", tabId: 15 });
    expect(list.rules.length).toBe(1);

    const clear = await handleIntercept({ action: "clear-rules", tabId: 15 });
    expect(clear.success).toBe(true);
    const after = await handleIntercept({ action: "list-rules", tabId: 15 });
    expect(after.rules.length).toBe(0);
  });

  it("rejects invalid rules without persisting", async () => {
    await expect(
      handleIntercept({
        action: "set-rules",
        rules: [{ match: "([", action: "log" }],
      }),
    ).rejects.toThrow(/invalid match regex/);
    const list = await handleIntercept({ action: "list-rules" });
    expect(list.rules.length).toBe(0);
  });

  it("unknown action throws honestly", async () => {
    await expect(handleIntercept({ action: "nuke" })).rejects.toThrow(
      /Unknown intercept action/,
    );
  });
});

describe("capture + HAR (S4)", () => {
  beforeEach(() => {
    rulesByScope.clear();
    interceptLedgerByTab.clear();
    networkByTab.clear();
    tabStore.clear();
    tabStore.set(15, {
      id: 15,
      windowId: 1,
      url: "https://app.example.com/",
      title: "App",
      active: true,
    });
  });

  it("enrichCapture marks matched entries and ledgers them", async () => {
    await handleIntercept({
      action: "set-rules",
      rules: [{ id: "blk-track", match: "tracker\\.example", action: "block" }],
    });
    const entry: Record<string, unknown> = {
      method: "GET",
      url: "https://tracker.example/ping",
      status: 200,
      type: "script",
    };
    const out = enrichCapture(15, entry);
    expect(
      (out.intercept as { matchedRuleIds: string[] }).matchedRuleIds,
    ).toContain("blk-track");
    expect(interceptLedgerByTab.get(15)?.length).toBe(1);
  });

  it("list-captures rejects invalid filter regex honestly", async () => {
    await expect(
      handleIntercept({ action: "list-captures", tabId: 15, filter: "([" }),
    ).rejects.toThrow(/Invalid filter regex/);
  });

  it("export-har returns valid HAR 1.2 with redaction flag", async () => {
    networkByTab.set(15, [
      {
        method: "GET",
        url: "https://app.example.com/",
        status: 200,
        type: "main_frame",
        timestamp: Date.now(),
      },
    ]);
    const res = await handleIntercept({ action: "export-har", tabId: 15 });
    expect(res.success).toBe(true);
    expect(res.har.log.version).toBe("1.2");
    expect(res.har.log.creator.name).toBe("browser-controller");
    expect(res.entries).toBe(1);
    expect(res.har.log.entries[0].response._redacted).toBe(true);
  });

  it("list-captures requires tabId", async () => {
    await expect(handleIntercept({ action: "list-captures" })).rejects.toThrow(
      /tabId required/,
    );
  });
});

describe("capture dedupe (fix)", () => {
  beforeEach(() => {
    rulesByScope.clear();
    interceptLedgerByTab.clear();
    networkByTab.clear();
    tabStore.clear();
    tabStore.set(15, {
      id: 15,
      windowId: 1,
      url: "https://app.example.com/",
      title: "App",
      active: true,
    });
  });

  it("a matched request appears once in list-captures (not ledger + buffer)", async () => {
    await handleIntercept({
      action: "set-rules",
      rules: [{ id: "blk-track", match: "tracker\\.example", action: "block" }],
    });
    // Simulate the events.js flow: buffer push, then enrich (mutates + ledgers).
    const buf = networkByTab.get(15) ?? [];
    networkByTab.set(15, buf);
    const entry = {
      method: "GET",
      url: "https://tracker.example/ping",
      status: 200,
      type: "script",
      timestamp: 1234567890,
    };
    buf.push(entry);
    enrichCapture(15, entry);
    const res = await handleIntercept({ action: "list-captures", tabId: 15 });
    expect(res.captures.length).toBe(1);
    expect(res.captures[0].intercept.matchedRuleIds).toContain("blk-track");
  });

  it("export-har counts each request once", async () => {
    await handleIntercept({
      action: "set-rules",
      rules: [{ id: "blk-track", match: "tracker\\.example", action: "block" }],
    });
    const buf: Record<string, unknown>[] = [];
    networkByTab.set(15, buf);
    const entry = {
      method: "GET",
      url: "https://tracker.example/ping",
      status: 200,
      type: "script",
      timestamp: 1234567890,
    };
    buf.push(entry);
    enrichCapture(15, entry);
    const res = await handleIntercept({ action: "export-har", tabId: 15 });
    expect(res.entries).toBe(1);
  });
});
