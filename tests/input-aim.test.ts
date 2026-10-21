import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installFakeFrame, installFakePage, type FakeDocument, type FakeElement } from './helpers/fake-dom.js';

/**
 * Where trusted input aims (lib/trusted-input.js pageLocate), run for real against the fake
 * page: focus seen from the top document (a frame without focus still has an activeElement),
 * no scroll for a target already in full view, a scrolled target measured until it holds still,
 * a press that lands outside its target reported, and controls that a click would change
 * focused without one.
 */

const cdp: Array<{ method: string; params: Record<string, any> }> = [];
const inputs = () => cdp.filter((c) => c.method.startsWith('Input.'));
const mouse = () => inputs().filter((c) => c.method === 'Input.dispatchMouseEvent');
/** Runs after every page function: plays what the page does between two measurements. */
let afterPageRun: () => void = () => {};
/** Capture-phase listeners the page side added to the window, by event type. */
let listeners = new Map<string, Array<(e: unknown) => void>>();
/** The element a trusted press lands on: undefined is the element under the point (else the aimed one), null is no element. */
let pressLandsOn: FakeElement | null | undefined;
/** A Chrome dialog over the tab (a password-breach warning): the page gets none of the input. */
let chromeDialog = false;
/** The page refuses typed text (its value stays as it was). */
let rejectText = false;
const watching = () => [...listeners.values()].flat();
function fire(type: string, target: unknown) {
  for (const fn of [...(listeners.get(type) ?? [])]) fn({ type, isTrusted: true, target, composedPath: () => [target] });
}
/** What a real page gets from one CDP input call: events at the window, focus on a press, text into the focused field. */
function pageGets(method: string, params: Record<string, any>) {
  if (chromeDialog) return;
  const under = () => ((doc as any).elementsFromPoint?.(params.x, params.y) ?? [])[0] ?? (globalThis as any).__bcLocatedEl;
  if (method === 'Input.dispatchMouseEvent' && params.type === 'mouseMoved') fire('mousemove', under());
  if (method === 'Input.dispatchMouseEvent' && params.type === 'mousePressed') {
    const hit = pressLandsOn === undefined ? under() : pressLandsOn;
    if (!hit) return;
    fire('pointerdown', hit);
    fire('mousedown', hit);
    if (typeof hit.focus === 'function') hit.focus();
    // Focus inside a frame makes the frame the top document's active element.
    const frame = hit.ownerDocument?.defaultView?.frameElement;
    if (frame) doc.activeElement = frame;
  }
  if (method === 'Input.dispatchKeyEvent' && params.type !== 'keyUp') fire('keydown', doc.activeElement);
  if (method === 'Input.insertText' && !rejectText) {
    let el = doc.activeElement as any;
    while (el?.contentDocument?.activeElement) el = el.contentDocument.activeElement;
    if (el?.isContentEditable) el.append(params.text);
    else if (el && typeof el.value === 'string') el.value += params.text;
    else if (el) el.value = params.text;
  }
}

(globalThis as any).chrome = {
  tabs: { get: async (id: number) => ({ id, url: 'https://example.test/page', windowId: 1 }), query: async () => [], onRemoved: { addListener: () => {} } },
  windows: { get: async () => ({ width: 1280, height: 900 }) },
  scripting: {
    executeScript: async (o: { func: (...a: any[]) => unknown; args?: unknown[] }) => {
      const result = await o.func(...(o.args ?? []));
      afterPageRun();
      return [{ result }];
    },
  },
  storage: { session: { get: async () => ({}), set: async () => {} }, local: { get: async () => ({}), set: async () => {} } },
  debugger: {
    attach: async () => {},
    detach: async () => {},
    sendCommand: async (_t: unknown, method: string, params: Record<string, any> = {}) => {
      cdp.push({ method, params });
      pageGets(method, params);
      if (method === 'Runtime.evaluate' && params.expression === 'innerWidth * innerHeight') return { result: { type: 'number', value: 1 } };
      return {};
    },
    onEvent: { addListener: () => {} },
    onDetach: { addListener: () => {} },
  },
};

const { PAGE_DOM_INSTALL, PAGE_DOM_VERSION } = await import('../extension/lib/page-dom.js');
const { handleClick, handleType } = await import('../extension/handlers/interaction.js');
const { fallbackByTab } = await import('../extension/lib/state.js');
const { detachCdp } = await import('../extension/lib/cdp-session.js');

let doc: FakeDocument;

/** A 1000x800 viewport whose hit test answers `hit()` (topmost first). */
function viewport(hit: () => FakeElement[]) {
  const g = globalThis as any;
  g.innerWidth = 1000;
  g.innerHeight = 800;
  Object.assign(doc.defaultView, { innerWidth: 1000, innerHeight: 800 });
  (doc as any).elementsFromPoint = hit;
}

/** `el` laid out at `top` (100x20 at left 10), read live, with a counter of scrollIntoView calls. */
function placed(el: FakeElement, box: { top: number }) {
  const spy = { scrolls: 0, onScroll: () => {} };
  el.getBoundingClientRect = () => ({ x: 10, y: box.top, left: 10, top: box.top, width: 100, height: 20, right: 110, bottom: box.top + 20 }) as any;
  el.scrollIntoView = () => { spy.scrolls += 1; spy.onScroll(); };
  return spy;
}

beforeEach(async () => {
  doc = installFakePage();
  fallbackByTab.clear();
  cdp.length = 0;
  afterPageRun = () => {};
  listeners = new Map();
  pressLandsOn = undefined;
  chromeDialog = false;
  rejectText = false;
  const g = globalThis as any;
  g.addEventListener = (type: string, fn: (e: unknown) => void) => { listeners.set(type, [...(listeners.get(type) ?? []), fn]); };
  g.removeEventListener = (type: string, fn: (e: unknown) => void) => { listeners.set(type, (listeners.get(type) ?? []).filter((f) => f !== fn)); };
  PAGE_DOM_INSTALL(PAGE_DOM_VERSION);
  await detachCdp(1);
});

afterEach(() => {
  const g = globalThis as any;
  delete g.addEventListener;
  delete g.removeEventListener;
  delete g.innerWidth;
  delete g.innerHeight;
});

describe('browser_type into a frame that does not have focus', () => {
  /** A same-origin iframe editor: its <body id="tinymce"> is the field, as on TinyMCE. */
  function editorFrame() {
    const frame = doc.el('iframe', { id: 'mce_0_ifr' });
    doc.body.append(frame);
    const inner = installFakeFrame(frame);
    inner.body.setAttribute('id', 'tinymce');
    inner.body.isContentEditable = true;
    return { frame, inner };
  }

  it('clicks the editor first: the frame\'s own activeElement (its body) is not focus', async () => {
    const { inner } = editorFrame();
    inner.activeElement = inner.body; // every document has one, focused or not
    const res = await handleType({ tabId: 1, target: '#tinymce', text: 'Hi' });
    expect(res.success).toBe(true);
    expect(mouse().map((c) => c.params.type)).toEqual(['mouseMoved', 'mousePressed', 'mouseReleased']);
    const order = inputs().map((c) => c.method);
    expect(order.indexOf('Input.dispatchMouseEvent')).toBeLessThan(order.indexOf('Input.insertText'));
  });

  it('sends no click when the frame has focus and its body is the active element', async () => {
    const { frame, inner } = editorFrame();
    doc.activeElement = frame;
    inner.activeElement = inner.body;
    const res = await handleType({ tabId: 1, target: '#tinymce', text: 'Hi' });
    expect(res.success).toBe(true);
    expect(mouse()).toEqual([]);
    expect(inputs().map((c) => c.method)).toEqual(['Input.insertText']);
  });
});

describe('a click aims where the target is when it is pressed', () => {
  it('a target in full view is not scrolled (a scroll runs the page\'s scroll handlers)', async () => {
    const menu = doc.el('a', { id: 'news', href: '#news' }, 'News');
    doc.body.append(menu);
    const spy = placed(menu, { top: 60 });
    viewport(() => [menu]);
    const res = await handleClick({ tabId: 1, target: '#news' });
    expect(res).toMatchObject({ success: true, at: { x: 60, y: 70 } });
    expect(spy.scrolls).toBe(0);
  });

  it('a target out of view is scrolled, then measured until it holds still', async () => {
    const menu = doc.el('a', { id: 'news', href: '#news' }, 'News');
    doc.body.append(menu);
    const box = { top: 2000 };
    const spy = placed(menu, box);
    viewport(() => [menu]);
    // The scroll lands it at 300; the page's scroll handler then animates it to 440 over two steps.
    const steps: number[] = [];
    spy.onScroll = () => { box.top = 300; steps.push(380, 440); };
    afterPageRun = () => { if (steps.length) box.top = steps.shift()!; };
    const res = await handleClick({ tabId: 1, target: '#news' });
    expect(spy.scrolls).toBe(1);
    expect(res).toMatchObject({ success: true, at: { x: 60, y: 450 } });
    expect(mouse().find((c) => c.params.type === 'mousePressed')?.params).toMatchObject({ x: 60, y: 450 });
  });

  it('a target in a running transition is measured until it holds still, with no scroll', async () => {
    const close = doc.el('p', { class: 'close' }, 'Close');
    const dialog = doc.el('div', { class: 'modal' }, close);
    doc.body.append(dialog);
    const box = { top: 300 };
    const spy = placed(close, box);
    viewport(() => [close]);
    // The dialog grows into place: its Close text moves down over two frames, then stops.
    (doc as any).getAnimations = () => (steps.length ? [{ playState: 'running', effect: { target: dialog } }] : []);
    const steps = [420, 470];
    afterPageRun = () => { if (steps.length) box.top = steps.shift()!; };
    const res = await handleClick({ tabId: 1, target: '.close' });
    expect(spy.scrolls).toBe(0);
    expect(res).toMatchObject({ success: true, at: { x: 60, y: 480 } });
    expect(mouse().find((c) => c.params.type === 'mousePressed')?.params).toMatchObject({ x: 60, y: 480 });
  });

  it('a press that lands on something else fails CLICK_MISSED and names what it hit', async () => {
    const menu = doc.el('a', { id: 'news', href: '#news' }, 'News');
    const para = doc.el('p', { class: 'lead' }, 'Lorem ipsum');
    doc.body.append(menu, para);
    placed(menu, { top: 60 });
    viewport(() => [menu]);
    pressLandsOn = para; // the menu moved away between the measurement and the press
    const res = await handleClick({ tabId: 1, target: '#news' });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/^CLICK_MISSED: the click at 60,70 landed on p\.lead "Lorem ipsum", not on #news/);
  });

  it('a press on the target, or on something inside it, is a plain success', async () => {
    const inner = doc.el('span', {}, 'News');
    const menu = doc.el('a', { id: 'news', href: '#news' }, inner);
    doc.body.append(menu);
    placed(menu, { top: 60 });
    viewport(() => [inner, menu]);
    pressLandsOn = inner;
    expect(await handleClick({ tabId: 1, target: '#news' })).toMatchObject({ success: true, text: 'clicked #news' });
    expect(watching()).toEqual([]); // the watch is removed once the click is over
  });
});

describe('browser_type focuses a control a click would change without clicking it', () => {
  it('a range input takes the arrow key with no click (a click at its centre moves it)', async () => {
    const slider = doc.el('input', { id: 'slider', type: 'range', value: '4.5' });
    doc.body.append(slider);
    const res = await handleType({ tabId: 1, target: '#slider', key: 'ArrowLeft' });
    expect(res.success).toBe(true);
    expect(mouse()).toEqual([]);
    expect(doc.activeElement).toBe(slider);
    expect(inputs().map((c) => [c.params.type, c.params.key])).toEqual([['rawKeyDown', 'ArrowLeft'], ['keyUp', 'ArrowLeft']]);
  });

  it('a checkbox takes Space with no click (a click would toggle it first)', async () => {
    const box = doc.el('input', { id: 'agree', type: 'checkbox' });
    doc.body.append(box);
    await handleType({ tabId: 1, target: '#agree', key: 'Space' });
    expect(mouse()).toEqual([]);
    expect(doc.activeElement).toBe(box);
  });

  it('a disabled field fails ELEMENT_DISABLED in typing words: nothing was typed', async () => {
    doc.body.append(doc.el('input', { id: 'off', type: 'text', 'aria-disabled': 'true' }));
    const res = await handleType({ tabId: 1, target: '#off', text: 'x' });
    expect(res).toEqual({ success: false, error: 'ELEMENT_DISABLED: input#off is disabled; nothing was typed.' });
    expect(inputs()).toEqual([]);
  });

  it('a text field is still focused by a click (it places the caret)', async () => {
    const field = doc.el('input', { id: 'q', type: 'text' });
    doc.body.append(field);
    await handleType({ tabId: 1, target: '#q', text: 'hello' });
    expect(mouse().map((c) => c.params.type)).toEqual(['mouseMoved', 'mousePressed', 'mouseReleased']);
  });
});

describe('input the page never gets: a Chrome dialog over the tab takes it (INPUT_BLOCKED)', () => {
  /** A 100x20 field at top 60, under the point. */
  function field(attrs: Record<string, string> = {}) {
    const el = doc.el('input', { id: 'code', type: 'text', ...attrs });
    el.value = '';
    doc.body.append(el);
    placed(el, { top: 60 });
    viewport(() => [el]);
    return el;
  }

  it('a click the page never gets fails INPUT_BLOCKED, not clicked', async () => {
    const btn = doc.el('button', { id: 'go' }, 'Go');
    doc.body.append(btn);
    placed(btn, { top: 60 });
    viewport(() => [btn]);
    chromeDialog = true;
    const res = await handleClick({ tabId: 1, target: '#go' });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/^INPUT_BLOCKED: the page got none of the click at 60,70 on #go\. A Chrome dialog over the tab \(a password-breach warning after a login, a permission prompt\)/);
    expect(watching()).toEqual([]);
  });

  it('typing whose focusing click the page never gets fails INPUT_BLOCKED', async () => {
    field();
    chromeDialog = true;
    const res = await handleType({ tabId: 1, target: '#code', text: '477086' });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/^INPUT_BLOCKED: the page got none of the click that focuses #code/);
  });

  it('keys the page never gets fail INPUT_BLOCKED', async () => {
    const el = field();
    doc.activeElement = el;
    chromeDialog = true;
    const res = await handleType({ tabId: 1, key: 'Tab' });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/^INPUT_BLOCKED: the page got none of the keys \(Tab\)/);
  });

  it('a hover the page never gets fails INPUT_BLOCKED; the tab draws frames while it moves', async () => {
    const avatar = doc.el('img', { id: 'avatar', alt: 'User Avatar' });
    doc.body.append(avatar);
    placed(avatar, { top: 60 });
    viewport(() => [avatar]);
    chromeDialog = true;
    const res = await handleClick({ tabId: 1, target: '#avatar', hover: true });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/^INPUT_BLOCKED: the page got none of the mouse move to 60,70 on #avatar/);
    const order = cdp.map((c) => c.method === 'Input.dispatchMouseEvent' ? c.params.type : c.method);
    expect(order.indexOf('Page.startScreencast')).toBeLessThan(order.indexOf('mouseMoved'));
    expect(order.indexOf('mouseMoved')).toBeLessThan(order.indexOf('Page.stopScreencast'));
  });

  it('a hover the page gets is hovered; a pointer already over the target (no move event) is hovered too', async () => {
    const avatar = doc.el('img', { id: 'avatar', alt: 'User Avatar' });
    doc.body.append(avatar);
    placed(avatar, { top: 60 });
    viewport(() => [avatar]);
    expect(await handleClick({ tabId: 1, target: '#avatar', hover: true })).toMatchObject({ success: true, text: 'hovered #avatar' });
    chromeDialog = true; // Chrome sends no mousemove for a pointer that does not move
    const own = avatar.matches.bind(avatar);
    (avatar as any).matches = (sel: string) => sel === ':hover' || own(sel);
    expect(await handleClick({ tabId: 1, target: '#avatar', hover: true })).toMatchObject({ success: true });
  });

  it('a press into a cross-origin frame is not judged: the top window never sees it', async () => {
    const frame = doc.el('iframe', { id: 'ad', src: 'https://ads.test/' });
    doc.body.append(frame);
    placed(frame, { top: 60 });
    viewport(() => [frame]);
    chromeDialog = true;
    expect(await handleClick({ tabId: 1, target: '60,70' })).toMatchObject({ success: true, text: 'clicked 60,70' });
  });
});

describe('typing that changes nothing is not typed', () => {
  it('a read-only field fails ELEMENT_READONLY and nothing is sent', async () => {
    const el = doc.el('input', { id: 'ro', type: 'text', readonly: '' });
    (el as any).readOnly = true;
    el.value = 'You cannot change me';
    doc.body.append(el);
    const res = await handleType({ tabId: 1, target: '#ro', text: 'abc' });
    expect(res).toEqual({ success: false, error: 'ELEMENT_READONLY: input#ro is read-only; nothing was typed.' });
    expect(inputs()).toEqual([]);
  });

  it('the focused field read-only, no target: ELEMENT_READONLY; a key alone still goes (it may move the caret)', async () => {
    const el = doc.el('input', { id: 'ro', type: 'text' });
    (el as any).readOnly = true;
    el.value = 'fixed';
    doc.body.append(el);
    doc.activeElement = el;
    expect(await handleType({ tabId: 1, text: 'x' })).toEqual({ success: false, error: 'ELEMENT_READONLY: the focused field input#ro is read-only; nothing was typed.' });
    expect(await handleType({ tabId: 1, key: 'End' })).toMatchObject({ success: true });
  });

  it('text the page refuses fails VALUE_NOT_SET: the value did not change', async () => {
    const el = doc.el('input', { id: 'q', type: 'text' });
    el.value = 'old';
    doc.body.append(el);
    rejectText = true;
    const res = await handleType({ tabId: 1, target: '#q', text: 'abc' });
    expect(res).toMatchObject({ success: false, error: 'VALUE_NOT_SET: typed 3 chars into #q, but its value did not change (kept "old")' });
  });

  it('a field already at its maxlength says so', async () => {
    const el = doc.el('input', { id: 'pin', type: 'password' });
    (el as any).maxLength = 4;
    el.value = '1234';
    doc.body.append(el);
    rejectText = true;
    const res = await handleType({ tabId: 1, target: '#pin', text: '5' });
    expect(res.error).toBe('VALUE_NOT_SET: typed 1 chars into #pin, but its value did not change (kept "••••"; the field is full: maxlength 4)');
  });

  it('clear then the same text it held is typed (the value is what was asked)', async () => {
    const el = doc.el('input', { id: 'q', type: 'text' });
    el.value = 'same';
    doc.body.append(el);
    (el as any).select = () => { el.value = ''; };
    expect(await handleType({ tabId: 1, target: '#q', text: 'same', clear: true })).toMatchObject({ success: true });
  });

  it('an empty password field reads value: "", not ••••', async () => {
    const el = doc.el('input', { id: 'pw', type: 'password' });
    el.value = '';
    doc.body.append(el);
    doc.activeElement = el;
    const res = await handleType({ tabId: 1, key: 'Tab' });
    expect(res.text).toContain('value: ""');
  });
});
