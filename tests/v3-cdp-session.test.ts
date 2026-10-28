import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * A tab's debugger session (lib/cdp-session.js). A debugger that goes away without its
 * onDetach event (the extension's own detach, a Chrome-side drop) must not leave a stale
 * session behind: the failing call forgets it, and the next call attaches again.
 */

const dbg = { attached: new Set<number>(), attachCount: 0, sent: [] as string[] };
(globalThis as unknown as { chrome: unknown }).chrome = {
  tabs: { get: async (id: number) => ({ id, url: 'https://example.test/', windowId: 1 }), onRemoved: { addListener: () => {} } },
  windows: { get: async () => ({ width: 1280, height: 900 }) },
  debugger: {
    attach: async (t: { tabId: number }) => { dbg.attachCount++; dbg.attached.add(t.tabId); },
    detach: async (t: { tabId: number }) => { dbg.attached.delete(t.tabId); },
    sendCommand: async (t: { tabId: number }, method: string, params: Record<string, unknown> = {}) => {
      if (!dbg.attached.has(t.tabId)) throw new Error(`Debugger is not attached to the tab with id: ${t.tabId}.`);
      dbg.sent.push(method);
      if (method === 'Runtime.evaluate' && params.expression === 'innerWidth * innerHeight') return { result: { type: 'number', value: 1 } };
      return {};
    },
    onEvent: { addListener: () => {} },
    onDetach: { addListener: () => {} },
  },
};

const { ensureCdp, detachCdp, sendAttached } = await import('../extension/lib/cdp-session.js');
const { dropCard, recordCard } = await import('../extension/lib/vault-card.js');

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

describe('a vault approval card on the tab (specs/006 D5)', () => {
  beforeEach(() => {
    dbg.attached.clear();
    dbg.sent.length = 0;
  });
  afterEach(async () => {
    dropCard(7);
    await detachCdp(7);
  });

  it('refuses input that could press the card, and lets other commands and releases through', async () => {
    const send = await ensureCdp(7);
    dbg.sent.length = 0; // the commands attaching sent
    recordCard(7, { requestId: 'req_ab', documentId: 'doc-1', origin: 'https://example.test', token: 't', expiresAt: Date.now() + 60_000 });
    await expect(send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 1, y: 1 })).rejects.toThrow(/^VAULT_APPROVAL_PENDING:/);
    await expect(send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter' })).rejects.toThrow(/^VAULT_APPROVAL_PENDING:/);
    await expect(send('Input.insertText', { text: 'x' })).rejects.toThrow(/^VAULT_APPROVAL_PENDING:/);
    await expect(sendAttached(7, 'Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [] })).rejects.toThrow(/^VAULT_APPROVAL_PENDING:/);
    expect(dbg.sent.filter((method) => method.startsWith('Input.'))).toEqual([]);

    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 1, y: 1 });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter' });
    await send('Runtime.evaluate', { expression: '1' });
    expect(dbg.sent).toEqual(['Input.dispatchMouseEvent', 'Input.dispatchKeyEvent', 'Runtime.evaluate']);
  });

  it('lets input through once the card is gone or expired, and on other tabs', async () => {
    const send = await ensureCdp(7);
    recordCard(7, { requestId: 'req_ab', documentId: 'doc-1', origin: 'https://example.test', token: 't', expiresAt: Date.now() + 60_000 });
    dropCard(7, 'req_ab');
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 1, y: 1 });
    recordCard(7, { requestId: 'req_cd', documentId: 'doc-1', origin: 'https://example.test', token: 't', expiresAt: Date.now() - 1 });
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 1, y: 1 });
    const other = await ensureCdp(8);
    recordCard(7, { requestId: 'req_ef', documentId: 'doc-1', origin: 'https://example.test', token: 't', expiresAt: Date.now() + 60_000 });
    await other('Input.dispatchMouseEvent', { type: 'mousePressed', x: 1, y: 1 });
    expect(dbg.sent.filter((method) => method.startsWith('Input.'))).toEqual(['Input.dispatchMouseEvent', 'Input.dispatchMouseEvent', 'Input.dispatchMouseEvent']);
    await detachCdp(8);
  });
});
