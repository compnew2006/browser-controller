import { beforeEach, describe, expect, it } from 'vitest';
import { installFakePage, type FakeDocument, type FakeElement } from './helpers/fake-dom.js';

/**
 * A ref whose element was re-rendered is re-found by its snapshot descriptor (page-dom
 * byFallback). The snapshot names roles the way the page's accessibility roles do (roleOf:
 * link, textbox, combobox, button), while the descriptor generator records the tag-based role
 * (smart-selector: `role` attribute or tag name). Each kind of control must re-bind, from
 * descriptors the generator made and from descriptors that name the snapshot's role.
 */
const sent: unknown[] = [];
(globalThis as any).chrome = {
  tabs: {
    get: async (id: number) => ({ id, url: 'https://example.test/page', windowId: 1 }),
    query: async () => [],
    onRemoved: { addListener: () => {} },
    onUpdated: { addListener: () => {} },
  },
  windows: { get: async () => ({ width: 1280, height: 900 }) },
  scripting: {
    executeScript: async (o: { func: (...a: any[]) => unknown; args?: unknown[] }) => {
      sent.push(o.func.name);
      return [{ result: await o.func(...(o.args ?? [])) }];
    },
  },
  storage: {
    session: { get: async () => ({}), set: async () => {} },
    local: { get: async () => ({}), set: async () => {} },
  },
  debugger: { attach: async () => {}, detach: async () => {}, sendCommand: async () => ({}), onEvent: { addListener: () => {} }, onDetach: { addListener: () => {} } },
  action: { setBadgeBackgroundColor: () => {}, setBadgeText: () => {} },
  runtime: { sendMessage: async () => {}, onMessage: { addListener: () => {} } },
  alarms: { create: () => {}, onAlarm: { addListener: () => {} } },
  webRequest: { onCompleted: { addListener: () => {} } },
};

const { PAGE_DOM_INSTALL, PAGE_DOM_VERSION } = await import('../extension/lib/page-dom.js');
const { handleSnapshot } = await import('../extension/handlers/inspection.js');
const { parseTarget } = await import('../extension/lib/target.js');
const { fallbackByTab } = await import('../extension/lib/state.js');

const D = () => (globalThis as any).__bcDom;

/** One control of each kind the snapshot names: its tag, attributes, text, and the role the snapshot prints. */
const CONTROLS = [
  { tag: 'a', attrs: { href: '/docs' }, text: 'Docs', role: 'link', selector: 'a[href="/docs"]' },
  { tag: 'input', attrs: { id: 'q', type: 'text', placeholder: 'Search' }, text: '', role: 'textbox', selector: 'input#q' },
  { tag: 'textarea', attrs: { id: 'notes' }, text: '', role: 'textbox', selector: 'textarea#notes' },
  { tag: 'select', attrs: { id: 'pick' }, text: '', role: 'combobox', selector: 'select#pick' },
  { tag: 'button', attrs: { id: 'go' }, text: 'Go', role: 'button', selector: 'button#go' },
];

let doc: FakeDocument;

beforeEach(() => {
  fallbackByTab.clear();
  doc = installFakePage('https://example.test/rebind');
  // The generator walks the document for the nth count: give the fake page a walker over its nodes.
  (doc as any).createTreeWalker = () => {
    const nodes = doc.body.selfAndDescendants();
    let i = 0;
    return { nextNode: () => (i < nodes.length ? nodes[i++] : null) };
  };
  (globalThis as any).NodeFilter ??= { SHOW_ELEMENT: 1 };
  PAGE_DOM_INSTALL(PAGE_DOM_VERSION);
  for (const c of CONTROLS) doc.body.append(doc.el(c.tag, c.attrs, ...(c.text ? [c.text] : [])));
});

/** Replace an element with an equal one (a re-render): the old node leaves the document. */
function rerender(old: FakeElement, spec: (typeof CONTROLS)[number]): FakeElement {
  const fresh = doc.el(spec.tag, spec.attrs, ...(spec.text ? [spec.text] : []));
  old.isConnected = false;
  doc.body.childNodes.splice(doc.body.childNodes.indexOf(old), 1, fresh);
  fresh.parentNode = doc.body;
  fresh.parentElement = doc.body;
  return fresh;
}

describe('a re-rendered ref is re-found, for every kind of control', () => {
  it('descriptors the page generated at snapshot time re-bind each control', async () => {
    const snap = await handleSnapshot({ tabId: 1 });
    // The snapshot names each control with its accessibility role.
    expect(snap.refs.map((r: any) => r.role)).toEqual(CONTROLS.map((c) => c.role));
    const refs: string[] = snap.refs.map((r: any) => r.ref);
    const descriptors = fallbackByTab.get(1);
    expect(descriptors?.size).toBe(CONTROLS.length);

    const failures: string[] = [];
    CONTROLS.forEach((spec, i) => {
      const ref = refs[i];
      const old = D().registry.get(ref) as FakeElement;
      const fresh = rerender(old, spec);
      const hit = D().resolveTarget(parseTarget(ref), descriptors!.get(ref));
      if (hit.el !== fresh || hit.via !== 'fallback') failures.push(`${spec.tag} ${ref}: ${hit.error ?? `via ${hit.via}`}`);
    });
    expect(failures).toEqual([]);
  });

  it('descriptors that name the snapshot role (link, textbox, combobox) re-bind their controls too', () => {
    const failures: string[] = [];
    CONTROLS.forEach((spec, i) => {
      const old = doc.body.childNodes.find((n) => (n as FakeElement).tagName === spec.tag.toUpperCase()) as FakeElement;
      const fresh = rerender(old, spec);
      // A ref per control: the registry keeps what a ref resolved to.
      const hit = D().resolveTarget(parseTarget(`e${90 + i}`), { robustSelector: spec.selector, tag: spec.tag.toUpperCase(), role: spec.role, nth: 0 });
      if (hit.el !== fresh) failures.push(`${spec.tag} (${spec.role}): ${hit.error ?? 'not found'}`);
    });
    expect(failures).toEqual([]);
  });
});
