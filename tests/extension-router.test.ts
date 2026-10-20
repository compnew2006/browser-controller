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
    // browser_wait that times out returns in-band {success:false} — the router must
    // send success:false + the payload as `result`, not wrap it in a success envelope.
    await handleMessage({
      id: "w1",
      tool: "browser_wait",
      params: { tabId: 3, url: "https://never.test/x", timeout: 1 },
      sessionId: "s1",
    });
    await flush();
    const frame = lastFrame();
    expect(frame.id).toBe("w1");
    expect(frame.success).toBe(false);
    expect(frame.error).toMatch(/^TIMEOUT: url containing "https:\/\/never\.test\/x" not met after 1 ms$/);
    expect(frame.result).toEqual({ success: false, error: frame.error });
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

  it('a dialog answer from a non-owner is refused with TAB_LOCKED (it skips the queue, not the lock)', async () => {
    const debuggerCalls: unknown[] = [];
    const debugger0 = (globalThis as any).chrome.debugger;
    const realSend = debugger0.sendCommand;
    debugger0.sendCommand = async (...args: unknown[]) => { debuggerCalls.push(args); return {}; };
    tabLocks.lock(3, 'session-a', { agentName: 'Claude', since: 1000 });
    await handleMessage({ id: 'd1', tool: 'browser_handle_dialog', params: { tabId: 3, action: 'accept' }, sessionId: 'session-b' });
    await flush();
    expect(sent.find((f) => f.id === 'd1')).toMatchObject({ success: false });
    expect(String(sent.find((f) => f.id === 'd1')?.error)).toMatch(/^TAB_LOCKED: tab 3 is locked by Claude \(session session-a\)/);
    expect(debuggerCalls).toEqual([]); // the dialog was never touched
    // The owner is not refused by the lock (whatever the dialog handler then says).
    await handleMessage({ id: 'd2', tool: 'browser_handle_dialog', params: { tabId: 3, action: 'accept' }, sessionId: 'session-a' });
    await flush();
    expect(String(sent.find((f) => f.id === 'd2')?.error ?? '')).not.toMatch(/TAB_LOCKED/);
    tabLocks.release(3);
    debugger0.sendCommand = realSend;
  });

  it('the lock owner recovering its own frozen tab keeps the lock on the replacement', async () => {
    const { replaceFrozenTab } = await import('../extension/lib/page-exec.js');
    (globalThis as any).chrome.tabs.create = async () => ({ id: 99 });
    (globalThis as any).chrome.tabs.remove = async () => {};
    tabLocks.lock(3, 'session-a');
    wedgedTabs.set(3, Date.now());
    await expect(replaceFrozenTab({ id: 3, windowId: 1, index: 0, active: true }, null, 'session-b')).rejects.toThrow(/^TAB_LOCKED: tab 3 is locked by session-a/);
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
    // click with no target throws in parseTarget (INVALID_ARGUMENT, before any page is touched).
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
    expect(frame.error as string).toContain("INVALID_ARGUMENT: target is empty");
  });

  it("routes a successful tool through the mutex and replies success", async () => {
    await handleMessage({
      id: "k1",
      tool: "browser_logs",
      params: { tabId: 3 },
      sessionId: "s1",
    });
    await flush(400); // the console read settles for 100 ms before it answers
    const frame = lastFrame();
    expect(frame.id).toBe("k1");
    expect(frame.success).toBe(true);
    expect((frame.result as { requests: unknown[] }).requests).toEqual([]);
  });

  it("honors tab-lock ownership: a non-owner call is refused at once with TAB_LOCKED (end-to-end)", async () => {
    tabLocks.lock(3, "ownerA");
    await handleMessage({
      id: "k2",
      tool: "browser_logs",
      params: { tabId: 3 },
      sessionId: "sessionB",
    });
    await flush();
    const frame = sent.find((f) => f.id === "k2");
    expect(frame).toMatchObject({ success: false });
    expect(String(frame?.error)).toMatch(/^TAB_LOCKED: tab 3 is locked by ownerA since /);
    // The refused call never ran, so this session never became the tab's controller.
    expect(tabControl.controller(3)?.sessionId).not.toBe("sessionB");
    tabLocks.unlock(3, "ownerA");
    await handleMessage({ id: "k3", tool: "browser_logs", params: { tabId: 3 }, sessionId: "sessionB" });
    await flush(400);
    expect(sent.find((f) => f.id === "k3")).toMatchObject({ success: true });
  });

  it("names the lock owner by its agent name in the TAB_LOCKED refusal", async () => {
    // The owner's first call records its agent name; the lock taken later carries it.
    await handleMessage({ id: "o1", tool: "browser_logs", params: { tabId: 3 }, sessionId: "owner-s", agentName: "Claude" });
    await flush();
    tabLocks.lock(3, "owner-s");
    await handleMessage({ id: "k4", tool: "browser_logs", params: { tabId: 3 }, sessionId: "sessionC", agentName: "Cursor" });
    await flush();
    const frame = sent.find((f) => f.id === "k4");
    expect(frame).toMatchObject({ success: false });
    expect(String(frame?.error)).toMatch(/^TAB_LOCKED: tab 3 is locked by Claude \(session owner-s\) since /);
    tabLocks.release(3);
  });
});

describe('dispatch registry ↔ MCP tool registry (drift guard)', () => {
  // browser_batch is server-only: it runs other tools' handlers in the MCP process, so it has no extension handler.
  const wireTools = allTools.filter((t) => t.name !== 'browser_batch');

  it('every registered MCP tool has an extension handler', () => {
    for (const tool of wireTools) {
      expect(dispatchedTools, `${tool.name} has no extension handler`).toContain(tool.name);
    }
  });

  it('dispatches exactly the known tool set (no stray handlers)', () => {
    expect(dispatchedTools.length).toBe(wireTools.length);
  });
});
