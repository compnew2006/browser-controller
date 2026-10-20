import { beforeEach, describe, expect, it } from 'vitest';

const windowUpdates: Array<[number, Record<string, unknown>]> = [];
(globalThis as any).chrome = {
  tabs: {
    get: async (id: number) => ({ id, url: 'https://example.test/', windowId: 7, active: false }),
    query: async () => [{ id: 1, windowId: 7, title: 't', active: true, url: 'https://example.test/' + 'x'.repeat(120) }],
    update: async (id: number) => ({ id, windowId: 7 }),
    onRemoved: { addListener: () => {} },
    onUpdated: { addListener: () => {}, removeListener: () => {} },
  },
  windows: {
    update: async (id: number, u: Record<string, unknown>) => { windowUpdates.push([id, u]); return { id, state: u.state ?? 'normal', width: u.width ?? 1000, height: u.height ?? 800 }; },
  },
  scripting: { executeScript: async () => [{ result: [390, 700] }] },
  storage: { session: { get: async () => ({}), set: async () => {} }, local: { get: async () => ({}), set: async () => {} } },
  debugger: { attach: async () => {}, detach: async () => {}, sendCommand: async () => ({}), onDetach: { addListener: () => {} } },
  runtime: { sendMessage: async () => {}, onMessage: { addListener: () => {} } },
  action: { setBadgeBackgroundColor: () => {}, setBadgeText: () => {} },
};

const { handleTabs } = await import('../extension/handlers/tabs.js');
const { tabLocks } = await import('../extension/lib/state.js');

// Window resizing left with browser_resize_window (3.0): the viewport is browser_emulate (tests/emulation.test.ts).
describe('browser_tabs focus and the tab lock', () => {
  beforeEach(() => { windowUpdates.length = 0; tabLocks.unlockAll(); });

  // tabs create was removed in 3.0 (browser_navigate opens tabs); list and its format are in tests/v3-tabs.test.ts.
  it('focus activates the tab and raises its window', async () => {
    const res = await handleTabs({ action: 'focus', tabId: 3 });
    expect(windowUpdates[0]).toEqual([7, { focused: true }]);
    expect(res).toMatchObject({ success: true, focused: 3, text: 'focused tab 3' });
  });

  // Ported from wp4-gif-tabs.test.ts: a tab another agent locked is refused for close and focus.
  describe('a tab another agent locked', () => {
    beforeEach(() => { tabLocks.lock(3, 'session-owner'); });

    it.each(['close', 'focus'])('%s is refused with TAB_LOCKED naming the owner and since when', async (action) => {
      await expect(handleTabs({ action, tabId: 3 }, 'session-other'))
        .rejects.toThrow(/^TAB_LOCKED: tab 3 is locked by session-owner since \d{4}-\d{2}-\d{2}T/);
      expect(windowUpdates).toEqual([]);
      expect(tabLocks.owner(3)).toBe('session-owner');
    });

    it('an anonymous caller is refused too', async () => {
      await expect(handleTabs({ action: 'focus', tabId: 3 }, undefined)).rejects.toThrow(/^TAB_LOCKED: /);
    });

    it('the owner can focus it', async () => {
      await expect(handleTabs({ action: 'focus', tabId: 3 }, 'session-owner')).resolves.toMatchObject({ success: true, focused: 3 });
      expect(windowUpdates).toEqual([[7, { focused: true }]]);
    });
  });
});
