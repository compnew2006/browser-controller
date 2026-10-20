import { beforeEach, describe, expect, it } from 'vitest';
import { installFakePage, installFakeFrame, type FakeDocument, type FakeElement } from './helpers/fake-dom.js';

// executeScript runs the page function in-process; the debugger records the CDP keys sent.
const cdp: Array<{ method: string; params: Record<string, any> }> = [];
(globalThis as any).chrome = {
  tabs: { get: async (id: number) => ({ id, url: 'https://example.test/page', windowId: 1 }), query: async () => [], onRemoved: { addListener: () => {} } },
  scripting: { executeScript: async (o: { func: (...a: any[]) => unknown; args?: unknown[] }) => [{ result: await o.func(...(o.args ?? [])) }] },
  storage: { session: { get: async () => ({}), set: async () => {} }, local: { get: async () => ({}), set: async () => {} } },
  debugger: {
    attach: async () => {},
    detach: async () => {},
    sendCommand: async (_t: unknown, method: string, params: Record<string, any> = {}) => { cdp.push({ method, params }); return {}; },
    onDetach: { addListener: () => {} },
  },
};

const { PAGE_DOM_INSTALL, PAGE_DOM_VERSION } = await import('../extension/lib/page-dom.js');
const { handleType } = await import('../extension/handlers/interaction.js');
const { handleFill } = await import('../extension/handlers/interaction-advanced.js');
const { keyDefinition } = await import('../extension/lib/trusted-input.js');
// The "withListeners" helper is used by the select tests below.
const { fallbackByTab } = await import('../extension/lib/state.js');
const { detachCdp } = await import('../extension/lib/cdp-session.js');

let doc: FakeDocument;

/** Record listeners on a fake element (the fake has none) so blur can be driven. */
function withListeners(el: FakeElement) {
  const listeners: Array<{ type: string; fn: () => void }> = [];
  (el as any).addEventListener = (type: string, fn: () => void) => { listeners.push({ type, fn }); };
  (el as any).removeEventListener = (type: string, fn: () => void) => {
    const i = listeners.findIndex((l) => l.type === type && l.fn === fn);
    if (i >= 0) listeners.splice(i, 1);
  };
  return { blur: () => { for (const l of [...listeners]) if (l.type === 'blur') l.fn(); } };
}

beforeEach(() => {
  cdp.length = 0;
  doc = installFakePage();
  fallbackByTab.clear();
  PAGE_DOM_INSTALL(PAGE_DOM_VERSION);
});

// Ported from the removed browser_press_key suite: browser_type's key takes the same key names.
describe('browser_type key: key names are validated before any input is sent', () => {
  it('a word that is not a key fails with UNKNOWN_KEY and nothing reaches the page', async () => {
    const body = doc.body;
    await expect(handleType({ tabId: 1, key: 'Hello' })).rejects.toThrow(/^UNKNOWN_KEY: "Hello".*text/);
    expect(body.events).toEqual([]);
  });

  it('an unknown word inside a combo fails too', async () => {
    await expect(handleType({ tabId: 1, key: 'Control+Hello' })).rejects.toThrow(/^UNKNOWN_KEY/);
  });

  it('keys the table lacked (CapsLock, NumLock, ...) are known now and are sent as themselves', async () => {
    expect(keyDefinition('CapsLock')).toMatchObject({ code: 'CapsLock', vk: 20 });
    const res = await handleType({ tabId: 1, key: 'CapsLock' });
    expect(res).toMatchObject({ success: true, input: 'cdp' });
    expect(cdp.filter((c) => c.method === 'Input.dispatchKeyEvent' && c.params.key === 'CapsLock').map((c) => c.params.type)).toEqual(['rawKeyDown', 'keyUp']);
    expect(doc.body.events).toEqual([]);
  });

  it('combos and single characters still work', async () => {
    expect(await handleType({ tabId: 1, key: 'ctrl+a' })).toMatchObject({ success: true, input: 'cdp' });
    expect(await handleType({ tabId: 1, key: 'a' })).toMatchObject({ success: true, input: 'cdp' });
  });

  it('a key without a debugger is DEBUGGER_UNAVAILABLE: no synthetic keydown', async () => {
    await detachCdp(1);
    (globalThis as any).chrome.debugger.attach = async () => { throw new Error('Another debugger is attached'); };
    try {
      await expect(handleType({ tabId: 1, key: 'Enter' })).rejects.toThrow(/^DEBUGGER_UNAVAILABLE: /);
      expect(doc.body.events).toEqual([]);
    } finally {
      (globalThis as any).chrome.debugger.attach = async () => {};
    }
  });
});

// Ported from the removed browser_select suite: browser_fill picks a <select>'s option the same way.
describe('browser_fill on a select: a pick that matches nothing fails and lists the options', () => {
  function makeSelect(id: string, labels: string[]): FakeElement {
    const sel = doc.el('select', { id });
    (sel as any).options = labels.map((label, i) => ({ value: `v${i}`, textContent: label, index: i }));
    withListeners(sel);
    doc.body.append(sel);
    return sel;
  }

  it('a value that exists nowhere is OPTION_NOT_FOUND, listing up to five labels', async () => {
    makeSelect('s', ['Red', 'Green', 'Blue', 'Amber', 'Teal', 'Plum']);
    const res = await handleFill({ tabId: 1, fields: [{ target: '#s', value: 'nope' }] });
    expect(res).toMatchObject({ success: false, error: expect.stringMatching(/^FILL_FAILED: 1 of 1 fields failed\n#s: OPTION_NOT_FOUND: "nope"/) });
    expect(res.error).toContain('Red, Green, Blue, Amber, Teal');
    expect(res.error).toContain('…');
  });

  it('a label matches case-insensitively and fires input before change', async () => {
    const sel = makeSelect('c', ['Red', 'Green']);
    const res = await handleFill({ tabId: 1, fields: [{ target: '#c', value: 'GREEN' }] });
    expect(res).toMatchObject({ success: true });
    expect((sel as any).selectedIndex).toBe(1);
    expect(sel.events).toEqual(['input', 'change']);
  });

  it('a value matches exactly, and a value that is only a label in another case is OPTION_NOT_FOUND', async () => {
    const sel = makeSelect('v', ['One', 'Two']);
    expect(await handleFill({ tabId: 1, fields: [{ target: '#v', value: 'v1' }] })).toMatchObject({ success: true });
    expect((sel as any).selectedIndex).toBe(1);
    expect(await handleFill({ tabId: 1, fields: [{ target: '#v', value: 'V1' }] })).toMatchObject({ success: false, error: expect.stringMatching(/OPTION_NOT_FOUND/) });
  });
});
