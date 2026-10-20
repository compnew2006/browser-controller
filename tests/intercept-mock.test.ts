import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Mock rules answered through the tab's debugger (Fetch domain): requests
 * pause, a matching mock rule fulfills them, everything else continues.
 */
const sent: Array<[number, string, any]> = [];
let emit: (source: { tabId: number }, method: string, params: unknown) => void = () => {};
let dropSession: (source: { tabId: number }) => void = () => {};
let attachFails = false;
(globalThis as any).chrome = {
  tabs: { get: async (id: number) => ({ id, url: "https://app.test/", windowId: 1 }), query: async () => [], onRemoved: { addListener: () => {} } },
  windows: { get: async () => ({ width: 1280, height: 900 }) },
  scripting: { executeScript: async () => [{ result: null }] },
  storage: { session: { get: async () => ({}), set: async () => {} } },
  declarativeNetRequest: { getSessionRules: async () => [], updateSessionRules: async () => {} },
  debugger: {
    attach: async () => { if (attachFails) throw new Error("Cannot access a chrome:// URL"); },
    detach: async () => {},
    sendCommand: async ({ tabId }: { tabId: number }, method: string, params: any) => {
      sent.push([tabId, method, params]);
      return { result: { value: 1 } };
    },
    onEvent: { addListener: (fn: typeof emit) => { emit = fn; } },
    onDetach: { addListener: (fn: typeof dropSession) => { dropSession = fn; } },
  },
};

const { mockFulfillParams, cdpResourceTypes } = await import("../extension/lib/intercept.js");
const { handleIntercept, rulesByScope, enrichCapture } = await import("../extension/handlers/intercept.js");
const { detachCdp, hasCdp, IDLE_MS } = await import("../extension/lib/cdp-session.js");

const b64 = (s: string) => Buffer.from(s).toString("base64");
const header = (params: any, name: string) => params.responseHeaders.find((h: any) => h.name.toLowerCase() === name)?.value;
const commands = (tabId: number, method: string) => sent.filter(([t, m]) => t === tabId && m === method).map(([, , p]) => p);
const pause = async (tabId: number, requestId: string, url: string, { method = "GET", resourceType = "XHR", headers = {} } = {}) => {
  emit({ tabId }, "Fetch.requestPaused", { requestId, request: { url, method, headers }, resourceType });
  await vi.advanceTimersByTimeAsync(0);
};

describe("mockFulfillParams", () => {
  it("serves the mock body as base64 with a guessed content type and the rule's status", () => {
    const json = mockFulfillParams({ mockStatus: 201, mockBody: '{"id":7}' }, { method: "GET", url: "https://app.test/api", headers: {} });
    expect(json).toEqual({ responseCode: 201, responseHeaders: [{ name: "Content-Type", value: "application/json" }], body: b64('{"id":7}') });
    const text = mockFulfillParams({ mockBody: "café" }, { method: "GET", url: "https://app.test/x", headers: {} });
    expect(text.responseCode).toBe(200);
    expect(header(text, "content-type")).toBe("text/plain; charset=utf-8");
    expect(Buffer.from(text.body, "base64").toString("utf8")).toBe("café");
  });

  it("rule headers become response headers and win over the defaults", () => {
    const p = mockFulfillParams({ mockBody: "<b>x</b>", headers: { "Content-Type": "text/html", "X-Mock": "1" } }, { method: "GET", url: "https://app.test/", headers: {} });
    expect(p.responseHeaders).toEqual([{ name: "Content-Type", value: "text/html" }, { name: "X-Mock", value: "1" }]);
  });

  it("allows the requesting origin, and answers its CORS preflight", () => {
    const cross = mockFulfillParams({ mockBody: "{}", headers: { "X-Mock": "1" } }, { method: "POST", url: "https://api.test/v1", headers: { Origin: "https://app.test" } });
    expect(header(cross, "access-control-allow-origin")).toBe("https://app.test");
    expect(header(cross, "access-control-allow-credentials")).toBe("true");
    expect(header(cross, "access-control-expose-headers")).toBe("X-Mock"); // else the page cannot read it
    const plain = mockFulfillParams({ mockBody: "{}" }, { method: "GET", url: "https://api.test/v1", headers: { Origin: "https://app.test" } });
    expect(header(plain, "access-control-expose-headers")).toBeUndefined();
    const preflight = mockFulfillParams({ mockStatus: 500, mockBody: "{}" }, {
      method: "OPTIONS", url: "https://api.test/v1",
      headers: { Origin: "https://app.test", "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type" },
    });
    expect(preflight.responseCode).toBe(204);
    expect(preflight.body).toBeUndefined();
    expect(header(preflight, "access-control-allow-methods")).toBe("POST");
    expect(header(preflight, "access-control-allow-headers")).toBe("content-type");
    const own = mockFulfillParams({ headers: { "Access-Control-Allow-Origin": "*" } }, { method: "GET", url: "https://api.test/", headers: { origin: "https://app.test" } });
    expect(own.responseHeaders.filter((h: any) => /allow-origin/i.test(h.name))).toEqual([{ name: "Access-Control-Allow-Origin", value: "*" }]);
    // The rule's own CORS headers answer its preflight too (else the real request is never sent).
    const ownPreflight = mockFulfillParams({ headers: { "Access-Control-Allow-Origin": "*", "X-Mock": "1" } }, {
      method: "OPTIONS", url: "https://api.test/", headers: { Origin: "https://app.test", "Access-Control-Request-Method": "PUT" },
    });
    expect(ownPreflight.responseHeaders).toEqual([
      { name: "Access-Control-Allow-Origin", value: "*" }, { name: "Access-Control-Allow-Methods", value: "PUT" },
    ]);
  });

  it("maps CDP resource types to the webRequest names rules use", () => {
    expect(cdpResourceTypes("XHR")).toEqual(["xmlhttprequest"]);
    expect(cdpResourceTypes("Fetch")).toEqual(["xmlhttprequest"]);
    expect(cdpResourceTypes("Document")).toEqual(["main_frame", "sub_frame"]);
    expect(cdpResourceTypes("Stylesheet")).toEqual(["stylesheet"]);
    expect(cdpResourceTypes("Prefetch")).toEqual(["other"]);
    expect(cdpResourceTypes("Preflight")).toEqual(["xmlhttprequest"]); // the fetch/XHR it precedes
  });
});

describe("browser_intercept mock rules (Fetch domain)", () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    await handleIntercept({ action: "clear-rules" });
    rulesByScope.clear();
    for (const t of [15, 16]) await detachCdp(t);
    sent.length = 0;
    attachFails = false;
  });
  afterEach(() => { vi.useRealTimers(); });

  it("a tab-scoped mock is enforced: matching requests are fulfilled, others continue", async () => {
    const res = await handleIntercept({
      action: "set-rules", tabId: 15,
      rules: [{ id: "m", match: "/api/items", action: "mock", mockStatus: 200, mockBody: '{"items":[]}', types: ["xmlhttprequest"] }],
    });
    expect(res).toMatchObject({ success: true, enforcement: "full", enforced: 1 });
    expect(res.unsupported).toBeUndefined();
    // Every request pauses: Chrome cannot filter a preflight by type, and a typed mock must answer it.
    expect(commands(15, "Fetch.enable")).toEqual([{ patterns: [{ urlPattern: "*", requestStage: "Request" }] }]);

    await pause(15, "p1", "https://app.test/api/items?page=2");
    await pause(15, "p2", "https://app.test/app.js", { resourceType: "Script" });
    await pause(15, "p3", "https://app.test/api/items", { resourceType: "Script" }); // wrong type
    expect(commands(15, "Fetch.fulfillRequest")).toEqual([
      { requestId: "p1", responseCode: 200, responseHeaders: [{ name: "Content-Type", value: "application/json" }], body: b64('{"items":[]}') },
    ]);
    expect(commands(15, "Fetch.continueRequest").map((p) => p.requestId)).toEqual(["p2", "p3"]);

    const listed = await handleIntercept({ action: "list-rules", tabId: 15 });
    expect(listed.rules.map((r: any) => [r.id, r.enforced])).toEqual([["m", true]]);
    const entry = enrichCapture(15, { url: "https://app.test/api/items", type: "xmlhttprequest", method: "GET" }) as any;
    expect(entry.intercept.applied).toEqual([{ ruleId: "m", outcome: "enforced" }]);
  });

  it("keeps the debugger attached while mocking and releases it when the rules are cleared", async () => {
    await handleIntercept({ action: "set-rules", tabId: 15, rules: [{ match: "/api/", action: "mock", mockBody: "{}" }] });
    await vi.advanceTimersByTimeAsync(IDLE_MS * 3);
    expect(hasCdp(15)).toBe(true);
    await handleIntercept({ action: "clear-rules", tabId: 15 });
    expect(commands(15, "Fetch.disable")).toHaveLength(1);
    await pause(15, "late", "https://app.test/api/x"); // in flight when the rules went away
    expect(commands(15, "Fetch.fulfillRequest")).toEqual([]);
    expect(commands(15, "Fetch.continueRequest").map((p) => p.requestId)).toEqual(["late"]);
    await vi.advanceTimersByTimeAsync(IDLE_MS + 1);
    expect(hasCdp(15)).toBe(false);
  });

  it("a preflight of a typed mock is answered", async () => {
    await handleIntercept({ action: "set-rules", tabId: 15, rules: [{ match: "api\\.test/save", action: "mock", mockBody: "{}", types: ["xmlhttprequest"] }] });
    await pause(15, "pre", "https://api.test/save", { method: "OPTIONS", resourceType: "Preflight", headers: { Origin: "https://app.test", "Access-Control-Request-Method": "POST" } });
    expect(commands(15, "Fetch.fulfillRequest").map((p) => [p.requestId, p.responseCode])).toEqual([["pre", 204]]);
  });

  it("a mock without a tab is refused; the tab's own mock answers", async () => {
    await expect(handleIntercept({ action: "set-rules", rules: [{ id: "g", match: "/api/user", action: "mock", mockStatus: 500, mockBody: "{}" }] })).rejects.toThrow(/tabId is required/);
    await handleIntercept({ action: "set-rules", tabId: 15, rules: [{ id: "t", match: "/api/user", action: "mock", mockStatus: 200, mockBody: "{}" }] });
    await pause(15, "u", "https://app.test/api/user");
    expect(commands(15, "Fetch.fulfillRequest").map((p) => p.responseCode)).toEqual([200]);
  });

  it("without declarativeNetRequest a live mock still counts: partial, not capture-only", async () => {
    const dnr = (globalThis as any).chrome.declarativeNetRequest;
    (globalThis as any).chrome.declarativeNetRequest = undefined;
    try {
      const res = await handleIntercept({ action: "set-rules", tabId: 15, rules: [
        { id: "m", match: "/api/", action: "mock", mockBody: "{}" }, { id: "b", match: "ads", action: "block" },
      ] });
      expect(res).toMatchObject({ enforcement: "partial", enforced: 1 });
      expect((await handleIntercept({ action: "list-rules", tabId: 15 })).enforcement).toBe("partial");
    } finally {
      (globalThis as any).chrome.declarativeNetRequest = dnr;
    }
  });

  it("only the tabs a mock targets pause their requests", async () => {
    await handleIntercept({ action: "set-rules", tabId: 15, rules: [{ match: "/api/", action: "mock", mockBody: "{}" }] });
    await handleIntercept({ action: "set-rules", tabId: 16, rules: [{ match: "ads", action: "block" }] });
    expect(commands(16, "Fetch.enable")).toEqual([]);
    expect(commands(15, "Fetch.disable")).toEqual([]); // setting tab 16's rules leaves tab 15's mock alone
  });

  it("tabs without a debugger are reported, not claimed", async () => {
    attachFails = true;
    const denied = await handleIntercept({ action: "set-rules", tabId: 16, rules: [{ id: "d", match: "/api/", action: "mock", mockBody: "{}" }] });
    expect(denied).toMatchObject({ enforcement: "capture-only", enforced: 0 });
    expect(denied.unsupported).toEqual([expect.objectContaining({ id: "d", reason: expect.stringMatching(/debugger unavailable on tab 16.*chrome:\/\//) })]);
  });

  it("closing the debugger banner stops the mock and is reported", async () => {
    await handleIntercept({ action: "set-rules", tabId: 15, rules: [{ id: "m", match: "/api/", action: "mock", mockBody: "{}" }] });
    dropSession({ tabId: 15 });
    const listed = await handleIntercept({ action: "list-rules", tabId: 15 });
    expect(listed.enforcement).toBe("capture-only"); // its only rule is no longer applied
    expect(listed.rules.map((r: any) => r.enforced)).toEqual([false]);
  });

  it("a paused request nobody answers is let through (worker restarted, rules lost)", async () => {
    await pause(16, "orphan", "https://app.test/api/x");
    expect(commands(16, "Fetch.continueRequest")).toEqual([{ requestId: "orphan" }]);
    expect(commands(16, "Fetch.disable")).toHaveLength(1);
  });
});
