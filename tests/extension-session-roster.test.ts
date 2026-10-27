import { vi, describe, it, expect, beforeEach } from 'vitest';

/**
 * F4-2: the daemon sends the live session ids when a connection becomes ready; the extension
 * releases every lock and tab setting owned by a session that is not listed (its release was
 * lost while the extension was disconnected). F4-3: while the saved lock state could not be
 * read, tool calls are refused. F6-5: browser_classify_action stays internal and read-only.
 */

const sent = vi.hoisted(() => [] as Array<Record<string, unknown>>);
const storage = vi.hoisted(() => ({ failReads: false }));
const injections = vi.hoisted(() => [] as Array<{ target: number; func: string; args: unknown[] }>);
const listeners = vi.hoisted(() => ({
  message: [] as Array<(...args: unknown[]) => unknown>,
  updated: [] as Array<(...args: unknown[]) => unknown>,
}));

vi.mock('../extension/lib/connection.js', () => ({
  sendJson: (obj: Record<string, unknown>) => { sent.push(obj); },
  updateBadge: (status: string) => {
  },
  broadcastStatus: async () => {},
  isWsConnected: () => true,
  setCurrentActivity: () => {},
  getOpenTabs: async () => [],
  buildStatusPayload: () => ({}),
  applyPort: () => ({}),
  applyToken: () => ({}),
  applyEnrollment: async () => {},
}));

const tabStore = new Map<number, { id: number; windowId: number; url: string; title: string; active: boolean }>();
(globalThis as unknown as { chrome: unknown }).chrome = {
  tabs: {
    get: async (id: number) => {
      const t = tabStore.get(id);
      if (!t) throw new Error(`No tab ${id}`);
      return t;
    },
    query: async () => [...tabStore.values()],
    update: async () => ({}),
    remove: async () => ({}),
    create: async () => ({}),
    captureVisibleTab: async () => 'data:image/png;base64,QUJD',
    onRemoved: { addListener: () => {} },
    onReplaced: { addListener: () => {} },
    onUpdated: { addListener: (fn: (...args: unknown[]) => unknown) => { listeners.updated.push(fn); } },
    onActivated: { addListener: () => {} },
  },
  webNavigation: {
    onCreatedNavigationTarget: { addListener: () => {} },
    onCommitted: { addListener: () => {} },
  },
  scripting: {
    executeScript: async (opts: { target: { tabId: number }; func: () => void; args?: unknown[] }) => {
      injections.push({ target: opts.target.tabId, func: opts.func.toString(), args: opts.args ?? [] });
      return [{ result: null }];
    },
  },
  action: { setBadgeBackgroundColor: () => {}, setBadgeText: () => {} },
  storage: {
    session: { get: async () => { if (storage.failReads) throw new Error('read failed'); return {}; }, set: async () => {} },
    local: { get: async () => ({}), set: async () => {} },
  },
  runtime: {
    sendMessage: async () => {},
    onMessage: { addListener: (fn: (...args: unknown[]) => unknown) => { listeners.message.push(fn); } },
  },
  alarms: { create: () => {}, onAlarm: { addListener: () => {} } },
  webRequest: {
    onBeforeRequest: { addListener: () => {} },
    onSendHeaders: { addListener: () => {} },
    onCompleted: { addListener: () => {} },
    onErrorOccurred: { addListener: () => {} },
  },
  debugger: { attach: async () => {}, detach: async () => {}, sendCommand: async () => ({}) },
};

// The screenshot path decodes and encodes with canvas APIs (service worker only; absent in Node).
(globalThis as unknown as { createImageBitmap: unknown }).createImageBitmap = async () => ({ width: 800, height: 600, close() {} });
(globalThis as unknown as { OffscreenCanvas: unknown }).OffscreenCanvas = class {
  constructor(public width: number, public height: number) {}
  getContext() { return { imageSmoothingQuality: 'low', drawImage() {} }; }
  async convertToBlob(opts: { type: string }) { return new Blob([new Uint8Array(8)], { type: opts.type }); }
};

const { handleMessage, dispatch, dispatchedTools } = await import('../extension/dispatch/router.js');
const { loadSessionState } = await import('../extension/lib/state.js');
const { tabLocks, claimTabSetting, tabSettingOwner, sessionAgentNames } = await import('../extension/lib/state.js');

const flush = (ms = 20) => new Promise((r) => setTimeout(r, ms));

describe('sessionRoster releases the locks of absent sessions (F4-2)', () => {
  beforeEach(() => {
    sent.length = 0;
    injections.length = 0;
    tabStore.clear();
    tabLocks.unlockAll();
    sessionAgentNames.clear();
  });

  it('releases locks and settings owned by sessions not in the roster, keeps the listed ones', async () => {
    tabLocks.lock(1, 'gone');
    tabLocks.lock(2, 'live');
    claimTabSetting(1, 'emulation', 'gone');
    claimTabSetting(2, 'emulation', 'live');
    sessionAgentNames.set('gone', 'Gone Agent');

    await handleMessage({ type: 'sessionRoster', sessionIds: ['live'] });

    expect(tabLocks.owner(1)).toBeUndefined();
    expect(tabLocks.owner(2)).toBe('live');
    expect(tabSettingOwner(1, 'emulation')).toBeUndefined();
    expect(tabSettingOwner(2, 'emulation')).toBe('live');
    expect(sessionAgentNames.has('gone')).toBe(false);
    expect(sent).toEqual([]); // a control frame: no response
  });

  it('an empty roster releases everyone', async () => {
    tabLocks.lock(1, 'a');
    tabLocks.lock(2, 'b');
    await handleMessage({ type: 'sessionRoster', sessionIds: [] });
    expect(tabLocks.snapshot()).toEqual([]);
  });

  it('a malformed roster releases nothing', async () => {
    tabLocks.lock(1, 'a');
    await handleMessage({ type: 'sessionRoster' });
    await handleMessage({ type: 'sessionRoster', sessionIds: 'a' });
    await handleMessage({ type: 'sessionRoster', sessionIds: ['a', 5] });
    expect(tabLocks.owner(1)).toBe('a');
  });
});

describe('F6-5: browser_classify_action is internal-only and read-only', () => {
  beforeEach(() => {
    sent.length = 0;
    injections.length = 0;
    tabStore.clear();
    tabLocks.unlockAll();
    tabStore.set(3, { id: 3, windowId: 1, url: 'https://example.com/', title: 'P', active: true });
  });

  it('is not a public wire tool, yet dispatch reaches it: the server safety gate calls it through the bridge', async () => {
    expect(dispatchedTools).not.toContain('browser_classify_action');
    const result = await dispatch('browser_classify_action', { tabId: 3, action: 'browser_click', hover: true }, 's1', 'A');
    expect(result).toMatchObject({ categories: [] });
  });

  it('changes nothing: no lock, no control, no injected page write', async () => {
    await dispatch('browser_classify_action', { tabId: 3, action: 'browser_fill', fields: [] }, 's1', 'A');
    expect(tabLocks.snapshot()).toEqual([]);
    expect(injections).toEqual([]);
  });
});

describe('F4-3: tool calls are refused while the saved lock state is unreadable', () => {
  it('answers STATE_UNAVAILABLE, then serves again once the read succeeds', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    sent.length = 0;
    tabStore.set(3, { id: 3, windowId: 1, url: 'https://example.com/', title: 'P', active: true });
    storage.failReads = true;
    await loadSessionState({ retryDelaysMs: [] });

    await handleMessage({ id: 'u1', tool: 'browser_wait', params: { tabId: 3, ms: 1 }, sessionId: 's1' });
    expect(sent.find((f) => f.id === 'u1')).toMatchObject({ success: false });
    expect(String(sent.find((f) => f.id === 'u1')?.error)).toMatch(/^STATE_UNAVAILABLE:/);

    storage.failReads = false;
    await loadSessionState();
    await handleMessage({ id: 'u2', tool: 'browser_wait', params: { tabId: 3, ms: 1 }, sessionId: 's1' });
    await flush(60);
    expect(sent.find((f) => f.id === 'u2')?.success).toBe(true);
  });
});
