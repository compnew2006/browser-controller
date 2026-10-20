import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * A tab's debugger session (lib/cdp-session.js). A debugger that goes away without its
 * onDetach event (the extension's own detach, a Chrome-side drop) must not leave a stale
 * session behind: the failing call forgets it, and the next call attaches again.
 */

const dbg = { attached: new Set<number>(), attachCount: 0 };
(globalThis as unknown as { chrome: unknown }).chrome = {
  tabs: { get: async (id: number) => ({ id, url: 'https://example.test/', windowId: 1 }), onRemoved: { addListener: () => {} } },
  windows: { get: async () => ({ width: 1280, height: 900 }) },
  debugger: {
    attach: async (t: { tabId: number }) => { dbg.attachCount++; dbg.attached.add(t.tabId); },
    detach: async (t: { tabId: number }) => { dbg.attached.delete(t.tabId); },
    sendCommand: async (t: { tabId: number }, method: string, params: Record<string, unknown> = {}) => {
      if (!dbg.attached.has(t.tabId)) throw new Error(`Debugger is not attached to the tab with id: ${t.tabId}.`);
      if (method === 'Runtime.evaluate' && params.expression === 'innerWidth * innerHeight') return { result: { type: 'number', value: 1 } };
      return {};
    },
    onEvent: { addListener: () => {} },
    onDetach: { addListener: () => {} },
  },
};

const { ensureCdp, detachCdp } = await import('../extension/lib/cdp-session.js');

describe('a debugger session that went away without its event', () => {
  beforeEach(() => {
    dbg.attached.clear();
    dbg.attachCount = 0;
  });
  afterEach(async () => {
    await detachCdp(7);
  });

  it('the failing call forgets the stale session, and the next call attaches again', async () => {
    const send = await ensureCdp(7);
    expect(dbg.attachCount).toBe(1);
    dbg.attached.delete(7); // detached with no onDetach event
    await expect(send('Input.dispatchMouseEvent', {})).rejects.toThrow(/not attached/);

    const again = await ensureCdp(7);
    expect(dbg.attachCount).toBe(2);
    await expect(again('Runtime.evaluate', { expression: '1' })).resolves.toEqual({});
  });
});
