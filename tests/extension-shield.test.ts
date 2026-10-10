import { vi, describe, it, expect, beforeEach } from 'vitest';

/**
 * Agent-control shield (user request): while an agent is ACTIVELY controlling
 * a tab, the page shows the blue inner frame + input blocking (the lock
 * shield) with the running tool's name INSIDE the frame — replacing the old
 * small corner badge. The frame goes away when the action finishes, unless
 * the tab is locked (lock lifetime keeps a plain frame).
 */

const sent = vi.hoisted(() => [] as Array<Record<string, unknown>>);
const injections = vi.hoisted(() => [] as Array<{ target: number; func: string; args: unknown[] }>);
const faults = vi.hoisted(() => ({ activeBadgeThrows: false }));

vi.mock('../extension/lib/connection.js', () => ({
  sendJson: (obj: Record<string, unknown>) => { sent.push(obj); },
  updateBadge: (status: string) => {
    if (status === 'active' && faults.activeBadgeThrows) throw new Error('badge API gone');
  },
  broadcastStatus: async () => {},
  isWsConnected: () => true,
  setCurrentActivity: () => {},
}));

const tabStore = new Map<number, { id: number; windowId: number; url: string; title: string; active: boolean }>();
(globalThis as unknown as { chrome: unknown }).chrome = {
  tabs: {
    get: async (id: number) => {
      const t = tabStore.get(id);
      if (!t) throw new Error(`No tab ${id}`);
      return t;
    },
    query: async () => [{ id: 3, windowId: 1 }],
    update: async () => ({}),
    remove: async () => ({}),
    create: async () => ({}),
    captureVisibleTab: async () => 'data:image/png;base64,QUJD',
  },
  scripting: {
    executeScript: async (opts: { target: { tabId: number }; func: () => void; args?: unknown[] }) => {
      injections.push({ target: opts.target.tabId, func: opts.func.toString(), args: opts.args ?? [] });
      return [{ result: null }];
    },
  },
  action: { setBadgeBackgroundColor: () => {}, setBadgeText: () => {} },
  storage: {
    session: { get: async () => ({}), set: async () => {} },
    local: { get: async () => ({}), set: async () => {} },
  },
  runtime: { sendMessage: async () => {}, onMessage: { addListener: () => {} } },
  alarms: { create: () => {}, onAlarm: { addListener: () => {} } },
  webRequest: { onCompleted: { addListener: () => {} } },
  debugger: { attach: async () => {}, detach: async () => {}, sendCommand: async () => ({}) },
};

const { handleMessage } = await import('../extension/lib/router.js');
const { handleScreenshot } = await import('../extension/handlers/tabs.js');
const { tabLocks, tabControl } = await import('../extension/lib/state.js');

const shieldInjections = () => injections.filter((i) => i.func.includes('__bc-lock-shield'));
const overlayInjections = () => injections.filter((i) => i.func.includes('__bc-overlay'));
const flush = (ms = 60) => new Promise((r) => setTimeout(r, ms));

describe('agent-control shield (blue frame instead of corner badge)', () => {
  beforeEach(() => {
    sent.length = 0;
    injections.length = 0;
    tabStore.clear();
    tabLocks.unlockAll();
    tabStore.set(3, { id: 3, windowId: 1, url: 'https://example.com/page', title: 'Page', active: true });
  });

  it('shows the lock-shield frame WITH the agent-name label during an agent action (no corner badge)', async () => {
    await handleMessage({ id: 'a1', tool: 'browser_console', params: { tabId: 3 }, sessionId: 's1', agentName: 'Vitest' });
    await flush();

    const shields = shieldInjections();
    expect(shields.length, 'a shield injection must happen for the action').toBeGreaterThanOrEqual(1);
    // The label names the AGENT controlling the tab (user request), not the tool.
    expect(shields[0]!.args).toContain('agent Vitest controlling the tab');
    expect(overlayInjections(), 'the old corner badge must not be used anymore').toEqual([]);
    expect(sent.find((f) => f.id === 'a1')?.success).toBe(true);
  });

  it('falls back to a generic label when the message carries no agentName', async () => {
    await handleMessage({ id: 'a4', tool: 'browser_console', params: { tabId: 3 }, sessionId: 's1' });
    await flush();
    expect(shieldInjections()[0]!.args).toContain('agent controlling the tab');
  });

  it('removes the frame when the action ends on an UNLOCKED tab', async () => {
    await handleMessage({ id: 'a2', tool: 'browser_console', params: { tabId: 3 }, sessionId: 's1' });
    await flush();

    // Last shield-related injection must be the REMOVAL (hideLockShield's
    // func removes the element), not a re-show.
    const last = shieldInjections().at(-1)!;
    expect(last.func).toMatch(/remove|__bcShieldDocListeners/);
  });

  it('keeps a plain frame (no label) after the action when the tab is LOCKED', async () => {
    tabLocks.lock(3, 's1');
    await handleMessage({ id: 'a3', tool: 'browser_console', params: { tabId: 3 }, sessionId: 's1', agentName: 'Vitest' });
    await flush();

    const shields = shieldInjections();
    expect(shields.length).toBeGreaterThanOrEqual(2); // show-with-label, then re-show plain
    const last = shields.at(-1)!;
    expect(last.args).not.toContain('agent Vitest controlling the tab'); // label gone, frame persists
    expect(last.func.includes('__bc-lock-shield')).toBe(true);
  });

  it('screenshot on a LOCKED tab does not crash (regression: showLockShield import)', async () => {
    tabLocks.lock(3, 's1');
    // Previously rejected with ReferenceError: showLockShield is not defined
    // (the dedup edit dropped its import from handlers/tabs.js).
    await expect(handleScreenshot({ tabId: 3 }, 's1')).resolves.toMatchObject({ success: true });
    // and it must restore the shield afterwards
    expect(shieldInjections().length).toBeGreaterThanOrEqual(1);
  });
});

describe('tab control tracking (popup Open Tabs must not say "free")', () => {
  beforeEach(() => {
    sent.length = 0;
    tabStore.clear();
    tabLocks.unlockAll();
    tabControl.release(3);
    tabStore.set(3, { id: 3, windowId: 1, url: 'https://example.com/page', title: 'Page', active: true });
  });

  it('records the agent driving an UNLOCKED tab (queued path)', async () => {
    await handleMessage({ id: 'c1', tool: 'browser_console', params: { tabId: 3 }, sessionId: 's1', agentName: 'Vitest' });
    await flush();
    expect(tabLocks.owner(3)).toBeUndefined(); // still no lock…
    // …but the tab is reported as controlled (lingering after the call).
    expect(tabControl.controller(3)).toEqual({ sessionId: 's1', agentName: 'Vitest', active: false });
  });

  it('records calls that bypass the tab mutex too (tabs focus)', async () => {
    await handleMessage({ id: 'c2', tool: 'browser_tabs', params: { action: 'focus', tabId: 3 }, sessionId: 's1', agentName: 'Vitest' });
    expect(tabControl.controller(3)).toMatchObject({ sessionId: 's1', active: false });
  });

  it('does not record tab-agnostic calls (tabs list)', async () => {
    await handleMessage({ id: 'c3', tool: 'browser_tabs', params: { action: 'list' }, sessionId: 's1' });
    expect(tabControl.controller(3)).toBeUndefined();
  });

  it('clears control when the agent session is released (disconnect)', async () => {
    await handleMessage({ id: 'c4', tool: 'browser_console', params: { tabId: 3 }, sessionId: 's1', agentName: 'Vitest' });
    await flush();
    await handleMessage({ type: 'releaseSession', sessionId: 's1' });
    expect(tabControl.controller(3)).toBeUndefined();
  });

  it('does not record a caller the lock refuses on the mutex-bypass path', async () => {
    tabLocks.lock(3, 'owner-a');
    await handleMessage({ id: 'c5', tool: 'browser_tabs', params: { action: 'focus', tabId: 3 }, sessionId: 's-b', agentName: 'Other' });
    expect(sent.find((f) => f.id === 'c5')?.success).toBe(false); // refused: locked by owner-a
    tabLocks.unlockAll();
    // After the owner lets go, the tab must not claim s-b "controlled" it.
    expect(tabControl.controller(3)).toBeUndefined();
  });

  it('an agent unlocking its tab hands it back: free at once, no 30s linger', async () => {
    await handleMessage({ id: 'c6', tool: 'browser_tabs', params: { action: 'lock', tabId: 3 }, sessionId: 's1', agentName: 'Vitest' });
    await flush();
    await handleMessage({ id: 'c7', tool: 'browser_tabs', params: { action: 'unlock', tabId: 3 }, sessionId: 's1', agentName: 'Vitest' });
    await flush();
    expect(sent.find((f) => f.id === 'c7')?.success).toBe(true);
    expect(tabControl.controller(3)).toBeUndefined();
  });

  it('ends control even when the task throws before the dispatch try (no stuck "running")', async () => {
    faults.activeBadgeThrows = true;
    try {
      await handleMessage({ id: 'c8', tool: 'browser_console', params: { tabId: 3 }, sessionId: 's1', agentName: 'Vitest' });
      await flush();
    } finally {
      faults.activeBadgeThrows = false;
    }
    expect(sent.find((f) => f.id === 'c8')?.success).toBe(false);
    expect(tabControl.controller(3)?.active).toBe(false);
  });

  it('browser_tabs list shows controlledBy to OTHER agents only', async () => {
    await handleMessage({ id: 'c9', tool: 'browser_console', params: { tabId: 3 }, sessionId: 's1', agentName: 'Vitest' });
    await flush();
    await handleMessage({ id: 'c10', tool: 'browser_tabs', params: { action: 'list' }, sessionId: 's2' });
    await handleMessage({ id: 'c11', tool: 'browser_tabs', params: { action: 'list' }, sessionId: 's1' });
    const tabsFor = (id: string) => (sent.find((f) => f.id === id)?.result as { tabs: Array<Record<string, unknown>> }).tabs;
    expect(tabsFor('c10')[0]).toMatchObject({ id: 3, controlledBy: 's1' });
    expect(tabsFor('c11')[0]).not.toHaveProperty('controlledBy'); // your own activity is not news
  });
});
