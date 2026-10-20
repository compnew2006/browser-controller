import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installFakePage, type FakeDocument } from './helpers/fake-dom.js';

// chrome mock: executeScript runs the page function in-process against the fake page.
(globalThis as any).chrome = {
  tabs: { get: async (id: number) => ({ id, url: 'https://example.test/page', windowId: 1 }), query: async () => [], onRemoved: { addListener: () => {} } },
  scripting: { executeScript: async (o: { func: (...a: any[]) => unknown; args?: unknown[] }) => [{ result: await o.func(...(o.args ?? [])) }] },
  storage: { session: { get: async () => ({}), set: async () => {} }, local: { get: async () => ({}), set: async () => {} } },
  debugger: { attach: async () => { throw new Error('no debugger in tests'); }, detach: async () => {}, sendCommand: async () => ({}), onDetach: { addListener: () => {} } },
};

const { parseTarget } = await import('../extension/lib/target.js');
const { PAGE_DOM_INSTALL, PAGE_DOM_VERSION } = await import('../extension/lib/page-dom.js');
const { locateTarget, locatePointer } = await import('../extension/lib/trusted-input.js');
const { fallbackByTab } = await import('../extension/lib/state.js');

let doc: FakeDocument;
const D = () => (globalThis as any).__bcDom;
const resolve = (target: string) => D().resolveTarget(parseTarget(target));
/** Element identity (toBe), not structure: two look-alike buttons must not pass. */
const expectHit = (res: any, el: unknown, via: string) => {
  expect(res.el).toBe(el);
  expect(res.via).toBe(via);
};

describe('parseTarget (the one locator grammar)', () => {
  it('reads a viewport point: ints, decimals, negatives, optional spaces', () => {
    expect(parseTarget('120,80')).toEqual({ kind: 'point', x: 120, y: 80 });
    expect(parseTarget(' 12 , 34.5 ')).toEqual({ kind: 'point', x: 12, y: 34.5 });
    expect(parseTarget('-5,-0.5')).toEqual({ kind: 'point', x: -5, y: -0.5 });
  });

  it('rejects a three-number list as a point (it falls through to a selector)', () => {
    expect(parseTarget('1,2,3').kind).toBe('selector');
  });

  it('reads text=<words> and collapses its whitespace', () => {
    expect(parseTarget('text=Sign in')).toEqual({ kind: 'text', text: 'Sign in' });
    expect(parseTarget('text=   Sign    in  ')).toEqual({ kind: 'text', text: 'Sign in' });
  });

  it('refuses text= with no words', () => {
    expect(() => parseTarget('text=')).toThrow(/^INVALID_ARGUMENT: text= needs words/);
    expect(() => parseTarget('text=   ')).toThrow(/^INVALID_ARGUMENT: text= needs words/);
  });

  it('reads snapshot refs as e<n> only; a hyphenated name like x-1 is a selector', () => {
    expect(parseTarget('e12')).toEqual({ kind: 'ref', ref: 'e12' });
    expect(parseTarget('s4k2-12')).toEqual({ kind: 'selector', selector: 's4k2-12' });
    expect(parseTarget('x-1')).toEqual({ kind: 'selector', selector: 'x-1' });
    expect(parseTarget('e')).toEqual({ kind: 'selector', selector: 'e' });
  });

  it('reads everything else as a CSS selector', () => {
    expect(parseTarget('#save')).toEqual({ kind: 'selector', selector: '#save' });
    expect(parseTarget('button.primary')).toEqual({ kind: 'selector', selector: 'button.primary' });
  });

  it('refuses a blank target', () => {
    expect(() => parseTarget('')).toThrow('INVALID_ARGUMENT: target is empty');
    expect(() => parseTarget('   ')).toThrow('INVALID_ARGUMENT: target is empty');
    expect(() => parseTarget(undefined as any)).toThrow('INVALID_ARGUMENT: target is empty');
  });
});

describe('resolveTarget (page side)', () => {
  beforeEach(() => {
    doc = installFakePage();
    fallbackByTab.clear();
    PAGE_DOM_INSTALL(PAGE_DOM_VERSION);
  });
  afterEach(() => { delete (doc as any).elementFromPoint; });

  it('text: an equal match beats a containing one', () => {
    const draft = doc.el('button', {}, 'Save draft');
    const save = doc.el('button', {}, 'Save');
    doc.body.append(draft, save);
    expectHit(resolve('text=Save'), save, 'text');
  });

  it('text: a containing match is used when nothing equals', () => {
    const draft = doc.el('button', {}, 'Save draft');
    doc.body.append(draft);
    expectHit(resolve('text=save DRAFT'), draft, 'text');
  });

  it('text: case-insensitive, whitespace collapsed on the page side too', () => {
    const btn = doc.el('button', {}, '  SIGN   in ');
    doc.body.append(btn);
    expect((resolve('text=sign in')).el).toBe(btn);
  });

  it('text: keeps the innermost interactive match (a link around a span)', () => {
    const link = doc.el('a', { href: '/open' }, doc.el('span', {}, 'Open'));
    doc.body.append(link);
    expectHit(resolve('text=Open'), link, 'text');
  });

  it('text: a plain text match is the innermost element when nothing is interactive', () => {
    const note = doc.el('span', {}, 'Note');
    doc.body.append(doc.el('div', {}, note));
    expect((resolve('text=Note')).el).toBe(note);
  });

  it('text: the innermost of nested interactive matches wins (a button inside a link)', () => {
    const button = doc.el('button', {}, 'Go');
    const link = doc.el('a', { href: '/go' }, button);
    doc.body.append(link);
    expectHit(resolve('text=Go'), button, 'text');
  });

  it('text: hidden elements never match', () => {
    const hidden = doc.el('button', {}, 'Ghost');
    hidden.hidden = true;
    doc.body.append(hidden);
    expect(resolve('text=Ghost')).toEqual({ error: 'NOT_FOUND: no visible element with text "Ghost"' });
  });

  it('text: no match is NOT_FOUND with the words', () => {
    doc.body.append(doc.el('p', {}, 'nothing here'));
    expect(resolve('text=Checkout')).toEqual({ error: 'NOT_FOUND: no visible element with text "Checkout"' });
  });

  it('text: several distinct best matches are AMBIGUOUS, each with a registered ref', () => {
    const a = doc.el('button', {}, 'Delete');
    const b = doc.el('button', {}, 'Delete');
    doc.body.append(a, b);
    const res = resolve('text=Delete');
    expect(res.error).toMatch(/^AMBIGUOUS: text=Delete matches 2 elements: e\d+ "Delete", e\d+ "Delete"$/);
    const refs = [...res.error.matchAll(/(e\d+) "/g)].map((m) => m[1]);
    expect(D().registry.get(refs[0])).toBe(a);
    expect(D().registry.get(refs[1])).toBe(b);
    // The agent can retry with one of them.
    expectHit(resolve(refs[1]), b, 'ref');
  });

  it('text: AMBIGUOUS lists at most five candidates and says there are more', () => {
    for (let i = 0; i < 7; i++) doc.body.append(doc.el('button', {}, 'Edit'));
    const msg = resolve('text=Edit').error as string;
    expect(msg).toMatch(/^AMBIGUOUS: text=Edit matches 7 elements: /);
    expect([...msg.matchAll(/e\d+ "Edit"/g)]).toHaveLength(5);
    expect(msg.endsWith(', …')).toBe(true);
  });

  it('ref: a registry hit resolves to the element', () => {
    const btn = doc.el('button', {}, 'Save');
    doc.body.append(btn);
    D().registry.set('e12', btn);
    expectHit(resolve('e12'), btn, 'ref');
  });

  it('ref: a miss is the bare REF_GONE code (the SW side words it), and no element is guessed', () => {
    doc.body.append(doc.el('button', {}, 'Save'));
    expect(resolve('e99')).toMatchObject({ error: 'REF_GONE', ref: 'e99' });
  });

  it('ref: a stale ref re-finds its element through the snapshot fallback, as the ref path always did', () => {
    const like1 = doc.el('button', { class: 'like' }, 'Like');
    const like2 = doc.el('button', { class: 'like' }, 'Like');
    doc.body.append(like1, doc.el('button', { class: 'like' }, 'Liked'), like2);
    const fb = { robustSelector: 'button.like', text: 'Like', role: 'button', tag: 'BUTTON', nth: 1 };
    expectHit(D().resolveTarget(parseTarget('e7'), fb), like2, 'fallback');
    expect(D().registry.get('e7')).toBe(like2);
  });

  it('selector: a custom element name (x-1) resolves as a visible selector, never as a ref', () => {
    const widget = doc.el('x-1', {}, 'Widget');
    doc.body.append(widget);
    expectHit(resolve('x-1'), widget, 'selector');
  });

  it('ref: a miss on an e<n> that is also an element name is REF_GONE, not a selector match', () => {
    doc.body.append(doc.el('e12', {}, 'Stray'));
    expect(resolve('e12')).toMatchObject({ error: 'REF_GONE', ref: 'e12' });
  });

  it('selector: a custom element name that is only hidden is ELEMENT_HIDDEN, not a ref miss', () => {
    const widget = doc.el('x-1', {}, 'Widget');
    widget.hidden = true;
    doc.body.append(widget);
    expect(resolve('x-1')).toMatchObject({ error: 'ELEMENT_HIDDEN: x-1 matches only hidden elements' });
  });

  it('selector: first visible match, hidden duplicates skipped', () => {
    const hidden = doc.el('input', { class: 'q' });
    hidden.hidden = true;
    const shown = doc.el('input', { class: 'q' });
    doc.body.append(hidden, shown);
    expectHit(resolve('input.q'), shown, 'selector');
  });

  it('selector: reaches into shadow roots', () => {
    const host = doc.el('my-widget');
    const inner = doc.el('button', { id: 'deep' }, 'Deep');
    host.attachShadow().append(inner);
    doc.body.append(host);
    expect((resolve('#deep')).el).toBe(inner);
  });

  it('selector: an invalid selector is INVALID_SELECTOR with the selector', () => {
    doc.body.append(doc.el('button', {}, 'Save'));
    expect(resolve('div[')).toEqual({ error: 'INVALID_SELECTOR: div[' });
  });

  it('selector: matches only hidden elements is ELEMENT_HIDDEN', () => {
    const hidden = doc.el('button', { class: 'gone' }, 'Gone');
    hidden.hidden = true;
    doc.body.append(hidden);
    expect(resolve('button.gone')).toEqual({ error: 'ELEMENT_HIDDEN: button.gone matches only hidden elements' });
  });

  it('selector: no match is NOT_FOUND', () => {
    doc.body.append(doc.el('button', {}, 'Save'));
    expect(resolve('.nope')).toEqual({ error: 'NOT_FOUND: .nope matches nothing' });
  });

  it('point: returns the point, with the element under it when there is one', () => {
    const btn = doc.el('button', {}, 'Under');
    doc.body.append(btn);
    (doc as any).elementFromPoint = () => btn;
    const res = resolve('40,50');
    expect(res).toMatchObject({ point: { x: 40, y: 50 }, via: 'point' });
    expect(res.el).toBe(btn);
  });

  it('point: no element under it is still a point', () => {
    expect(resolve('40,50')).toEqual({ point: { x: 40, y: 50 }, el: null, via: 'point' });
  });
});

describe('locateTarget (service-worker side)', () => {
  beforeEach(() => {
    doc = installFakePage();
    fallbackByTab.clear();
    (globalThis as any).innerWidth = 1280;
    (globalThis as any).innerHeight = 800;
    PAGE_DOM_INSTALL(PAGE_DOM_VERSION);
  });

  it('a text target locates the element and reports how it was found', async () => {
    doc.body.append(doc.el('button', {}, 'Save'));
    const loc = await locateTarget(1, { target: 'text=Save' });
    expect(loc).toMatchObject({ success: true, visible: true, via: 'text' });
  });

  it('a text target that is ambiguous comes back as AMBIGUOUS', async () => {
    doc.body.append(doc.el('button', {}, 'Delete'), doc.el('button', {}, 'Delete'));
    const loc = await locateTarget(1, { target: 'text=Delete' });
    expect(loc).toMatchObject({ success: false });
    expect(loc.error).toMatch(/^AMBIGUOUS: text=Delete matches 2 elements: /);
  });

  it('a stale ref is worded by refErrorMessage: REF_NOT_FOUND when never issued here', async () => {
    const loc = await locateTarget(1, { target: 'e99' });
    expect(loc).toMatchObject({ success: false });
    expect(loc.error).toMatch(/^REF_NOT_FOUND: ref e99 is not on this page/);
  });

  it('a stale ref re-found by its snapshot fallback is located', async () => {
    const like1 = doc.el('button', { class: 'like' }, 'Like');
    const like2 = doc.el('button', { class: 'like' }, 'Like');
    doc.body.append(like1, like2);
    fallbackByTab.set(1, new Map([['e7', { robustSelector: 'button.like', text: 'Like', role: 'button', tag: 'BUTTON', nth: 1 }]]));
    const loc = await locateTarget(1, { target: 'e7' });
    expect(loc).toMatchObject({ success: true, via: 'fallback' });
  });

  it('a stale ref issued in this document is worded as REF_GONE', async () => {
    // A ref is issued once the element has one (refFor); the element then leaves the page.
    const save = doc.el('button', {}, 'Save');
    doc.body.append(save);
    const ref = D().refFor(save) as string;
    save.isConnected = false;
    doc.body.childNodes.splice(doc.body.childNodes.indexOf(save), 1);
    fallbackByTab.set(1, new Map([[ref, { text: 'Save', role: 'button' }]]));
    const loc = await locateTarget(1, { target: ref });
    expect(loc.error).toMatch(new RegExp(`^REF_GONE: ref ${ref} is no longer on the page`));
  });

  it('a point target skips scroll and focus and returns that point', async () => {
    const loc = await locateTarget(1, { target: '40,50' });
    expect(loc).toMatchObject({ success: true, x: 40, y: 50, visible: true, via: 'point' });
  });

  it('a point outside the viewport is returned as not visible', async () => {
    const loc = await locateTarget(1, { target: '5000,5' });
    expect(loc).toMatchObject({ success: true, x: 5000, y: 5, visible: false });
  });

  it('check click still refuses a disabled element picked by text', async () => {
    doc.body.append(doc.el('button', { 'aria-disabled': 'true' }, 'Off'));
    const loc = await locatePointer(1, { target: 'text=Off' }, 'click');
    expect(loc).toMatchObject({ success: false });
    expect(loc.error).toMatch(/^ELEMENT_DISABLED: /);
  });

  it('an empty target is refused before anything runs on the page', async () => {
    await expect(locateTarget(1, { target: '  ' })).rejects.toThrow('INVALID_ARGUMENT: target is empty');
  });
});
