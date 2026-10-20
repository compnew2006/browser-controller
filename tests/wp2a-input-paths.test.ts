import { beforeEach, describe, expect, it } from 'vitest';
import { installFakePage, installFakeFrame, type FakeDocument, type FakeElement } from './helpers/fake-dom.js';

// Synthetic-path mock (no debugger): executeScript runs the page function in-process.
(globalThis as any).chrome = {
  tabs: { get: async (id: number) => ({ id, url: 'https://example.test/page', windowId: 1 }), query: async () => [], onRemoved: { addListener: () => {} } },
  scripting: { executeScript: async (o: { func: (...a: any[]) => unknown; args?: unknown[] }) => [{ result: await o.func(...(o.args ?? [])) }] },
  storage: { session: { get: async () => ({}), set: async () => {} }, local: { get: async () => ({}), set: async () => {} } },
  debugger: { attach: async () => { throw new Error('no debugger in tests'); }, detach: async () => {}, sendCommand: async () => ({}), onDetach: { addListener: () => {} } },
};

const { PAGE_DOM_INSTALL, PAGE_DOM_VERSION } = await import('../extension/lib/page-dom.js');
const { handleType, handleSelect, handleHover } = await import('../extension/handlers/interaction.js');
const { handlePressKey } = await import('../extension/handlers/interaction-keys.js');
const { keyDefinition } = await import('../extension/lib/trusted-input.js');
const { fallbackByTab } = await import('../extension/lib/state.js');

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
  doc = installFakePage();
  fallbackByTab.clear();
  PAGE_DOM_INSTALL(PAGE_DOM_VERSION);
});

describe('browser_press_key: key names are validated before any input is sent', () => {
  it('a word that is not a key fails with UNKNOWN_KEY and nothing reaches the page', async () => {
    const body = doc.body;
    const res = await handlePressKey({ tabId: 1, key: 'Hello' });
    expect(res).toMatchObject({ success: false, error: expect.stringMatching(/^UNKNOWN_KEY: "Hello".*browser_type/) });
    expect(body.events).toEqual([]);
  });

  it('an unknown word inside a sequence or combo fails too', async () => {
    expect(await handlePressKey({ tabId: 1, key: 'Hello World' })).toMatchObject({ success: false, error: expect.stringMatching(/^UNKNOWN_KEY/) });
    expect(await handlePressKey({ tabId: 1, key: 'Control+Hello' })).toMatchObject({ success: false, error: expect.stringMatching(/^UNKNOWN_KEY/) });
  });

  it('keys the table lacked (CapsLock, NumLock, ...) are known now and are sent as themselves', async () => {
    expect(keyDefinition('CapsLock')).toMatchObject({ code: 'CapsLock', vk: 20 });
    const res = await handlePressKey({ tabId: 1, key: 'CapsLock' });
    expect(res).toMatchObject({ success: true, key: 'CapsLock' });
    expect(doc.body.events).toEqual(['keydown', 'keypress', 'keyup']);
  });

  it('combos and single characters still work', async () => {
    expect(await handlePressKey({ tabId: 1, key: 'ctrl+a' })).toMatchObject({ success: true, key: 'a' });
    expect(await handlePressKey({ tabId: 1, key: 'a' })).toMatchObject({ success: true, key: 'a' });
  });
});

describe('browser_select: a pick that matches nothing fails and lists the options', () => {
  function makeSelect(id: string, labels: string[]): FakeElement {
    const sel = doc.el('select', { id });
    (sel as any).options = labels.map((label, i) => ({ value: `v${i}`, textContent: label, index: i }));
    withListeners(sel);
    doc.body.append(sel);
    return sel;
  }

  it('a value that exists nowhere is OPTION_NOT_FOUND, listing up to five labels', async () => {
    makeSelect('s', ['Red', 'Green', 'Blue', 'Amber', 'Teal', 'Plum']);
    const res = await handleSelect({ tabId: 1, selector: '#s', value: 'nope' });
    expect(res).toMatchObject({ success: false, error: expect.stringMatching(/^OPTION_NOT_FOUND: no option with value "nope"/) });
    expect(res.error).toContain('Red | Green | Blue | Amber | Teal');
    expect(res.error).toContain('6 in total');
  });

  it('a label matches case-insensitively and fires input before change', async () => {
    const sel = makeSelect('c', ['Red', 'Green']);
    const res = await handleSelect({ tabId: 1, selector: '#c', label: 'GREEN' });
    expect(res).toMatchObject({ success: true });
    expect((sel as any).selectedIndex).toBe(1);
    expect(sel.events).toEqual(['input', 'change']);
  });

  it('a value matches exactly, and an out-of-range index is OPTION_NOT_FOUND', async () => {
    const sel = makeSelect('v', ['One', 'Two']);
    expect(await handleSelect({ tabId: 1, selector: '#v', value: 'v1' })).toMatchObject({ success: true });
    expect((sel as any).selectedIndex).toBe(1);
    expect(await handleSelect({ tabId: 1, selector: '#v', value: 'V1' })).toMatchObject({ success: false, error: expect.stringMatching(/^OPTION_NOT_FOUND/) });
    expect(await handleSelect({ tabId: 1, selector: '#v', index: 9 })).toMatchObject({ success: false, error: expect.stringMatching(/^OPTION_NOT_FOUND: index 9/) });
  });
});

describe('browser_type (synthetic path): user-like events, frames, short result', () => {
  it('one keydown/keypress/input/keyup per character, and change only when focus leaves', async () => {
    const field = doc.el('input', { id: 'q' });
    doc.body.append(field);
    const { blur } = withListeners(field);
    const res = await handleType({ tabId: 1, selector: '#q', text: 'abc', trusted: false });
    expect(res).toMatchObject({ success: true, typed: 3, value: 'abc' });
    expect(field.events.filter((t) => t === 'input')).toHaveLength(3);
    expect(field.events.filter((t) => t === 'keydown')).toHaveLength(3);
    expect(field.events).not.toContain('change');
    blur();
    expect(field.events.filter((t) => t === 'change')).toHaveLength(1);
  });

  it('a keypress the page cancels (an input mask) inserts nothing for that character', async () => {
    const field = doc.el('input', { id: 'digits' });
    doc.body.append(field);
    // The fake keeps the KeyboardEvent init on `init` (the browser exposes it as `key`).
    (field as any).dispatchEvent = (e: { type: string; init: { key: string } }) => {
      field.events.push(e.type);
      return !(e.type === 'keypress' && e.init.key === 'x');
    };
    const res = await handleType({ tabId: 1, selector: '#digits', text: 'a1x2', trusted: false });
    expect(res).toMatchObject({ success: true, value: 'a12' });
  });

  it('a textarea inside a same-origin iframe is found and typed into', async () => {
    const frame = doc.el('iframe', { id: 'f' });
    doc.body.append(frame);
    const inner = installFakeFrame(frame);
    const area = inner.el('textarea', { id: 'note' });
    inner.body.append(area);
    const res = await handleType({ tabId: 1, selector: '#note', text: 'hi', trusted: false });
    expect(res).toMatchObject({ success: true, value: 'hi' });
  });

  it('with no ref, typing follows focus into a same-origin iframe', async () => {
    const frame = doc.el('iframe', { id: 'f2' });
    doc.body.append(frame);
    const inner = installFakeFrame(frame);
    const field = inner.el('input', { id: 'inner' });
    inner.body.append(field);
    doc.activeElement = frame;
    inner.activeElement = field;
    const res = await handleType({ tabId: 1, text: 'ok', trusted: false });
    expect(res).toMatchObject({ success: true, value: 'ok' });
  });

  it('the result is short: the typed length and the targeted value (at most 100 characters)', async () => {
    const field = doc.el('input', { id: 'long' });
    doc.body.append(field);
    const text = 'x'.repeat(150);
    const res = await handleType({ tabId: 1, selector: '#long', text, trusted: false });
    expect(res.typed).toBe(150);
    expect(res.value).toHaveLength(100);
    expect(JSON.stringify(res).length).toBeLessThan(300);
  });
});

describe('browser_hover (synthetic path) says what it could not do', () => {
  it('succeeds with trusted:false and a note that CSS :hover was not applied', async () => {
    const menu = doc.el('button', { id: 'menu' }, 'Menu');
    doc.body.append(menu);
    const res = await handleHover({ tabId: 1, selector: '#menu', trusted: false });
    expect(res).toMatchObject({ success: true, input: 'synthetic', trusted: false });
    expect(res.note).toMatch(/CSS :hover was not applied/);
    expect(menu.events).toEqual(expect.arrayContaining(['mouseover', 'mousemove']));
  });
});
