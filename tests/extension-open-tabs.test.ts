import { describe, it, expect, beforeEach } from 'vitest';

/**
 * Popup "Open Tabs" payload: a tab an agent is driving must come back with
 * `controlledBy` (who, and whether a call is running) even though no lock was
 * taken — before this the row rendered as "— free —" while the agent acted on it.
 */

type Tab = { id: number; windowId: number; url: string; title: string; active: boolean };
const windowOne: Tab[] = [
  { id: 3, windowId: 1, url: 'https://example.com/a', title: 'A', active: true },
  { id: 4, windowId: 1, url: 'https://example.com/b', title: 'B', active: false },
  { id: 5, windowId: 1, url: 'https://example.com/c', title: 'C', active: false },
];
const windowTwo: Tab[] = [
  { id: 20, windowId: 2, url: 'https://example.com/x', title: 'X', active: true },
  { id: 21, windowId: 2, url: 'https://example.com/y', title: 'Y', active: false },
  { id: 22, windowId: 2, url: 'https://example.com/z', title: 'Z', active: false },
];

(globalThis as any).chrome = {
  storage: {
    local: { get: async () => ({}), set: async () => {} },
    session: { get: async () => ({}), set: async () => {} },
  },
  alarms: { create: () => {}, onAlarm: { addListener: () => {} } },
  tabs: {
    // The popup was opened from window 1; window 2 is another window.
    query: async (q: { currentWindow?: boolean }) => (q.currentWindow ? windowOne : [...windowTwo, ...windowOne]),
  },
  action: { setBadgeText: () => {}, setBadgeBackgroundColor: () => {} },
  runtime: { sendMessage: async () => {} },
};

const { getOpenTabs } = await import('../extension/lib/connection.js');
const { tabLocks, tabControl } = await import('../extension/lib/state.js');

describe('getOpenTabs (popup Open Tabs payload)', () => {
  beforeEach(() => {
    tabLocks.unlockAll();
    for (const t of [...windowOne, ...windowTwo]) tabControl.release(t.id);
  });

  it('reports the controlling agent for an unlocked tab, null for free tabs', async () => {
    tabControl.begin(3, 's1', 'Claude');
    tabLocks.lock(5, 's2');
    const tabs = await getOpenTabs();
    const byId = Object.fromEntries(tabs.map((t: any) => [t.id, t]));

    expect(byId[3]).toMatchObject({ lockedBy: null, controlledBy: { sessionId: 's1', agentName: 'Claude', active: true } });
    expect(byId[4]).toMatchObject({ lockedBy: null, controlledBy: null }); // genuinely free
    expect(byId[5]).toMatchObject({ lockedBy: 's2', controlledBy: null }); // pinned, idle
  });

  it('flips active → false once the call ends (linger window)', async () => {
    tabControl.end(tabControl.begin(3, 's1', 'Claude'));
    const [tab] = await getOpenTabs();
    expect(tab.controlledBy).toEqual({ sessionId: 's1', agentName: 'Claude', active: false });
  });

  it('lists only the current window, plus locked/controlled tabs from other windows (after it)', async () => {
    tabControl.begin(20, 's1', 'Claude'); // the agent works in window 2
    tabLocks.lock(21, 's2');
    const tabs = await getOpenTabs();

    expect(tabs.map((t: any) => t.id)).toEqual([3, 4, 5, 20, 21]); // 22: idle, other window → hidden
    expect(tabs.find((t: any) => t.id === 20)).toMatchObject({ otherWindow: true, controlledBy: { sessionId: 's1' } });
    expect(tabs.find((t: any) => t.id === 21)).toMatchObject({ otherWindow: true, lockedBy: 's2' });
    expect(tabs.find((t: any) => t.id === 3)).not.toHaveProperty('otherWindow');
  });
});
