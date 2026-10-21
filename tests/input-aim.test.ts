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
/** Capture-phase mousedown listeners the page side added to the window. */
let pressListeners: Array<(e: unknown) => void> = [];
/** The element a trusted press lands on (null: the press is not seen by the page). */
let pressLandsOn: FakeElement | null = null;

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
      if (method === 'Input.dispatchMouseEvent' && params.type === 'mousePressed' && pressLandsOn) {
        const hit = pressLandsOn;
        for (const fn of [...pressListeners]) fn({ isTrusted: true, target: hit, composedPath: () => [hit] });
      }
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
  pressListeners = [];
  pressLandsOn = null;
  const g = globalThis as any;
  g.addEventListener = (type: string, fn: (e: unknown) => void) => { if (type === 'mousedown') pressListeners.push(fn); };
  g.removeEventListener = (type: string, fn: (e: unknown) => void) => { if (type === 'mousedown') pressListeners = pressListeners.filter((f) => f !== fn); };
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
    expect(pressListeners).toEqual([]); // the watch is removed once the click is over
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
