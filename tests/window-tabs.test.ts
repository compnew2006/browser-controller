import { beforeEach, describe, expect, it } from 'vitest';

const windowUpdates: Array<[number, Record<string, unknown>]> = [];
const created: Array<Record<string, unknown>> = [];
(globalThis as any).chrome = {
  tabs: {
    get: async (id: number) => ({ id, url: 'https://example.test/', windowId: 7, active: false }),
    query: async () => [{ id: 1, windowId: 7, title: 't', active: true, url: 'https://example.test/' + 'x'.repeat(120) }],
    create: async (o: Record<string, unknown>) => { created.push(o); return { id: 50, pendingUrl: o.url }; },
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

const { handleResizeWindow, handleTabs } = await import('../extension/handlers/tabs.js');

describe('window + tab controls', () => {
  beforeEach(() => { windowUpdates.length = 0; created.length = 0; });

  it('resizes the window that holds the tab and reports the viewport', async () => {
    const res = await handleResizeWindow({ tabId: 3, width: 390, height: 844 });
    expect(windowUpdates[0]).toEqual([7, { width: 390, height: 844, state: 'normal' }]);
    expect(res).toMatchObject({ success: true, windowId: 7, width: 390, height: 844, viewport: { width: 390, height: 700 } });
  });

  it('a non-normal state drops the size (Chrome rejects both together)', async () => {
    await handleResizeWindow({ tabId: 3, width: 390, state: 'maximized' });
    expect(windowUpdates[0]).toEqual([7, { state: 'maximized' }]);
  });

  it('create active:false opens a background tab; list keeps full URLs on request', async () => {
    const res = await handleTabs({ action: 'create', url: 'https://example.test/a', active: false });
    expect(created[0]).toEqual({ url: 'https://example.test/a', active: false });
    expect(res).toMatchObject({ tabId: 50, url: 'https://example.test/a', active: false });
    const short = await handleTabs({ action: 'list' });
    expect(short.tabs[0].url.endsWith('...')).toBe(true);
    const full = await handleTabs({ action: 'list', fullUrls: true });
    expect(full.tabs[0].url.length).toBeGreaterThan(120);
  });

  it('focus window:true also focuses the window', async () => {
    const res = await handleTabs({ action: 'focus', tabId: 3, window: true });
    expect(windowUpdates[0]).toEqual([7, { focused: true }]);
    expect(res).toMatchObject({ success: true, windowFocused: true });
  });
});
