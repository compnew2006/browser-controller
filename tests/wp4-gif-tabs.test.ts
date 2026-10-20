import { describe, it, expect, beforeEach } from 'vitest';

/**
 * browser_gif recording defaults (audit #13), the click ring's position, and the
 * resize guard for another agent's tab lock (audit #6).
 */
const tabStore = new Map<number, { id: number; windowId: number; url: string; active: boolean; index: number }>();
const windowUpdates: Array<[number, Record<string, unknown>]> = [];
const tabUpdates: Array<[number, Record<string, unknown>]> = [];
(globalThis as unknown as { chrome: unknown }).chrome = {
  tabs: {
    get: async (id: number) => {
      const t = tabStore.get(id);
      if (!t) throw new Error(`No tab with id: ${id}`);
      return { ...t };
    },
    query: async () => [...tabStore.values()].filter((t) => t.active),
    update: async (id: number, props: Record<string, unknown>) => { tabUpdates.push([id, props]); return { id }; },
    captureVisibleTab: async () => { throw new Error('captureVisibleTab must not run for a background tab'); },
    onRemoved: { addListener: () => {} },
    onUpdated: { addListener: () => {}, removeListener: () => {} },
  },
  windows: {
    update: async (id: number, u: Record<string, unknown>) => { windowUpdates.push([id, u]); return { id, state: 'normal', width: 800, height: 600 }; },
  },
  scripting: { executeScript: async () => [{ result: null }] },
  storage: { session: { get: async () => ({}), set: async () => {} }, local: { get: async () => ({}), set: async () => {} } },
  runtime: { sendMessage: async () => {}, onMessage: { addListener: () => {} } },
  action: { setBadgeBackgroundColor: () => {}, setBadgeText: () => {} },
  alarms: { create: () => {}, onAlarm: { addListener: () => {} } },
  webRequest: { onCompleted: { addListener: () => {} } },
  debugger: { attach: async () => {}, detach: async () => {}, sendCommand: async () => ({}), onDetach: { addListener: () => {} } },
};

const { handleGif, ringCenter, _recordings } = await import('../extension/handlers/gif.js');
const { handleResizeWindow, handleTabs } = await import('../extension/handlers/tabs.js');
const { tabLocks, gifRecordings } = await import('../extension/lib/state.js');

beforeEach(() => {
  tabStore.clear();
  windowUpdates.length = 0;
  tabUpdates.length = 0;
  gifRecordings.clear();
  tabLocks.unlockAll();
});

describe('ringCenter (the click ring on the GIF frame)', () => {
  it('scales a click from the captured frame to the output size', () => {
    // a 400x200 frame drawn into an 800x400 GIF: the click at (100, 50) lands at (200, 100)
    expect(ringCenter([100, 50], [400, 200], [800, 400])).toEqual([200, 100]);
  });

  it('keeps the same spot when the frame already has the output size', () => {
    expect(ringCenter([37, 9], [800, 400], [800, 400])).toEqual([37, 9]);
  });

  it('never divides by zero when a frame reads as size 0', () => {
    expect(ringCenter([10, 20], [0, 0], [800, 400])).toEqual([10, 20]);
  });
});

describe('browser_gif on a background tab', () => {
  it('does not switch to the tab by default: its frames are skipped, with a note', async () => {
    tabStore.set(5, { id: 5, windowId: 1, url: 'https://bg.test', active: false, index: 1 });
    await handleGif({ tabId: 5, action: 'start' });
    expect(_recordings().get(5)).toMatchObject({ activate: false, recording: true });
    expect(tabUpdates).toEqual([]);
    const status = await handleGif({ tabId: 5, action: 'status' });
    expect(status).toMatchObject({ success: true, recording: true, frames: 0, skipped: 1 });
    expect(status.note).toMatch(/1 frame\(s\) skipped/);
    expect(tabUpdates).toEqual([]);
  });
});

describe('browser_resize_window and another agent\'s tab lock', () => {
  beforeEach(() => {
    tabStore.set(3, { id: 3, windowId: 7, url: 'https://example.test/', active: true, index: 0 });
  });

  it('refuses to resize a tab locked by another session, with TAB_LOCKED', async () => {
    tabLocks.lock(3, 'session-owner');
    await expect(handleResizeWindow({ tabId: 3, width: 390, height: 844 }, 'session-other')).rejects.toThrow(/^TAB_LOCKED: /);
    expect(windowUpdates).toEqual([]);
  });

  it('resizes the window for the lock owner', async () => {
    tabLocks.lock(3, 'session-owner');
    const res = await handleResizeWindow({ tabId: 3, width: 390, height: 844 }, 'session-owner');
    expect(windowUpdates).toEqual([[7, { width: 390, height: 844, state: 'normal' }]]);
    expect(res).toMatchObject({ success: true, windowId: 7 });
  });

  it('resizes an unlocked tab', async () => {
    const res = await handleResizeWindow({ tabId: 3, width: 390 }, 'session-any');
    expect(res).toMatchObject({ success: true, windowId: 7 });
  });
});

describe('browser_tabs on a tab another agent locked', () => {
  beforeEach(() => {
    tabStore.set(3, { id: 3, windowId: 7, url: 'https://example.test/', active: false, index: 0 });
    tabLocks.lock(3, 'session-owner');
  });

  it.each(['reload', 'close', 'focus', 'unlock'])('%s is refused with TAB_LOCKED naming the owner and since when', async (action) => {
    await expect(handleTabs({ action, tabId: 3 }, 'session-other'))
      .rejects.toThrow(/^TAB_LOCKED: tab 3 is locked by session-owner since \d{4}-\d{2}-\d{2}T/);
    expect(tabUpdates).toEqual([]);
    expect(tabLocks.owner(3)).toBe('session-owner');
  });

  it('an anonymous caller is refused too', async () => {
    await expect(handleTabs({ action: 'focus', tabId: 3 }, undefined)).rejects.toThrow(/^TAB_LOCKED: /);
  });

  it('the owner can focus it', async () => {
    await expect(handleTabs({ action: 'focus', tabId: 3 }, 'session-owner')).resolves.toMatchObject({ success: true, focused: 3 });
    expect(tabUpdates).toEqual([[3, { active: true }]]);
  });
});
