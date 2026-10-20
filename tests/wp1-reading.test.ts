import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installFakeFrame, installFakePage, type FakeDocument, type FakeElement } from './helpers/fake-dom.js';

// chrome mock: executeScript runs the page function in-process against the fake page.
(globalThis as any).chrome = {
  tabs: { get: async (id: number) => ({ id, url: 'https://example.test/page', windowId: 1 }), query: async () => [], onRemoved: { addListener: () => {} } },
  scripting: { executeScript: async (o: { func: (...a: any[]) => unknown; args?: unknown[] }) => [{ result: await o.func(...(o.args ?? [])) }] },
  storage: { session: { get: async () => ({}), set: async () => {} }, local: { get: async () => ({}), set: async () => {} } },
  debugger: { attach: async () => { throw new Error('no debugger in tests'); }, detach: async () => {}, sendCommand: async () => ({}), onDetach: { addListener: () => {} } },
};

const { PAGE_DOM_INSTALL, PAGE_DOM_VERSION } = await import('../extension/lib/page-dom.js');
const { handleGetPageText, handleScroll, handleWait } = await import('../extension/handlers/inspection.js');
const { fallbackByTab } = await import('../extension/lib/state.js');

let doc: FakeDocument;

function install() {
  doc = installFakePage();
  fallbackByTab.clear();
  PAGE_DOM_INSTALL(PAGE_DOM_VERSION);
}

describe('browser_text: hidden matches, frames, article mode', () => {
  beforeEach(install);

  it('a selector that matches only hidden elements is an ELEMENT_HIDDEN error, not their text', async () => {
    const hidden = doc.el('div', { class: 'toast' }, 'Secret draft');
    hidden.hidden = true;
    doc.body.append(hidden);
    const res = await handleGetPageText({ tabId: 1, selector: '.toast' });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/^ELEMENT_HIDDEN/);
    expect(JSON.stringify(res)).not.toContain('Secret draft');
  });

  it('same-origin iframe text is included on the fast path too', async () => {
    const frame = doc.el('iframe', {});
    doc.body.append(doc.el('p', {}, 'Top text'), frame);
    const inner = installFakeFrame(frame);
    inner.body.append(inner.el('p', {}, 'Inside frame'));
    const res = await handleGetPageText({ tabId: 1 });
    expect(res.text).toContain('Top text');
    expect(res.text).toContain('Inside frame');
  });

  it('article mode falls back to the full text when its heuristic keeps only a small share', async () => {
    const long = 'Real paragraph of the article body that a class-name guess would wrongly drop. '.repeat(8);
    doc.body.append(doc.el('main', {},
      doc.el('p', {}, 'Intro'),
      doc.el('div', { class: 'related-posts' }, doc.el('p', {}, long)),
    ));
    const res = await handleGetPageText({ tabId: 1, mode: 'article', maxLength: 100000 });
    expect(res.text).toContain('Real paragraph');
    expect(res.mode).toBeUndefined();
    expect(res.note).toMatch(/article/);
  });
});

describe('browser_wait: frames, bounds, honest durations', () => {
  beforeEach(install);
  afterEach(() => { vi.useRealTimers(); });

  it('a text wait sees same-origin iframe text', async () => {
    const frame = doc.el('iframe', {});
    doc.body.append(frame);
    const inner = installFakeFrame(frame);
    inner.body.append(inner.el('p', {}, 'Payment received'));
    expect((await handleWait({ tabId: 1, text: 'payment RECEIVED', timeout: 500 })).success).toBe(true);
  });

  it('a timeout above the transport limit is clamped and says so', async () => {
    doc.body.append(doc.el('p', {}, 'Ready'));
    const res = await handleWait({ tabId: 1, text: 'Ready', timeout: 120000 });
    expect(res.success).toBe(true);
    expect(res.note).toMatch(/50000/);
  });

  it('delay reports the time actually waited, and a note when it was capped', async () => {
    vi.useFakeTimers();
    const pending = handleWait({ tabId: 1, delay: 45000 });
    await vi.advanceTimersByTimeAsync(31000);
    const res = await pending;
    expect(res.waited).toBe(30000);
    expect(res.note).toMatch(/30000/);
  });
});

describe('browser_scroll: app shells and honest results', () => {
  beforeEach(() => {
    install();
    // Document is not scrollable: the app shell's inner container is.
    (doc.documentElement as any).clientHeight = 800;
    (doc.documentElement as any).scrollHeight = 800;
    const g = globalThis as any;
    g.scrollY = 0;
    g.scrollX = 0;
    g.scrollBy = () => {};
    g.scrollTo = () => {};
  });

  function feed() {
    const app = doc.el('div', { id: 'app', style: 'overflow:auto' }, doc.el('p', {}, 'Feed item'));
    (app as any).clientHeight = 600;
    (app as any).clientWidth = 400;
    (app as any).scrollHeight = 5000;
    (app as any).scrollWidth = 400;
    (app as any).scrollTop = 0;
    (app as any).scrollBy = (o: { top?: number }) => { (app as any).scrollTop += o.top ?? 0; };
    doc.body.append(app);
    doc.defaultView.getComputedStyle = (el: FakeElement) => ({
      display: 'block', visibility: 'visible', opacity: '1', whiteSpace: 'normal',
      overflowY: el.attrs.get('style')?.includes('overflow:auto') ? 'auto' : 'visible', overflowX: 'visible',
    }) as any;
    return app as any;
  }

  it('scrolls the inner container when the page cannot scroll, and reports the real position', async () => {
    const app = feed();
    const res = await handleScroll({ tabId: 1, direction: 'down', amount: 500 });
    expect(res.success).toBe(true);
    expect(res.moved).toBe(true);
    expect(app.scrollTop).toBe(500);
    expect(res.position).toEqual({ x: 0, y: 500 });
  });

  it('nothing could move: an honest NOT_SCROLLABLE error, not success', async () => {
    doc.body.append(doc.el('p', {}, 'Short page'));
    const res = await handleScroll({ tabId: 1, direction: 'down', amount: 500 });
    expect(res.success).toBe(false);
    expect(res.moved).toBe(false);
    expect(res.error).toMatch(/^NOT_SCROLLABLE/);
  });
});
