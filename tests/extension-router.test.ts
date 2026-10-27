import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

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

// The shield steps are spied on, so a test can tell whether the frame was drawn or removed.
vi.mock("../extension/lib/overlay.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../extension/lib/overlay.js")>();
  return {
    ...actual,
    showLockShield: vi.fn(actual.showLockShield),
    hideLockShield: vi.fn(actual.hideLockShield),
  };
});

// chrome.* mock — must exist before any handler runs (module evaluation of the
// handler modules never touches chrome; only function bodies do).
const tabStore = new Map<
  number,
  { id: number; windowId: number; url: string; title: string; active: boolean }
>();
/** The debugger session's event listeners (cdp-session.js): a test opens a JS dialog through them. */
const dialogListeners: Array<(source: { tabId: number }, method: string, params?: unknown) => void> = [];
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
  webNavigation: {
    getFrame: async () => ({ frameId: 0, documentId: 'doc-router', url: 'https://example.com/page' }),
    getAllFrames: async () => [{ frameId: 0, documentId: 'doc-router', url: 'https://example.com/page' }],
  },
  action: { setBadgeBackgroundColor: () => {}, setBadgeText: () => {} },
  storage: {
    session: { get: async () => ({}), set: async () => {} },
    local: { get: async () => ({}), set: async () => {}, remove: async () => {} },
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
    onEvent: { addListener: (fn: (typeof dialogListeners)[number]) => { dialogListeners.push(fn); } },
  },
};

const { handleMessage, dispatchedTools } = await import('../extension/dispatch/router.js');
const { tabLocks, tabMutex, tabControl, wedgedTabs } = await import('../extension/lib/state.js');
const { allTools } = await import('../mcp-server/src/tools/index.js');
const overlay = await import('../extension/lib/overlay.js');

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

  it('releases the vault tab mutex when a frozen fill is cancelled after dispatch', async () => {
    const vault = await import('../extension/lib/vault-actions.js');
    await vault.restoreVaultRuntimeState();
    let didStart = false;
    let fillStarted!: () => void;
    const started = new Promise<void>((resolve) => { fillStarted = resolve; });
    let releaseFrozenScript!: (value: unknown[]) => void;
    (globalThis as any).chrome.scripting.executeScript = async (request: Record<string, any>) => {
      if (request.func.name === 'inspectPasswordField') {
        return [{ frameId: 0, documentId: 'doc-router', result: {
          candidateCount: 1, suitable: true, documentOrigin: 'https://example.com',
        } }];
      }
      if (request.func.name === 'fillInspectedPassword') {
        didStart = true;
        fillStarted();
        return await new Promise((resolve) => { releaseFrozenScript = resolve; });
      }
      return [{ frameId: 0, documentId: 'doc-router', result: true }];
    };
    const inspection = await vault.handleVaultAction('inspect', { tabId: 3 }) as any;
    const fillFrame = {
      type: 'vaultAction', id: 'v887', action: 'fill', sessionId: 'session-vault',
      params: {
        tabId: 3, origin: 'https://example.com', documentId: 'doc-router',
        targetDocumentId: 'doc-router', frameId: 0, nonce: inspection.nonce, password: 'fixture-only-secret',
      },
    };
    void handleMessage(fillFrame);
    await flush(100);
    expect(didStart).toBe(true);
    await started;
    await handleMessage({ type: 'vaultActionCancel', id: 'v887' });
    await flush(80);
    expect(lastFrame()).toMatchObject({ type: 'vaultActionResponse', id: 'v887', result: { success: false, code: 'VAULT_OUTCOME_UNKNOWN' } });
    expect(tabMutex.isIdle(3)).toBe(true);
    // A frozen browser call may settle after cancellation, but it cannot hold
    // the router mutex or produce another response when it eventually returns.
    releaseFrozenScript([{ frameId: 0, documentId: 'doc-router', result: { success: true, retained: true, filled_fields: 1 } }]);
    await flush(20);
    expect(sent.filter((frame) => frame.type === 'vaultActionResponse' && frame.id === 'v887')).toHaveLength(1);
    expect(tabMutex.isIdle(3)).toBe(true);
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

describe('the router and a JavaScript dialog open on the tab', () => {
  const emitPage = (method: string, params?: unknown) => {
    for (const fn of dialogListeners) fn({ tabId: 3 }, method, params);
  };
  beforeEach(() => {
    vi.mocked(overlay.showLockShield).mockClear();
    vi.mocked(overlay.hideLockShield).mockClear();
  });
  afterEach(() => {
    emitPage('Page.javascriptDialogClosed', { result: true, userInput: '' });
  });

  it('a success on a tab whose dialog is open gets the dialog: line the input tools give', async () => {
    emitPage('Page.javascriptDialogOpening', { type: 'alert', message: 'Welcome back', url: 'https://example.com/page' });
    await handleMessage({ id: 'dl1', tool: 'browser_wait', params: { tabId: 3, ms: 1 }, sessionId: 's1' });
    await flush();
    const frame = sent.find((f) => f.id === 'dl1');
    expect(frame?.success).toBe(true);
    const text = String((frame?.result as { text?: string }).text);
    expect(text.split('\n').at(-1)).toBe('dialog: alert "Welcome back"');
    expect(text).toMatch(/^ok after \d+ ms\n/);
  });

  it('the frame is not drawn while a dialog blocks the tab, and is drawn again once it is answered', async () => {
    const scripts: unknown[] = [];
    (globalThis as any).chrome.scripting.executeScript = async (o: unknown) => { scripts.push(o); return [{ result: null }]; };
    emitPage('Page.javascriptDialogOpening', { type: 'confirm', message: 'Sure?', url: 'https://example.com/page' });
    await handleMessage({ id: 'dl2', tool: 'browser_wait', params: { tabId: 3, ms: 1 }, sessionId: 's1' });
    await flush();
    expect(overlay.showLockShield).not.toHaveBeenCalled();
    emitPage('Page.javascriptDialogClosed', { result: true, userInput: '' });
    await handleMessage({ id: 'dl3', tool: 'browser_wait', params: { tabId: 3, ms: 1 }, sessionId: 's1' });
    await flush();
    expect(overlay.showLockShield).toHaveBeenCalledTimes(1);
    expect(sent.find((f) => f.id === 'dl3')).toMatchObject({ success: true });
  });

  it('removes the frame drawn by a call whose own dialog is open at its end, without waiting for the dialog', async () => {
    emitPage('Page.javascriptDialogClosed', { result: true, userInput: '' });
    // A slow wait: the frame is drawn first, then the page opens a dialog while the call runs.
    await handleMessage({ id: 'dl4', tool: 'browser_wait', params: { tabId: 3, ms: 40 }, sessionId: 's1' });
    await new Promise((r) => setTimeout(r, 10));
    emitPage('Page.javascriptDialogOpening', { type: 'alert', message: 'Saved', url: 'https://example.com/page' });
    // The removal waits on the dialog: its injection settles only once the dialog is answered.
    vi.mocked(overlay.hideLockShield).mockImplementationOnce(() => new Promise<void>(() => {}));
    await flush(80);
    expect(overlay.showLockShield).toHaveBeenCalledTimes(1);
    expect(overlay.hideLockShield).toHaveBeenCalledWith(3);
    expect(sent.find((f) => f.id === 'dl4')).toMatchObject({ success: true });
    // Not awaited: the tab's mutex is free, so the next call on it answers at once.
    await handleMessage({ id: 'dl5', tool: 'browser_wait', params: { tabId: 3, ms: 1 }, sessionId: 's1' });
    await flush();
    expect(sent.find((f) => f.id === 'dl5')).toMatchObject({ success: true });
  });

  it('a wedged tab takes no removal, even while a dialog is open on it', async () => {
    wedgedTabs.set(3, Date.now());
    emitPage('Page.javascriptDialogOpening', { type: 'alert', message: 'Stuck', url: 'https://example.com/page' });
    await handleMessage({ id: 'dl6', tool: 'browser_wait', params: { tabId: 3, ms: 1 }, sessionId: 's1' });
    await flush();
    expect(sent.find((f) => f.id === 'dl6')).toMatchObject({ success: true });
    expect(overlay.hideLockShield).not.toHaveBeenCalled();
    expect(overlay.showLockShield).not.toHaveBeenCalled();
    wedgedTabs.clear();
  });
});

describe('the router and a file chooser that agent input opened', () => {
  const textOf = (id: string) => String((sent.find((f) => f.id === id)?.result as { text?: string }).text);

  it('the next success on the tab says once that it was not shown and how to upload instead', async () => {
    for (const fn of dialogListeners) fn({ tabId: 3 }, 'Page.fileChooserOpened', { frameId: 'f1', mode: 'selectMultiple', backendNodeId: 5 });
    await handleMessage({ id: 'fc1', tool: 'browser_wait', params: { tabId: 3, ms: 1 }, sessionId: 's1' });
    await flush();
    await handleMessage({ id: 'fc2', tool: 'browser_wait', params: { tabId: 3, ms: 1 }, sessionId: 's1' });
    await flush();
    expect(textOf('fc1').split('\n').at(-1)).toBe('fileChooser: the page opened a file chooser (several files); it was not shown. To upload, browser_fill the file input, its label or the upload button with absolute paths.');
    expect((sent.find((f) => f.id === 'fc1')?.result as { fileChooser?: unknown }).fileChooser).toEqual({ mode: 'selectMultiple' });
    expect(textOf('fc2')).not.toMatch(/fileChooser/);
  });
});

describe('dispatch registry ↔ MCP tool registry (drift guard)', () => {
  // browser_batch and browser_safety are server-only; browser_vault is daemon-owned
  // and uses private internal frames rather than the generic extension tool dispatcher.
  // browser_memory is daemon-owned too: it reaches the extension only through the internal context action.
  const wireTools = allTools.filter((t) => !['browser_batch', 'browser_safety'].includes(t.name));
  const extensionTools = wireTools.filter((t) => !['browser_vault', 'browser_memory'].includes(t.name));

  it('every registered MCP tool has an extension handler', () => {
    for (const tool of extensionTools) {
      expect(dispatchedTools, `${tool.name} has no extension handler`).toContain(tool.name);
    }
  });

  it('dispatches exactly the known tool set (no stray handlers)', () => {
    expect(dispatchedTools).toEqual(extensionTools.map((tool) => tool.name));
  });

  it('keeps the daemon-owned vault tool and internal vault actions out of the extension registry', () => {
    expect(wireTools.map((tool) => tool.name).filter((name) => name === 'browser_vault')).toEqual(['browser_vault']);
    expect(dispatchedTools).not.toContain('browser_vault');
    expect(allTools.map((tool) => tool.name).some((name) => name.startsWith('browser_vault_internal_'))).toBe(false);
  });

  it('keeps the daemon-owned memory tool and its internal context action out of the public registry', () => {
    expect(dispatchedTools).not.toContain('browser_memory');
    expect(dispatchedTools).not.toContain('browser_memory_internal_context');
    expect(allTools.map((tool) => tool.name)).not.toContain('browser_memory_internal_context');
  });
});
