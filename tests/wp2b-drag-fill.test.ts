import { beforeEach, describe, expect, it } from 'vitest';
import { installFakePage, type FakeDocument, type FakeElement } from './helpers/fake-dom.js';

// browser_drag (WP2b, rewritten for 3.0): both points are measured after the last
// scroll. The fake page has a scroll position; scrolling an element into view centres
// it, and every element's box moves with that position. The viewport is 1000×700.
// browser_fill_form's submit cases were removed with 3.0: fill never submits (see v3-input.test.ts).

const cdp: Array<{ method: string; params: Record<string, any> }> = [];
let scrollY = 0;
let doc: FakeDocument;

(globalThis as any).chrome = {
  tabs: { get: async (id: number) => ({ id, url: 'https://example.test/', windowId: 1 }), query: async () => [], onRemoved: { addListener: () => {} } },
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
const inputs = () => cdp.filter((c) => c.method.startsWith('Input.'));

/** A 100×40 box whose top is `docTop` px down the page, at the current scroll position. */
function boxAt(id: string, docTop: number): FakeElement {
  const el = doc.el('div', { id }, id);
  (el as any).getBoundingClientRect = () => ({ x: 10, y: docTop - scrollY, left: 10, top: docTop - scrollY, width: 100, height: 40, right: 110, bottom: docTop - scrollY + 40 });
  // scrollIntoView(center) puts the element's middle in the middle of the viewport.
  (el as any).scrollIntoView = () => { scrollY = docTop + 20 - 350; };
  doc.body.append(el);
  return el;
}
const inView = (el: FakeElement) => { const r = (el as any).getBoundingClientRect(); return r.top >= 0 && r.bottom <= 700; };

beforeEach(() => {
  cdp.length = 0;
  scrollY = 0;
  doc = installFakePage();
  (globalThis as any).innerWidth = 1000;
  (globalThis as any).innerHeight = 700;
  fallbackByTab.clear();
  PAGE_DOM_INSTALL(PAGE_DOM_VERSION);
  // A point on an element is that element (no cover), wherever the scroll position puts it.
  (doc as any).elementsFromPoint = (x: number, y: number) => doc.body.children.filter((el) => {
    const r = (el as any).getBoundingClientRect();
    return x >= r.left && x <= r.left + r.width && y >= r.top && y <= r.top + r.height;
  });
});

describe('browser_click dragTo: the start point is measured after the last scroll', () => {
  it('fails with TARGET_OFFSCREEN and presses nothing when the drop target cannot share the viewport with the source', async () => {
    // Source near the top, target 2000 px down: revealing either one moves the other out of view.
    boxAt('src', 100);
    boxAt('dst', 2000);
    const result = await handleClick({ tabId: 5, target: '#src', dragTo: '#dst' });
    expect(result).toMatchObject({ success: false, error: expect.stringMatching(/^TARGET_OFFSCREEN: /) });
    expect(inputs().filter((c) => c.params.type === 'mousePressed')).toEqual([]);
  });

  it('drags between two points that are in view after the scroll, at the coordinates measured then', async () => {
    const src = boxAt('src', 1000);
    const dst = boxAt('dst', 1100);
    const result = await handleClick({ tabId: 5, target: '#src', dragTo: '#dst' });
    expect(result).toMatchObject({ success: true, from: { x: 60, y: 350 }, to: { x: 60, y: 450 } });
    expect(inView(src) && inView(dst)).toBe(true);
    expect(inputs().find((c) => c.params.type === 'mousePressed')?.params).toMatchObject({ x: 60, y: 350 });
    expect(inputs().find((c) => c.params.type === 'mouseReleased')?.params).toMatchObject({ x: 60, y: 450 });
  });
});
