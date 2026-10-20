import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installFakePage, type FakeDocument, type FakeElement } from './helpers/fake-dom.js';

// Trusted-path mock: executeScript runs the page function in-process against the fake
// page, and the debugger records every CDP command (the clicks that were really sent).
const cdp: Array<{ method: string; params: Record<string, any> }> = [];
const inputs = () => cdp.filter((c) => c.method.startsWith('Input.'));
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
const { handleClick } = await import('../extension/handlers/interaction.js');
const { fallbackByTab } = await import('../extension/lib/state.js');

let doc: FakeDocument;
const D = () => (globalThis as any).__bcDom;

/** The page's hit-test, as the browser answers it: topmost first. */
function stackAt(...topmostFirst: FakeElement[]) {
  (doc as any).elementsFromPoint = () => topmostFirst;
}

/** Stand-in for the extension's own lock shield (id __bc-*, pointer-events:auto). */
function lockShield(): FakeElement {
  const shield = doc.el('div', { id: '__bc-lock-shield' });
  shield.closest = (sel: string) => (sel === '[id^="__bc-"]' ? shield : null) as any;
  doc.body.append(shield);
  return shield;
}

describe('clickBlocker: one actionability check for both click paths', () => {
  beforeEach(() => {
    doc = installFakePage();
    fallbackByTab.clear();
    PAGE_DOM_INSTALL(PAGE_DOM_VERSION);
  });
  afterEach(() => { delete (doc as any).elementsFromPoint; });

  it('a visible, enabled element with nothing on top of it may be clicked', () => {
    const btn = doc.el('button', {}, 'Save');
    doc.body.append(btn);
    stackAt(btn);
    expect(D().clickBlocker(btn)).toBeNull();
  });

  it('display:none / hidden targets are ELEMENT_HIDDEN', () => {
    const btn = doc.el('button', {}, 'Gone');
    btn.hidden = true;
    doc.body.append(btn);
    expect(D().clickBlocker(btn)).toMatchObject({ message: expect.stringMatching(/^ELEMENT_HIDDEN: /) });
  });

  it('a disabled control is ELEMENT_DISABLED (native :disabled, aria-disabled, or a disabled ancestor)', () => {
    const native = doc.el('button', {}, 'Native');
    (native as any).matches = (sel: string) => sel === ':disabled' || FakeElementMatches(native, sel);
    const aria = doc.el('button', { 'aria-disabled': 'true' }, 'Aria');
    const group = doc.el('div', { 'aria-disabled': 'true' }, doc.el('a', { href: '/x' }, 'Inside'));
    const inside = (group.children[0] as FakeElement);
    doc.body.append(native, aria, group);
    stackAt(native);
    expect(D().clickBlocker(native)).toMatchObject({ message: expect.stringMatching(/^ELEMENT_DISABLED: /) });
    stackAt(aria);
    expect(D().clickBlocker(aria)).toMatchObject({ message: expect.stringMatching(/^ELEMENT_DISABLED: /) });
    stackAt(inside);
    expect(D().clickBlocker(inside)).toMatchObject({ message: expect.stringMatching(/^ELEMENT_DISABLED: /) });
  });

  it('a target covered by another element is ELEMENT_COVERED and names the cover', () => {
    const btn = doc.el('button', {}, 'Buy');
    const cover = doc.el('div', { class: 'cookie-banner' });
    doc.body.append(btn, cover);
    stackAt(cover, btn);
    const block = D().clickBlocker(btn);
    expect(block.message).toMatch(/^ELEMENT_COVERED: /);
    expect(block.message).toContain('div.cookie-banner');
  });

  it('the target\'s own descendant on top of it is not a cover', () => {
    const btn = doc.el('button', {}, doc.el('span', {}, 'Buy'));
    doc.body.append(btn);
    stackAt((btn.children[0] as FakeElement), btn);
    expect(D().clickBlocker(btn)).toBeNull();
  });

  it('the extension\'s own overlays are transparent: the page underneath decides', () => {
    const btn = doc.el('button', {}, 'Buy');
    doc.body.append(btn);
    const shield = lockShield();
    stackAt(shield, btn);
    expect(D().clickBlocker(btn)).toBeNull();
    expect(D().elementAt(60, 20)).toBe(btn);
  });
});

/** The fake's own matcher, for the cases where a test overrides `matches`. */
function FakeElementMatches(el: FakeElement, sel: string): boolean {
  return (Object.getPrototypeOf(el) as { matches: (s: string) => boolean }).matches.call(el, sel);
}

describe('browser_click refuses a target it cannot click (trusted path)', () => {
  beforeEach(() => {
    cdp.length = 0;
    doc = installFakePage();
    fallbackByTab.clear();
    PAGE_DOM_INSTALL(PAGE_DOM_VERSION);
  });
  afterEach(() => { delete (doc as any).elementsFromPoint; });

  it('a covered button fails with ELEMENT_COVERED and no click is dispatched', async () => {
    const btn = doc.el('button', { id: 'buy' }, 'Buy');
    const cover = doc.el('div', { id: 'promo' });
    doc.body.append(btn, cover);
    stackAt(cover, btn);
    const res = await handleClick({ tabId: 1, target: '#buy' });
    expect(res).toMatchObject({ success: false, error: expect.stringMatching(/^ELEMENT_COVERED: /) });
    expect(inputs()).toEqual([]);
    expect(btn.events).not.toContain('click');
  });

  it('a display:none button fails with ELEMENT_HIDDEN instead of firing its handler', async () => {
    const btn = doc.el('button', { id: 'hid' }, 'Hidden');
    btn.hidden = true;
    doc.body.append(btn);
    const res = await handleClick({ tabId: 1, target: '#hid' });
    expect(res).toMatchObject({ success: false, error: expect.stringMatching(/^ELEMENT_HIDDEN: /) });
    expect(inputs()).toEqual([]);
    expect(btn.events).not.toContain('click');
  });

  it('a disabled button fails with ELEMENT_DISABLED', async () => {
    const btn = doc.el('button', { id: 'off', 'aria-disabled': 'true' }, 'Off');
    doc.body.append(btn);
    stackAt(btn);
    const res = await handleClick({ tabId: 1, target: '#off' });
    expect(res).toMatchObject({ success: false, error: expect.stringMatching(/^ELEMENT_DISABLED: /) });
    expect(inputs()).toEqual([]);
    expect(btn.events).not.toContain('click');
  });

  it('an actionable button is still clicked (no regression on the happy path)', async () => {
    const btn = doc.el('button', { id: 'ok' }, 'OK');
    doc.body.append(btn);
    stackAt(btn);
    const res = await handleClick({ tabId: 1, target: '#ok' });
    expect(res).toMatchObject({ success: true, at: { x: 60, y: 20 }, text: 'clicked #ok' });
    expect(res).not.toHaveProperty('warning');
    expect(inputs().filter((c) => c.params.type === 'mousePressed')).toHaveLength(1);
  });
});
