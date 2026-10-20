import { vi, describe, it, expect, beforeEach } from "vitest";

/**
 * First behavior tests for the extension side (architecture item: background
 * logic was never importable by any test). The module split makes the router
 * + state importable under vitest with a chrome.* mock; the connection module
 * is mocked so the router's outgoing WS frames are observable.
 */

const sent = vi.hoisted(() => [] as Array<Record<string, unknown>>);

vi.mock("../extension/lib/connection.js", () => ({
  sendJson: (obj: Record<string, unknown>) => {
    sent.push(obj);
  },
  updateBadge: () => {},
  broadcastStatus: async () => {},
  isWsConnected: () => true,
  setCurrentActivity: () => {},
}));

// chrome.* mock — must exist before any handler runs (module evaluation of the
// handler modules never touches chrome; only function bodies do).
const tabStore = new Map<
  number,
  { id: number; windowId: number; url: string; title: string; active: boolean }
>();
(globalThis as unknown as { chrome: unknown }).chrome = {
  tabs: {
    get: async (id: number) =>
      tabStore.get(id) ?? Promise.reject(new Error(`No tab ${id}`)),
    query: async () => [] as unknown[],
    update: async () => ({}),
    remove: async () => ({}),
    create: async () => ({}),
  },
  scripting: { executeScript: async () => [{ result: null }] },
  action: { setBadgeBackgroundColor: () => {}, setBadgeText: () => {} },
  storage: {
    session: { get: async () => ({}), set: async () => {} },
    local: { get: async () => ({}), set: async () => {} },
  },
  runtime: {
    sendMessage: async () => {},
    onMessage: { addListener: () => {} },
  },
  alarms: { create: () => {}, onAlarm: { addListener: () => {} } },
  webRequest: { onCompleted: { addListener: () => {} } },
  debugger: {
    attach: async () => {},
    detach: async () => {},
    sendCommand: async () => ({}),
  },
};

const { handleMessage, dispatchedTools } = await import('../extension/lib/router.js');
const { tabLocks, tabControl, wedgedTabs } = await import('../extension/lib/state.js');
const { allTools } = await import('../mcp-server/src/tools/index.js');

function lastFrame(): Record<string, unknown> {
  return sent[sent.length - 1]!;
}

/** The runOnTab path (tabId present) is fire-and-forget in handleMessage —
 *  let the mutex + overlay chain settle before asserting on the reply. */
async function flush(ms = 60): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

describe("extension router (handleMessage)", () => {
  beforeEach(() => {
    sent.length = 0;
    tabStore.clear();
    tabLocks.unlockAll();
    (globalThis as any).chrome.scripting.executeScript = async () => [{ result: null }];
    tabStore.set(3, { id: 3, windowId: 1, url: 'https://example.com/page', title: 'Page', active: true });
  });

  it("answers an unknown tool with a wire-level error", async () => {
    await handleMessage({ id: "n1", tool: "browser_nope", params: {} });
    expect(lastFrame()).toMatchObject({ id: "n1", success: false });
    expect(lastFrame().error as string).toContain("Unknown tool");
  });

  it("marks in-band {success:false} results as wire failures WITH the payload (unified error channel)", async () => {
    // browser_wait without selector/delay returns in-band {success:false} —
    // the router must send success:false + the payload as `result`, not wrap
    // it in a success envelope.
    await handleMessage({
      id: "w1",
      tool: "browser_wait",
      params: { tabId: 3 },
      sessionId: "s1",
    });
    await flush();
    const frame = lastFrame();
    expect(frame.id).toBe("w1");
    expect(frame.success).toBe(false);
    expect(frame.error).toBe('Need selector, text, urlIncludes or delay');
    expect(frame.result).toEqual({ success: false, error: 'Need selector, text, urlIncludes or delay' });
  });

  it('frozen-tab navigate cannot replace a tab locked by another session', async () => {
    const created: unknown[] = [];
    const removed: number[] = [];
    (globalThis as any).chrome.tabs.create = async (o: unknown) => { created.push(o); return { id: 99 }; };
    (globalThis as any).chrome.tabs.remove = async (id: number) => { removed.push(id); };
    tabLocks.lock(3, 'session-a');
    wedgedTabs.set(3, Date.now());
    await handleMessage({ id: 'fz1', tool: 'browser_navigate', params: { tabId: 3, url: 'https://example.com/x', snapshot: false }, sessionId: 'session-b' });
    await flush();
    expect(lastFrame()).toMatchObject({ id: 'fz1', success: false });
    expect(String(lastFrame().error)).toMatch(/locked by session-a/);
    expect(created).toEqual([]);
    expect(removed).toEqual([]);
    expect(tabLocks.owner(3)).toBe('session-a');
    wedgedTabs.clear();
  });

  it('the lock owner recovering its own frozen tab keeps the lock on the replacement', async () => {
    const { replaceFrozenTab } = await import('../extension/lib/page-exec.js');
    (globalThis as any).chrome.tabs.create = async () => ({ id: 99 });
    (globalThis as any).chrome.tabs.remove = async () => {};
    tabLocks.lock(3, 'session-a');
    wedgedTabs.set(3, Date.now());
    await expect(replaceFrozenTab({ id: 3, windowId: 1, index: 0, active: true }, null, 'session-b')).rejects.toThrow(/locked by session-a/);
    const fresh = await replaceFrozenTab({ id: 3, windowId: 1, index: 0, active: true }, null, 'session-a');
    expect(fresh.id).toBe(99);
    expect(tabLocks.owner(99)).toBe('session-a');
    expect(tabLocks.owner(3)).toBeUndefined();
    wedgedTabs.clear();
  });

  it('agent control follows a frozen tab to its replacement (popup must not show it "free")', async () => {
    const { replaceFrozenTab } = await import('../extension/lib/page-exec.js');
    (globalThis as any).chrome.tabs.create = async () => ({ id: 98 });
    (globalThis as any).chrome.tabs.remove = async () => {};
    wedgedTabs.set(3, Date.now());
    const call = tabControl.begin(3, 'session-a', 'Claude'); // the recovering navigate
    await replaceFrozenTab({ id: 3, windowId: 1, index: 0, active: true }, 'https://example.com/x', 'session-a');
    expect(tabControl.controller(3)).toBeUndefined();
    expect(tabControl.controller(98)).toEqual({ sessionId: 'session-a', agentName: 'Claude', active: true });
    tabControl.end(call); // the call's end lands on the replacement
    expect(tabControl.controller(98)?.active).toBe(false);
    tabControl.release(98);
    wedgedTabs.clear();
  });

  it("converts a THROWN handler error into a wire-level error", async () => {
    // click with neither ref nor selector throws in requireTarget.
    await handleMessage({
      id: "c1",
      tool: "browser_click",
      params: { tabId: 3 },
      sessionId: "s1",
    });
    await flush();
    const frame = lastFrame();
    expect(frame.id).toBe("c1");
    expect(frame.success).toBe(false);
    expect(frame.error as string).toContain("ref or selector is required");
  });

  it("routes a successful tool through the mutex and replies success", async () => {
    await handleMessage({
      id: "k1",
      tool: "browser_network",
      params: { tabId: 3 },
      sessionId: "s1",
    });
    await flush();
    const frame = lastFrame();
    expect(frame.id).toBe("k1");
    expect(frame.success).toBe(true);
    expect((frame.result as { requests: unknown[] }).requests).toEqual([]);
  });

  it("honors tab-lock ownership: a non-owner call waits instead of running (TOCTOU fix, end-to-end)", async () => {
    tabLocks.lock(3, "ownerA");
    await handleMessage({
      id: "k2",
      tool: "browser_network",
      params: { tabId: 3 },
      sessionId: "sessionB",
    });
    // No reply yet — B is queued behind owner A's lock.
    expect(sent.filter((f) => f.id === "k2")).toEqual([]);
    tabLocks.unlock(3, "ownerA");
    await new Promise((r) => setTimeout(r, 120));
    const frame = sent.find((f) => f.id === "k2");
    expect(frame?.success).toBe(true);
  });
});

describe('dispatch registry ↔ MCP tool registry (drift guard)', () => {
  // Server-local tools never reach the extension: browser_batch runs other
  // tools' handlers in the MCP process (the meta tool isn't in allTools).
  // browser_batch runs in the MCP process; browser selection is answered by the bridge.
  const wireTools = allTools.filter((t) => !['browser_batch', 'browser_shortcuts', 'browser_list_browsers', 'browser_select_browser'].includes(t.name));

  it('every registered MCP tool has an extension handler', () => {
    for (const tool of wireTools) {
      expect(dispatchedTools, `${tool.name} has no extension handler`).toContain(tool.name);
    }
  });

  it('dispatches exactly the known tool set (no stray handlers)', () => {
    expect(dispatchedTools.length).toBe(wireTools.length);
  });
});
