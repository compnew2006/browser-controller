import { beforeEach, describe, expect, it } from 'vitest';
import { installFakePage, type FakeDocument } from './helpers/fake-dom.js';

/**
 * Refs are per document, but a tab outlives its documents: the page counter of a new
 * document must start above every ref the tab's earlier documents showed, or a stale
 * ref from the previous page would hit a different element here (X2). The service worker
 * keeps the tab's high-water mark (lib/state.js refHighWaterByTab) and passes it to the
 * page runtime install. Real execDom + handleSnapshot run against the fake pages.
 */
const TAB = 7;
const installs: unknown[][] = [];
const session: Record<string, unknown> = {};

(globalThis as any).chrome = {
  tabs: {
    get: async (id: number) => ({ id, url: 'https://example.test/page', windowId: 1 }),
    query: async () => [],
    onRemoved: { addListener: () => {} },
    onUpdated: { addListener: () => {} },
  },
  windows: { get: async () => ({ width: 1280, height: 900 }) },
  // The page function runs in-process against the fake page; the runtime install is recorded.
  scripting: {
    executeScript: async (o: { func: { name: string } & ((...a: any[]) => unknown); args?: unknown[] }) => {
      if (o.func.name === 'PAGE_DOM_INSTALL') installs.push(o.args ?? []);
      return [{ result: await o.func(...(o.args ?? [])) }];
    },
  },
  storage: {
    session: {
      get: async () => ({ ...session }),
      set: async (values: Record<string, unknown>) => { Object.assign(session, values); },
    },
    local: { get: async () => ({}), set: async () => {} },
  },
  debugger: {
    attach: async () => {},
    detach: async () => {},
    sendCommand: async () => ({}),
    onEvent: { addListener: () => {} },
    onDetach: { addListener: () => {} },
  },
  action: { setBadgeBackgroundColor: () => {}, setBadgeText: () => {} },
  runtime: { sendMessage: async () => {}, onMessage: { addListener: () => {} } },
  alarms: { create: () => {}, onAlarm: { addListener: () => {} } },
  webRequest: { onCompleted: { addListener: () => {} } },
};

const { PAGE_DOM_VERSION } = await import('../extension/lib/page-dom.js');
const { handleSnapshot, handleGetPageText, handleScroll } = await import('../extension/handlers/inspection.js');
const { refErrorMessage } = await import('../extension/lib/ref-errors.js');
const { dropDocumentState, dropTabState, refHighWaterByTab, loadSessionState } = await import('../extension/lib/state.js');
const { fallbackByTab } = await import('../extension/lib/state.js');

let doc: FakeDocument;

beforeEach(() => {
  dropTabState(TAB);
  fallbackByTab.clear();
  refHighWaterByTab.clear();
  installs.length = 0;
  for (const key of Object.keys(session)) delete session[key];
});

describe('refs never collide across the documents of one tab', () => {
  it('a ref from the previous page is REF_GONE; the new page issues numbers above it', async () => {
    doc = installFakePage('https://example.test/cart');
    doc.body.append(doc.el('button', { id: 'checkout' }, 'Checkout'));
    const cart = await handleSnapshot({ tabId: TAB });
    const oldRef = cart.refs[0].ref;
    expect(oldRef).toBe('e1');

    // Navigating: the tab's loading event drops the document-bound state, then the new document loads.
    dropDocumentState(TAB);
    doc = installFakePage('https://example.test/search');
    doc.body.append(doc.el('button', { id: 'search' }, 'Search'));
    const search = await handleSnapshot({ tabId: TAB });
    const newRef = search.refs[0].ref;
    expect(newRef).toBe('e2');
    expect(installs.at(-1)).toEqual([PAGE_DOM_VERSION, 1]);

    const stale = await handleSnapshot({ tabId: TAB, target: oldRef });
    expect(stale.success).toBe(false);
    expect(stale.error).toMatch(/^REF_GONE: ref e1 is from an earlier page/);
    expect((await handleSnapshot({ tabId: TAB, target: newRef })).success).toBe(true);
  });

  it('text and scroll give an earlier document\'s ref the same REF_GONE wording', async () => {
    doc = installFakePage('https://example.test/cart');
    doc.body.append(doc.el('button', { id: 'checkout' }, 'Checkout'));
    const oldRef = (await handleSnapshot({ tabId: TAB })).refs[0].ref;
    dropDocumentState(TAB);
    doc = installFakePage('https://example.test/search');
    doc.body.append(doc.el('button', { id: 'search' }, 'Search'));
    await handleSnapshot({ tabId: TAB });

    const text = await handleGetPageText({ tabId: TAB, target: oldRef });
    expect(text.error).toMatch(/^REF_GONE: ref e1 is from an earlier page/);
    const scroll = await handleScroll({ tabId: TAB, target: oldRef });
    expect(scroll.error).toMatch(/^REF_GONE: ref e1 is from an earlier page/);
  });

  it('the wording tells an earlier page apart from an element that left this one', () => {
    expect(refErrorMessage('e1', true, true)).toMatch(/^REF_GONE: ref e1 is from an earlier page/);
    expect(refErrorMessage('e2', true)).toMatch(/^REF_GONE: ref e2 is no longer on the page/);
    expect(refErrorMessage('e9', false)).toMatch(/^REF_NOT_FOUND: ref e9 /);
  });

  it('refs shown in an AMBIGUOUS reply count too: the next document starts above them', async () => {
    doc = installFakePage('https://example.test/a');
    doc.body.append(doc.el('button', {}, 'Save'), doc.el('button', {}, 'Save'));
    const ambiguous = await handleGetPageText({ tabId: TAB, target: 'text=Save' });
    expect(ambiguous.error).toMatch(/^AMBIGUOUS: text=Save matches 2 elements: e1 "Save", e2 "Save"/);

    dropDocumentState(TAB);
    doc = installFakePage('https://example.test/b');
    doc.body.append(doc.el('button', { id: 'other' }, 'Other'));
    expect((await handleSnapshot({ tabId: TAB })).refs[0].ref).toBe('e3');
  });

  it('a closed tab forgets its refs: a tab that starts again counts from e1', async () => {
    doc = installFakePage();
    doc.body.append(doc.el('button', {}, 'Go'));
    expect((await handleSnapshot({ tabId: TAB })).refs[0].ref).toBe('e1');

    dropTabState(TAB);
    expect(refHighWaterByTab.has(TAB)).toBe(false);
    doc = installFakePage();
    doc.body.append(doc.el('button', {}, 'Go'));
    expect((await handleSnapshot({ tabId: TAB })).refs[0].ref).toBe('e1');
    expect(installs.at(-1)).toEqual([PAGE_DOM_VERSION, 0]);
  });

  it('the high-water mark survives a service-worker recycle (chrome.storage.session)', async () => {
    // Persists are deferred until the worker has loaded its state once (lib/state.js X3 gate).
    await loadSessionState();
    doc = installFakePage();
    doc.body.append(doc.el('button', {}, 'Go'), doc.el('button', {}, 'Stop'));
    await handleSnapshot({ tabId: TAB });
    expect(session.bcSessionState).toMatchObject({ refHighWater: { [TAB]: 2 } });

    refHighWaterByTab.clear(); // the worker restarted: its memory is gone
    await loadSessionState();
    dropDocumentState(TAB);
    doc = installFakePage();
    doc.body.append(doc.el('button', {}, 'Go'));
    expect((await handleSnapshot({ tabId: TAB })).refs[0].ref).toBe('e3');
  });
});
