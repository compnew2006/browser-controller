import { beforeEach, describe, expect, it } from 'vitest';

// A tab store: chrome.tabs.get rejects for a closed or never-opened tab, as Chrome does.
type FakeTab = { id: number; url: string; windowId: number; index: number; active: boolean };
let tabs = new Map<number, FakeTab>();
let nextId = 100;
(globalThis as any).chrome = {
  tabs: {
    get: async (id: number) => {
      const tab = tabs.get(id);
      if (!tab) throw new Error(`No tab with id: ${id}.`);
      return tab;
    },
    query: async () => [],
    create: async (o: Partial<FakeTab>) => {
      const tab: FakeTab = { id: nextId++, url: o.url ?? 'about:blank', windowId: o.windowId ?? 1, index: o.index ?? 0, active: !!o.active };
      tabs.set(tab.id, tab);
      return tab;
    },
    remove: async (id: number) => { tabs.delete(id); },
    onRemoved: { addListener: () => {} },
    onReplaced: { addListener: () => {} },
  },
  storage: { session: { get: async () => ({}), set: async () => {} }, local: { get: async () => ({}), set: async () => {} } },
};

const { resolveTab, replaceFrozenTab } = await import('../extension/lib/page-exec.js');
const { wedgedTabs, tabLocks, tabControl, followReplacedTab } = await import('../extension/lib/state.js');

const open = (id: number) => { tabs.set(id, { id, url: 'https://example.test/', windowId: 1, index: 0, active: true }); };

async function failureOf(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (err) {
    return { code: (err as { code?: string }).code, message: (err as Error).message };
  }
  throw new Error('expected the call to fail');
}

describe('a tab id that no longer names a tab fails with a code that says why', () => {
  beforeEach(() => {
    tabs = new Map();
    wedgedTabs.clear();
    tabLocks.locks.clear();
    tabControl.clear();
  });

  it('a tab that was never opened, or was closed, fails TAB_NOT_FOUND', async () => {
    const failure = await failureOf(resolveTab(777));
    expect(failure.code).toBe('TAB_NOT_FOUND');
    expect(failure.message).toMatch(/^TAB_NOT_FOUND: tab 777 .*browser_tabs list/);
  });

  it('a frozen tab that browser_navigate replaced fails TAB_REPLACED and names the new tab', async () => {
    open(3);
    wedgedTabs.set(3, Date.now());
    const fresh = await replaceFrozenTab({ id: 3, windowId: 1, index: 0, active: true }, 'https://example.test/next');
    expect(fresh).not.toBeNull();
    const failure = await failureOf(resolveTab(3));
    expect(failure.code).toBe('TAB_REPLACED');
    expect(failure.message).toMatch(new RegExp(`^TAB_REPLACED: tab 3 was replaced by tab ${fresh!.id}\\. Use tabId ${fresh!.id}`));
  });

  it('a tab Chrome replaced keeps its lock and control on the new tab, and fails TAB_REPLACED', async () => {
    open(5);
    tabLocks.lock(5, 'session-a', { agentName: 'agent-a', since: 1000 });
    tabControl.begin(5, 'session-a', 'agent-a');
    tabs.delete(5);
    open(6);
    followReplacedTab(5, 6);
    expect(tabLocks.owner(5)).toBeUndefined();
    expect(tabLocks.grantOf(6)).toEqual({ sessionId: 'session-a', agentName: 'agent-a', since: 1000 });
    expect(tabControl.controller(6)).toBeDefined();
    expect(tabControl.controller(5)).toBeUndefined();
    const failure = await failureOf(resolveTab(5));
    expect(failure.code).toBe('TAB_REPLACED');
    expect(failure.message).toContain('Use tabId 6');
  });

  it('a tab replaced twice names the tab it has now, not the one in between', async () => {
    open(7);
    tabs.delete(7);
    followReplacedTab(7, 8);
    open(8);
    tabs.delete(8);
    followReplacedTab(8, 9);
    open(9);
    const failure = await failureOf(resolveTab(7));
    expect(failure.code).toBe('TAB_REPLACED');
    expect(failure.message).toContain('Use tabId 9');
  });

  it('a frozen tab replaced by browser_navigate keeps its wedge mark off the new tab', async () => {
    open(10);
    wedgedTabs.set(10, Date.now());
    const fresh = await replaceFrozenTab({ id: 10, windowId: 1, index: 0, active: true }, null);
    expect(wedgedTabs.has(10)).toBe(false);
    expect(wedgedTabs.has(fresh!.id)).toBe(false);
  });

  it('a tab that still exists resolves as before', async () => {
    open(11);
    const tab = await resolveTab(11);
    expect(tab.id).toBe(11);
  });
});
