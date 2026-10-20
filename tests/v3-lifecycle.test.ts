import { vi, describe, it, expect, beforeEach } from 'vitest';

/**
 * Tab-scoped settings outlive their call (FIX-LIFECYCLE L1, X15) and a queued call the caller
 * already cancelled must not run (X1). The router runs the real handlers except the two
 * replaced below, so these tests drive the whole path: router → handler → state.
 */

const sent = vi.hoisted(() => [] as Array<Record<string, any>>);
vi.mock('../extension/lib/connection.js', () => ({
  sendJson: (obj: Record<string, any>) => { sent.push(obj); },
  updateBadge: () => {},
  broadcastStatus: () => {},
  isWsConnected: () => true,
  setCurrentActivity: () => {},
}));

const waitGate = vi.hoisted(() => ({ release: null as null | (() => void), calls: 0 }));
const clickRuns = vi.hoisted(() => ({ count: 0 }));
vi.mock('../extension/handlers/inspection.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../extension/handlers/inspection.js')>()),
  // Holds the tab's mutex until the test releases it.
  handleWait: () => new Promise((resolve) => {
    waitGate.calls++;
    waitGate.release = () => resolve({ success: true, text: 'waited' });
  }),
}));
vi.mock('../extension/handlers/interaction.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../extension/handlers/interaction.js')>()),
  handleClick: async () => { clickRuns.count++; return { success: true, text: 'clicked' }; },
}));

const sentCdp: Array<[number, string, any]> = [];
let emit: (source: { tabId: number }, method: string, params: unknown) => void = () => {};
const tabStore = new Map<number, { id: number; windowId: number; url: string; title: string; active: boolean }>();
(globalThis as any).chrome = {
  tabs: {
    get: async (id: number) => tabStore.get(id) ?? Promise.reject(new Error(`No tab ${id}`)),
    query: async () => [],
    update: async () => ({}),
    remove: async () => ({}),
    create: async () => ({}),
    onRemoved: { addListener: () => {} },
    onUpdated: { addListener: () => {} },
  },
  windows: { get: async () => ({ width: 1280, height: 900 }) },
  scripting: { executeScript: async () => [{ result: null }] },
  action: { setBadgeBackgroundColor: () => {}, setBadgeText: () => {} },
  storage: {
    session: { get: async () => ({}), set: async () => {} },
    local: { get: async () => ({}), set: async () => {} },
  },
  runtime: { sendMessage: async () => {}, onMessage: { addListener: () => {} } },
  alarms: { create: () => {}, onAlarm: { addListener: () => {} } },
  webRequest: { onCompleted: { addListener: () => {} } },
  debugger: {
    attach: async () => {},
    detach: async () => {},
    sendCommand: async ({ tabId }: { tabId: number }, method: string, params: any) => {
      sentCdp.push([tabId, method, params]);
      return { result: { value: 1 } };
    },
    onEvent: { addListener: (fn: typeof emit) => { emit = fn; } },
    onDetach: { addListener: () => {} },
  },
};

const { handleMessage } = await import('../extension/lib/router.js');
const { tabLocks, tabControl, bodyCaptureByTab, mockByTab, claimTabSetting, tabSettingOwner } =
  await import('../extension/lib/state.js');
const { handleMock } = await import('../extension/handlers/mock.js');
const { isCdpPinned } = await import('../extension/lib/cdp-session.js');

const APP = 'https://app.test/';
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const frameFor = (id: number) => sent.find((f) => f.id === id);
const cdpCalls = (tabId: number, method: string) => sentCdp.filter(([t, m]) => t === tabId && m === method);
/** A tool call runs behind the tab's mutex: wait for its response frame before asserting. */
async function call(msg: Record<string, any>) {
  void handleMessage(msg);
  await vi.waitFor(() => expect(frameFor(msg.id)).toBeDefined());
}

function openTab(id: number) {
  tabStore.set(id, { id, windowId: 1, url: APP, title: 'App', active: true });
}

beforeEach(() => {
  sent.length = 0;
  sentCdp.length = 0;
  waitGate.release = null;
  waitGate.calls = 0;
  clickRuns.count = 0;
  tabLocks.unlockAll();
  tabControl.clear();
  for (const tabId of [...mockByTab.keys()]) mockByTab.delete(tabId);
  for (const tabId of [...bodyCaptureByTab.keys()]) bodyCaptureByTab.delete(tabId);
  openTab(5);
  openTab(6);
});

describe('X1: a queued call the caller cancelled never runs', () => {
  it('a click queued behind a wait is answered TIMEOUT and its handler is not called after the cancel', async () => {
    void handleMessage({ id: 1, tool: 'browser_wait', tabId: 5, params: { tabId: 5, ms: 1 } });
    await vi.waitFor(() => expect(waitGate.calls).toBe(1));

    void handleMessage({ id: 2, tool: 'browser_click', tabId: 5, params: { tabId: 5, target: 'e1' } });
    await flush();
    await handleMessage({ type: 'cancel', id: 2 });

    waitGate.release?.();
    await vi.waitFor(() => expect(frameFor(1)).toBeDefined());
    await flush();

    expect(clickRuns.count).toBe(0);
    expect(frameFor(2)).toMatchObject({ success: false });
    expect(String(frameFor(2).error)).toMatch(/^TIMEOUT: /);
  });

  it('an uncancelled queued click still runs', async () => {
    void handleMessage({ id: 1, tool: 'browser_wait', tabId: 5, params: { tabId: 5, ms: 1 } });
    await vi.waitFor(() => expect(waitGate.calls).toBe(1));
    void handleMessage({ id: 2, tool: 'browser_click', tabId: 5, params: { tabId: 5, target: 'e1' } });
    await flush();
    waitGate.release?.();
    await vi.waitFor(() => expect(frameFor(2)).toBeDefined());
    expect(clickRuns.count).toBe(1);
    expect(frameFor(2)).toMatchObject({ success: true });
  });
});

describe('L1: tab settings are owned by the session that set them', () => {
  it('releaseSession clears the browser_mock rules that session set, and detaches Fetch', async () => {
    await call({
      id: 10, tool: 'browser_mock', tabId: 5, sessionId: 'a',
      params: { tabId: 5, rules: [{ match: '*api*', body: '{"ok":1}' }] },
    });
    expect(frameFor(10)).toMatchObject({ success: true });
    expect(tabSettingOwner(5, 'mock')).toBe('a');
    expect(isCdpPinned(5, 'browser-mock')).toBe(true);

    await handleMessage({ type: 'releaseSession', sessionId: 'a' });

    expect(tabSettingOwner(5, 'mock')).toBeUndefined();
    expect(mockByTab.has(5)).toBe(false);
    expect(cdpCalls(5, 'Fetch.disable').length).toBeGreaterThan(0);
    expect(isCdpPinned(5, 'browser-mock')).toBe(false);
    expect(await handleMock({ tabId: 5 })).toMatchObject({ text: 'no rules on tab 5' });
  });

  it('releaseSession of another session leaves the rules alone', async () => {
    await call({
      id: 11, tool: 'browser_mock', tabId: 5, sessionId: 'a',
      params: { tabId: 5, rules: [{ match: '*api*', body: 'x' }] },
    });
    await handleMessage({ type: 'releaseSession', sessionId: 'b' });
    expect(tabSettingOwner(5, 'mock')).toBe('a');
    expect(mockByTab.has(5)).toBe(true);
  });

  it('a later set by another session takes the rules over: releasing the first one keeps them', async () => {
    await call({ id: 12, tool: 'browser_mock', tabId: 5, sessionId: 'a', params: { tabId: 5, rules: [{ match: '*a*', body: 'x' }] } });
    await call({ id: 13, tool: 'browser_mock', tabId: 5, sessionId: 'b', params: { tabId: 5, rules: [{ match: '*b*', body: 'y' }] } });
    expect(tabSettingOwner(5, 'mock')).toBe('b');
    await handleMessage({ type: 'releaseSession', sessionId: 'a' });
    expect(mockByTab.has(5)).toBe(true);
  });

  it('browser_mock rules: [] clears the claim, so a later release has nothing to do', async () => {
    await call({ id: 14, tool: 'browser_mock', tabId: 5, sessionId: 'a', params: { tabId: 5, rules: [{ match: '*a*', body: 'x' }] } });
    await call({ id: 15, tool: 'browser_mock', tabId: 5, sessionId: 'a', params: { tabId: 5, rules: [] } });
    expect(tabSettingOwner(5, 'mock')).toBeUndefined();
  });

  it('a successful browser_emulate call claims the tab for its session', async () => {
    await call({ id: 16, tool: 'browser_emulate', tabId: 5, sessionId: 'a', params: { tabId: 5, colorScheme: 'dark' } });
    expect(frameFor(16)).toMatchObject({ success: true });
    expect(tabSettingOwner(5, 'emulation')).toBe('a');
    const setCalls = sentCdp.filter(([t, m]) => t === 5 && m.startsWith('Emulation.')).length;

    await handleMessage({ type: 'releaseSession', sessionId: 'a' });
    expect(tabSettingOwner(5, 'emulation')).toBeUndefined();
    await vi.waitFor(() => expect(sentCdp.filter(([t, m]) => t === 5 && m.startsWith('Emulation.')).length).toBeGreaterThan(setCalls));
  });

  it('browser_logs bodies:true claims the tab for its session; bodies:false gives the claim back', async () => {
    await call({ id: 17, tool: 'browser_logs', tabId: 5, sessionId: 'a', params: { tabId: 5, kind: 'network', bodies: true } });
    expect(frameFor(17)).toMatchObject({ success: true });
    expect(tabSettingOwner(5, 'bodies')).toBe('a');
    expect(bodyCaptureByTab.has(5)).toBe(true);

    await call({ id: 18, tool: 'browser_logs', tabId: 5, sessionId: 'a', params: { tabId: 5, kind: 'network', bodies: false } });
    expect(tabSettingOwner(5, 'bodies')).toBeUndefined();
  });

  it('releaseSession stops the body capture its session started and forgets its bodies', async () => {
    const unsubscribe = vi.fn();
    bodyCaptureByTab.set(5, { bodies: { size: 3 } as any, unsubscribe });
    claimTabSetting(5, 'bodies', 'a');
    await handleMessage({ type: 'releaseSession', sessionId: 'a' });
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(bodyCaptureByTab.has(5)).toBe(false);
    expect(tabSettingOwner(5, 'bodies')).toBeUndefined();
  });

  it('releaseSession keeps the body capture of another session', async () => {
    const unsubscribe = vi.fn();
    bodyCaptureByTab.set(5, { bodies: { size: 0 } as any, unsubscribe });
    claimTabSetting(5, 'bodies', 'b');
    await handleMessage({ type: 'releaseSession', sessionId: 'a' });
    expect(unsubscribe).not.toHaveBeenCalled();
    expect(bodyCaptureByTab.has(5)).toBe(true);
  });
});

describe('X15: a closed tab forgets its mock rules and their listener', () => {
  it('after the tab closes its rules are gone and a paused request is no longer answered', async () => {
    await call({ id: 20, tool: 'browser_mock', tabId: 5, sessionId: 'a', params: { tabId: 5, rules: [{ match: '*api*', body: 'x' }] } });
    expect(mockByTab.has(5)).toBe(true);

    const { dropTabState } = await import('../extension/lib/state.js');
    dropTabState(5);
    expect(mockByTab.has(5)).toBe(false);
    expect(tabSettingOwner(5, 'mock')).toBeUndefined();

    sentCdp.length = 0;
    emit({ tabId: 5 }, 'Fetch.requestPaused', { requestId: 'r1', request: { url: `${APP}api`, method: 'GET', headers: {} } });
    await flush();
    expect(sentCdp.some(([t, m]) => t === 5 && m === 'Fetch.fulfillRequest')).toBe(false);
  });
});
