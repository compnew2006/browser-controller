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

vi.mock('../extension/lib/connection.js', () => ({
  sendJson: (obj: Record<string, unknown>) => { sent.push(obj); },
  updateBadge: () => {},
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
const { tabLocks } = await import('../extension/lib/state.js');

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

  it('shows the lock-shield frame WITH the tool label during an agent action (no corner badge)', async () => {
    await handleMessage({ id: 'a1', tool: 'browser_console', params: { tabId: 3 }, sessionId: 's1' });
    await flush();

    const shields = shieldInjections();
    expect(shields.length, 'a shield injection must happen for the action').toBeGreaterThanOrEqual(1);
    expect(shields[0]!.args).toContain('console'); // tool name lives INSIDE the frame
    expect(overlayInjections(), 'the old corner badge must not be used anymore').toEqual([]);
    expect(sent.find((f) => f.id === 'a1')?.success).toBe(true);
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
    await handleMessage({ id: 'a3', tool: 'browser_console', params: { tabId: 3 }, sessionId: 's1' });
    await flush();

    const shields = shieldInjections();
    expect(shields.length).toBeGreaterThanOrEqual(2); // show-with-label, then re-show plain
    const last = shields.at(-1)!;
    expect(last.args).not.toContain('console'); // label gone, frame persists
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
