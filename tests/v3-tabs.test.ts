import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Browser Controller 3.0 tabs: browser_navigate opens and owns the tabs a
 * session makes (TAB_LOCKED for everyone else), user tabs stay shared,
 * browser_tabs answers in compact lines, back / forward / reload and scheme-less
 * addresses, the 15 s load wait, and the emulate viewport (never a window resize).
 */

const sent = vi.hoisted(() => [] as Array<Record<string, unknown>>);

vi.mock('../extension/lib/connection.js', () => ({
  sendJson: (obj: Record<string, unknown>) => { sent.push(obj); },
  updateBadge: () => {},
  broadcastStatus: () => {},
  isWsConnected: () => true,
  setCurrentActivity: () => {},
}));

// The snapshot is V3-READ's handler: here only its call (maxChars) and its text matter.
const snapshot = vi.hoisted(() => ({ calls: [] as unknown[], reply: { success: true, text: 'document' } as Record<string, unknown> }));
vi.mock('../extension/handlers/inspection.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  handleSnapshot: async (params: unknown) => { snapshot.calls.push(params); return snapshot.reply; },
}));

type Listener = (...args: any[]) => void;
type Tab = { id: number; windowId: number; index: number; url: string; title: string; active: boolean; status: string };

const FOCUSED_WINDOW = 1;
const tabStore = new Map<number, Tab>();
const windowUpdates: Array<[number, Record<string, unknown>]> = [];
const tabUpdates: Array<[number, Record<string, unknown>]> = [];
const created: Array<Record<string, unknown>> = [];
const removed: number[] = [];
const reloads: number[] = [];
const debuggerCalls: Array<[string, unknown]> = [];
let nextTabId = 60;
const onUpdated = new Set<Listener>();
const headerListeners = new Set<Listener>();
const errorListeners = new Set<Listener>();
let reactTo: (tabId: number, url: string) => void = () => {};

const emitUpdated = (id: number, info: Record<string, unknown>) => { for (const fn of [...onUpdated]) fn(id, info, tabStore.get(id)); };
const emitHeaders = (details: Record<string, unknown>) => { for (const fn of [...headerListeners]) fn(details); };
const tabOf = (id: number) => {
  const t = tabStore.get(id);
  if (!t) throw new Error(`No tab with id: ${id}`);
  return { ...t };
};

(globalThis as unknown as { chrome: unknown }).chrome = {
  tabs: {
    get: async (id: number) => tabOf(id),
    query: async (q: { active?: boolean; lastFocusedWindow?: boolean } = {}) => [...tabStore.values()]
      .filter((t) => (q.active === undefined || t.active === q.active) && (!q.lastFocusedWindow || t.windowId === FOCUSED_WINDOW))
      .map((t) => ({ ...t })),
    create: async (o: Record<string, unknown>) => {
      created.push(o);
      const id = nextTabId++;
      tabStore.set(id, {
        id, windowId: (o.windowId as number) ?? FOCUSED_WINDOW, index: 0,
        url: String(o.url ?? 'about:blank'), title: '', active: o.active !== false, status: 'complete',
      });
      return tabOf(id);
    },
    update: async (id: number, props: Record<string, unknown>) => {
      tabUpdates.push([id, props]);
      const t = tabOf(id);
      if (props.active === true) {
        for (const other of tabStore.values()) if (other.windowId === t.windowId) other.active = false;
        tabStore.get(id)!.active = true;
      }
      if (typeof props.url === 'string') setTimeout(() => reactTo(id, props.url as string), 0);
      return tabOf(id);
    },
    reload: async (id: number) => {
      reloads.push(id);
      setTimeout(() => { emitUpdated(id, { status: 'loading' }); emitUpdated(id, { status: 'complete' }); }, 0);
    },
    remove: async (id: number) => { removed.push(id); tabStore.delete(id); },
    onRemoved: { addListener: () => {} },
    onUpdated: { addListener: (fn: Listener) => onUpdated.add(fn), removeListener: (fn: Listener) => onUpdated.delete(fn) },
  },
  windows: {
    update: async (id: number, u: Record<string, unknown>) => { windowUpdates.push([id, u]); return { id, ...u }; },
    get: async () => ({ width: 1280, height: 900 }),
  },
  webRequest: {
    onHeadersReceived: { addListener: (fn: Listener) => headerListeners.add(fn), removeListener: (fn: Listener) => headerListeners.delete(fn) },
    onErrorOccurred: { addListener: (fn: Listener) => errorListeners.add(fn), removeListener: (fn: Listener) => errorListeners.delete(fn) },
    onCompleted: { addListener: () => {} },
  },
  scripting: { executeScript: async () => [{ result: null }] },
  storage: {
    session: { get: async () => ({}), set: async () => {} },
    local: { get: async () => ({}), set: async () => {} },
  },
  runtime: { sendMessage: async () => {}, onMessage: { addListener: () => {} } },
  action: { setBadgeBackgroundColor: () => {}, setBadgeText: () => {} },
  alarms: { create: () => {}, onAlarm: { addListener: () => {} } },
  debugger: {
    attach: async () => {},
    detach: async () => {},
    sendCommand: async (_t: unknown, method: string, params: unknown) => {
      debuggerCalls.push([method, params]);
      return { result: { value: 1 } };
    },
    onEvent: { addListener: () => {} },
    onDetach: { addListener: () => {} },
  },
};

const { handleMessage } = await import('../extension/lib/router.js');
const { handleNavigate } = await import('../extension/handlers/navigation.js');
const { handleTabs } = await import('../extension/handlers/tabs.js');
const { handleEmulate } = await import('../extension/handlers/emulate.js');
const { emulationPlan } = await import('../extension/lib/emulation.js');
const { detachCdp, hasCdp, pinCdp, unpinCdp } = await import('../extension/lib/cdp-session.js');
const { tabLocks, tabControl, wedgedTabs, sessionAgentNames } = await import('../extension/lib/state.js');

/** A page that answers every load with the given HTTP status, the way Chrome reports it. */
const answerWith = (statusCode: number) => (id: number, url: string) => {
  tabStore.get(id)!.url = url;
  emitHeaders({ tabId: id, url, statusCode, responseHeaders: [] });
  emitUpdated(id, { status: 'loading' });
  emitUpdated(id, { status: 'complete' });
};

const flush = () => new Promise((r) => setTimeout(r, 60));
const resultOf = (id: string) => sent.find((f) => f.id === id);

/** Tab 1 is the user's focused tab; 2 and 5 are other user tabs; 3, 4 and 7 belong to sessions. */
function seedTabs() {
  tabStore.clear();
  const add = (id: number, over: Partial<Tab>) => tabStore.set(id, {
    id, windowId: FOCUSED_WINDOW, index: id, url: 'https://example.test/', title: `Tab ${id}`, active: false, status: 'complete', ...over,
  });
  add(1, { active: true, title: 'Inbox', url: 'https://mail.example.com/inbox' });
  add(2, { title: 'Docs', url: 'https://docs.example.com/a' });
  add(3, { title: 'Draft', url: 'https://app.example.com/new' });
  add(4, { title: 'Other agent tab', url: 'https://other.example.com/p' });
  add(5, { windowId: 2, title: 'Elsewhere', url: 'https://else.example.com/' });
  add(7, { title: 'x'.repeat(80), url: `https://long.example.com/${'p'.repeat(100)}` });
}

beforeEach(async () => {
  sent.length = 0;
  windowUpdates.length = 0;
  tabUpdates.length = 0;
  created.length = 0;
  removed.length = 0;
  reloads.length = 0;
  debuggerCalls.length = 0;
  snapshot.calls.length = 0;
  nextTabId = 60;
  onUpdated.clear();
  headerListeners.clear();
  errorListeners.clear();
  reactTo = () => {};
  seedTabs();
  tabLocks.unlockAll();
  tabControl.clear();
  wedgedTabs.clear();
  sessionAgentNames.clear();
  await detachCdp(4);
  debuggerCalls.length = 0;
});

afterEach(async () => {
  await detachCdp(4);
});

describe('browser_navigate without tabId', () => {
  it('opens a background tab in the last focused window, owned by the calling session, and loads the address there', async () => {
    reactTo = answerWith(200);
    const res = await handleNavigate({ url: 'example.com', snapshot: false }, 'session-a');
    expect(created).toEqual([{ url: 'about:blank', active: false, windowId: FOCUSED_WINDOW }]);
    expect(tabLocks.owner(60)).toBe('session-a');
    expect(res).toMatchObject({ success: true, tabId: 60, url: 'https://example.com', status: 200 });
    expect(res.text).toBe('tabId: 60\nurl: https://example.com\nstatus: 200');
  });

  it('a second session gets TAB_LOCKED on that tab, and only the owner can close it', async () => {
    reactTo = answerWith(200);
    await handleMessage({ id: 'o1', tool: 'browser_navigate', params: { url: 'https://example.com/a', snapshot: false }, sessionId: 'session-a', agentName: 'Claude' });
    expect(resultOf('o1')).toMatchObject({ success: true });
    const tabId = (resultOf('o1')!.result as { tabId: number }).tabId;

    await handleMessage({ id: 'o2', tool: 'browser_text', params: { tabId }, sessionId: 'session-b', agentName: 'Cursor' });
    await flush();
    expect(resultOf('o2')).toMatchObject({ success: false });
    expect(String(resultOf('o2')?.error)).toMatch(/^TAB_LOCKED: tab 60 is locked by Claude \(session session-a\) since /);

    await handleMessage({ id: 'o3', tool: 'browser_tabs', params: { action: 'close', tabId }, sessionId: 'session-b' });
    expect(String(resultOf('o3')?.error)).toMatch(/^TAB_LOCKED: /);
    expect(removed).toEqual([]);

    await handleMessage({ id: 'o4', tool: 'browser_tabs', params: { action: 'close', tabId }, sessionId: 'session-a' });
    expect(resultOf('o4')).toMatchObject({ success: true });
    expect(removed).toEqual([60]);
    expect(tabLocks.owner(60)).toBeUndefined();
  });

  it('never falls back to the active tab: the user tab is not navigated', async () => {
    reactTo = answerWith(200);
    await handleMessage({ id: 'o5', tool: 'browser_navigate', params: { url: 'https://example.com/b', snapshot: false }, sessionId: 'session-a' });
    expect(created).toHaveLength(1);
    expect(tabUpdates.every(([id]) => id === 60)).toBe(true);
  });

  it('a session ending gives its tab back to the shared pool', async () => {
    reactTo = answerWith(200);
    await handleNavigate({ url: 'https://example.com/c', snapshot: false }, 'session-a');
    await handleMessage({ type: 'releaseSession', sessionId: 'session-a' });
    expect(tabLocks.owner(60)).toBeUndefined();
  });

  it('back and forward need a tab that is already open', async () => {
    await expect(handleNavigate({ url: 'back' }, 'session-a')).rejects.toThrow(/^INVALID_ARGUMENT: "back" moves a tab/);
    expect(created).toEqual([]);
  });

  it('a call that names a tab opens nothing', async () => {
    reactTo = answerWith(200);
    await handleNavigate({ url: 'https://example.com/d', tabId: 1, snapshot: false }, 'session-a');
    expect(created).toEqual([]);
  });
});

describe('browser_navigate with tabId', () => {
  it('reload reloads the named tab in place, without a new address', async () => {
    const res = await handleNavigate({ url: 'reload', tabId: 1, snapshot: false }, 'session-a');
    expect(reloads).toEqual([1]);
    expect(tabUpdates.filter(([, p]) => 'url' in p)).toEqual([]);
    expect(res).toMatchObject({ success: true, tabId: 1, url: 'https://mail.example.com/inbox' });
  });

  it('a scheme-less localhost address loads over http', async () => {
    reactTo = answerWith(200);
    const res = await handleNavigate({ url: 'localhost:3000', tabId: 1, snapshot: false }, 'session-a');
    expect(tabUpdates).toEqual([[1, { url: 'http://localhost:3000' }]]);
    expect(res).toMatchObject({ success: true, url: 'http://localhost:3000' });
  });

  it('a page still loading after 15 s is reported with loading: true, not as a failure', async () => {
    vi.useFakeTimers();
    try {
      const pending = handleNavigate({ url: 'https://slow.example.com/', tabId: 1, snapshot: false }, 'session-a');
      await vi.advanceTimersByTimeAsync(16_000);
      const res = await pending;
      expect(res).toMatchObject({ success: true, tabId: 1, loading: true });
      expect(res.text).toMatch(/^loading: true \(still loading after 15 s/m);
    } finally {
      vi.useRealTimers();
    }
  });

  it('snapshot:true appends the snapshot capped at 2000 characters; by default there is none', async () => {
    reactTo = answerWith(200);
    snapshot.reply = { success: true, text: 'document\n  link "Home" [e1]' };
    const res = await handleNavigate({ url: 'https://example.com/', tabId: 1, snapshot: true }, 'session-a');
    expect(snapshot.calls).toEqual([{ tabId: 1, maxChars: 2000 }]);
    expect(res.text.endsWith('\n\ndocument\n  link "Home" [e1]')).toBe(true);

    await handleNavigate({ url: 'https://example.com/', tabId: 1 }, 'session-a');
    expect(snapshot.calls).toHaveLength(1);
  });
});

describe('browser_tabs', () => {
  it('lists own tabs first, then the focused user tab, then counts other agents\' tabs and the rest', async () => {
    tabLocks.lock(3, 'session-a');
    tabLocks.lock(7, 'session-a');
    tabLocks.lock(4, 'session-b');
    const res = await handleTabs({ action: 'list' }, 'session-a');
    const lines = String(res.text).split('\n');
    expect(lines[0]).toBe('3 [own] "Draft" app.example.com/new');
    expect(lines[2]).toBe('1 [user, focused] "Inbox" mail.example.com/inbox');
    expect(lines[3]).toBe('+1 tab used by other agents'); // their title and address stay private (L4)
    expect(lines[4]).toBe('+2 other tabs');
    expect(lines).toHaveLength(5);
    expect(String(res.text)).not.toContain('Other agent tab');
  });

  it('clips titles to 60 characters and host + path to 80', async () => {
    tabLocks.lock(7, 'session-a');
    const res = await handleTabs({ action: 'list' }, 'session-a');
    const line = String(res.text).split('\n').find((l) => l.startsWith('7 [own]'))!;
    const title = line.slice('7 [own] "'.length, line.indexOf('" ', 9));
    const address = line.slice(line.indexOf('" ') + 2);
    expect(title).toHaveLength(60);
    expect(title.endsWith('…')).toBe(true);
    expect(address).toHaveLength(80);
    expect(address.startsWith('long.example.com/')).toBe(true);
  });

  it('from the other session\'s side: its own tab first, mine only counted, never titled', async () => {
    tabLocks.lock(3, 'session-a');
    tabLocks.lock(4, 'session-b');
    const res = await handleTabs({ action: 'list' }, 'session-b');
    expect(String(res.text).split('\n')[0]).toBe('4 [own] "Other agent tab" other.example.com/p');
    expect(String(res.text)).toContain('+1 tab used by other agents');
    expect(String(res.text)).not.toContain('Draft');
  });

  it('close removes an own tab and hands it back at once', async () => {
    tabLocks.lock(3, 'session-a');
    const res = await handleTabs({ action: 'close', tabId: 3 }, 'session-a');
    expect(res).toMatchObject({ success: true, text: 'closed tab 3', closed: 3 });
    expect(removed).toEqual([3]);
    expect(tabLocks.owner(3)).toBeUndefined();
  });

  it('close of another session\'s tab is refused with TAB_LOCKED', async () => {
    tabLocks.lock(4, 'session-b');
    await expect(handleTabs({ action: 'close', tabId: 4 }, 'session-a')).rejects.toThrow(/^TAB_LOCKED: tab 4 is locked by session-b since /);
    expect(removed).toEqual([]);
  });

  it('focus activates a user tab and raises its window', async () => {
    const res = await handleTabs({ action: 'focus', tabId: 5 }, 'session-a');
    expect(res).toMatchObject({ success: true, text: 'focused tab 5', focused: 5 });
    expect(tabUpdates).toEqual([[5, { active: true }]]);
    expect(windowUpdates).toEqual([[2, { focused: true }]]);
  });

  it('close and focus need a tabId', async () => {
    await expect(handleTabs({ action: 'focus' }, 'session-a')).rejects.toThrow(/^INVALID_ARGUMENT: tabId is required for focus/);
  });

  it('create, reload, lock and unlock are no longer actions', async () => {
    for (const action of ['create', 'reload', 'lock', 'unlock']) {
      await expect(handleTabs({ action, tabId: 1 }, 'session-a')).rejects.toThrow(/^INVALID_ARGUMENT: unknown action/);
    }
  });
});

describe('browser_emulate viewport', () => {
  const phone = { width: 390, height: 844, deviceScaleFactor: 3, mobile: true };

  it('the plan sends Emulation.setDeviceMetricsOverride and records the viewport; null clears it', () => {
    expect(emulationPlan({ viewport: phone }, {})).toEqual({
      commands: [['Emulation.setDeviceMetricsOverride', phone]],
      state: { viewport: phone },
    });
    expect(emulationPlan({ viewport: null }, { viewport: phone })).toEqual({
      commands: [['Emulation.clearDeviceMetricsOverride', {}]],
      state: {},
    });
  });

  it('refuses a viewport that is not whole CSS pixels or has no scale', () => {
    expect(() => emulationPlan({ viewport: { width: 0, height: 844 } }, {})).toThrow(/^INVALID_ARGUMENT: viewport needs/);
    expect(() => emulationPlan({ viewport: { width: 390.5, height: 844 } }, {})).toThrow(/^INVALID_ARGUMENT: viewport needs/);
    expect(() => emulationPlan({ viewport: { width: 390, height: 844, deviceScaleFactor: 0 } }, {})).toThrow(/^INVALID_ARGUMENT: viewport deviceScaleFactor/);
  });

  it('sets the viewport in the page without resizing the user window, and reports it in text', async () => {
    const res = await handleEmulate({ tabId: 4, viewport: phone });
    expect(res).toMatchObject({ success: true, text: 'viewport 390x844@3 mobile' });
    expect(debuggerCalls.some(([m]) => m === 'Emulation.setDeviceMetricsOverride')).toBe(true);
    expect(windowUpdates).toEqual([]);
  });

  it('one text line per active override, and the viewport goes first', async () => {
    await handleEmulate({ tabId: 4, viewport: phone });
    const res = await handleEmulate({ tabId: 4, network: 'slow-3g' });
    expect(res.text).toBe('viewport 390x844@3 mobile\nnetwork slow-3g');
  });

  it('viewport:null clears only the viewport', async () => {
    await handleEmulate({ tabId: 4, viewport: phone, network: 'slow-3g' });
    const res = await handleEmulate({ tabId: 4, viewport: null });
    expect(res.text).toBe('network slow-3g');
    expect(debuggerCalls.some(([m]) => m === 'Emulation.clearDeviceMetricsOverride')).toBe(true);
  });

  it('reset clears the viewport with the rest (the session detaches when nothing else keeps it)', async () => {
    await handleEmulate({ tabId: 4, viewport: phone });
    const res = await handleEmulate({ tabId: 4, reset: true });
    expect(res).toMatchObject({ success: true, active: {}, text: 'cleared:\nviewport 390x844@3 mobile' });
    expect(hasCdp(4)).toBe(false);
  });

  it('reset of a viewport on a session a body capture keeps clears it with the device-metrics command', async () => {
    await handleEmulate({ tabId: 4, viewport: phone });
    pinCdp(4, 'network-bodies');
    debuggerCalls.length = 0;
    try {
      const res = await handleEmulate({ tabId: 4, reset: true });
      expect(res).toMatchObject({ success: true, active: {}, text: 'cleared:\nviewport 390x844@3 mobile' });
      expect(debuggerCalls.map(([m]) => m)).toContain('Emulation.clearDeviceMetricsOverride');
      expect(hasCdp(4)).toBe(true);
    } finally {
      unpinCdp(4, 'network-bodies');
    }
  });
});

describe('extension router: browser_tabs has no lock action', () => {
  it('lock is refused as an unknown action, and a user tab stays unowned', async () => {
    await handleMessage({ id: 'u1', tool: 'browser_tabs', params: { action: 'lock', tabId: 1 }, sessionId: 'session-a' });
    await flush();
    expect(resultOf('u1')).toMatchObject({ success: false });
    expect(String(resultOf('u1')?.error)).toMatch(/^INVALID_ARGUMENT: unknown action "lock"/);
    expect(tabLocks.owner(1)).toBeUndefined();
  });
});
