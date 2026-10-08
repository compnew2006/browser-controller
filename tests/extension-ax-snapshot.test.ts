import { beforeEach, describe, expect, it } from 'vitest';
import { installFakePage, installFakeFrame, FakeElement, type FakeDocument } from './helpers/fake-dom.js';

/**
 * browser_snapshot source:"native" end to end, minus Chrome: the real handler
 * runs against the fake page while chrome.debugger answers the handful of CDP
 * commands it issues. The Runtime.callFunctionOn mock evaluates the function
 * source the handler sends (exactly what Chrome would run in the main world)
 * and enforces Chrome's rule that one call cannot mix JS contexts.
 */

type Cdp = { method: string; params: Record<string, any> };
const cdp: Cdp[] = [];
let tabUrl = 'https://example.test/page';
let attachError: string | null = null;
/** backendNodeIds whose DOM.resolveNode fails (node already gone). */
const unresolvable = new Set<number>();
/** Runs inside callFunctionOn, after the paths were computed (simulates the page changing mid-snapshot). */
let afterPaths: (() => void) | null = null;

const ids = new Map<unknown, number>();
const byId = new Map<number, FakeElement>();
let nextId = 10;
const idOf = (el: FakeElement) => {
  if (!ids.has(el)) { ids.set(el, nextId); byId.set(nextId, el); nextId++; }
  return ids.get(el)!;
};

let mainAx: any[] = [];
let childAx: any[] = [];
let iframeEl: FakeElement;
let doc: FakeDocument;

function cdpNode(node: FakeElement): any {
  const out: any = { nodeType: 1, nodeName: node.tagName, backendNodeId: idOf(node), children: node.children.map(cdpNode) };
  if (node.shadowRoot) {
    out.shadowRoots = [{ nodeType: 11, nodeName: '#document-fragment', shadowRootType: 'closed', backendNodeId: nextId++, children: node.shadowRoot.children.map(cdpNode) }];
  }
  const inner = (node as unknown as { contentDocument?: FakeDocument }).contentDocument;
  if (inner) out.contentDocument = { nodeType: 9, nodeName: '#document', backendNodeId: nextId++, children: [cdpNode(inner.documentElement)] };
  return out;
}

(globalThis as any).chrome = {
  tabs: {
    get: async (id: number) => ({ id, url: id === 99 ? 'chrome://version/' : tabUrl, title: 'Fixture', windowId: 1 }),
    query: async () => [],
    onRemoved: { addListener: () => {} },
  },
  scripting: { executeScript: async (o: { func: (...a: any[]) => unknown; args?: unknown[] }) => [{ result: await o.func(...(o.args ?? [])) }] },
  storage: { session: { get: async () => ({}), set: async () => {} }, local: { get: async () => ({}), set: async () => {} } },
  windows: { get: async () => ({ width: 1200, height: 900 }) },
  debugger: {
    attach: async () => { if (attachError) throw new Error(attachError); },
    detach: async () => {},
    onDetach: { addListener: () => {} },
    sendCommand: async (_t: unknown, method: string, params: Record<string, any> = {}) => {
      cdp.push({ method, params });
      switch (method) {
        case 'Page.getFrameTree':
          return { frameTree: { frame: { id: 'main', url: tabUrl }, childFrames: childAx.length ? [{ frame: { id: 'child', url: 'about:srcdoc' } }] : [] } };
        case 'Accessibility.getFullAXTree':
          return { nodes: params.frameId === 'child' ? childAx : mainAx };
        case 'DOM.getFrameOwner':
          return { backendNodeId: idOf(iframeEl) };
        case 'DOM.resolveNode':
          if (unresolvable.has(params.backendNodeId) || !byId.has(params.backendNodeId)) throw new Error('No node with given id found');
          return { object: { objectId: `obj-${params.backendNodeId}` } };
        case 'DOM.getDocument':
          return { root: { nodeType: 9, nodeName: '#document', backendNodeId: 1, children: [cdpNode(doc.documentElement)] } };
        case 'Runtime.callFunctionOn': {
          const elOf = (objectId: string) => byId.get(Number(objectId.slice(4)))!;
          const els = (params.arguments as Array<{ objectId: string }>).map((a) => elOf(a.objectId));
          const worlds = new Set([elOf(params.objectId), ...els].map((e) => e.ownerDocument));
          if (worlds.size > 1) throw new Error('Argument should belong to the same JavaScript world as target object');
          const fn = new Function(`return (${params.functionDeclaration})`)();
          const value = fn(...els);
          if (afterPaths) { afterPaths(); afterPaths = null; }
          return { result: { value } };
        }
        case 'Runtime.evaluate':
          return { result: { value: 1000 } };
        default:
          return {};
      }
    },
  },
};

const { PAGE_DOM_INSTALL, PAGE_DOM_VERSION } = await import('../extension/lib/page-dom.js');
const { handleSnapshot } = await import('../extension/handlers/inspection.js');
const { handleClick } = await import('../extension/handlers/interaction.js');
const { detachCdp } = await import('../extension/lib/cdp-session.js');
const { fallbackByTab, lastNativeFingerprints } = await import('../extension/lib/state.js');

const D = () => (globalThis as any).__bcDom;

/** Nested AX spec bound to fake elements: { role, name, el, kids }. */
type Spec = { role: string; name?: string; el?: FakeElement; ignored?: boolean; props?: Record<string, unknown>; kids?: Spec[] };
function axNodes(root: Spec): any[] {
  const nodes: any[] = [];
  let n = 0;
  const visit = (spec: Spec, parentId?: string): string => {
    const nodeId = String(++n);
    const node: any = {
      nodeId, ignored: !!spec.ignored, childIds: [],
      role: { value: spec.role }, name: { value: spec.name ?? '' },
      ...(spec.el ? { backendDOMNodeId: idOf(spec.el) } : {}),
      ...(parentId ? { parentId } : {}),
      properties: Object.entries(spec.props ?? {}).map(([name, value]) => ({ name, value: { value } })),
    };
    nodes.push(node);
    for (const kid of spec.kids ?? []) node.childIds.push(visit(kid, nodeId));
    return nodeId;
  };
  visit(root);
  return nodes;
}

const flat = (tree: any): any[] => {
  const out: any[] = [];
  const visit = (x: any) => { if (!x) return; if (Array.isArray(x)) { x.forEach(visit); return; } out.push(x); visit(x.children); };
  visit(tree);
  return out;
};
const named = (tree: any, name: string) => flat(tree).find((n) => n.name === name);

let nav: FakeElement, link: FakeElement, save: FakeElement, dupA: FakeElement, dupB: FakeElement;
let host: FakeElement, deep: FakeElement, inFrame: FakeElement;

beforeEach(() => {
  cdp.length = 0;
  attachError = null;
  tabUrl = 'https://example.test/page';
  unresolvable.clear();
  afterPaths = null;
  ids.clear(); byId.clear(); nextId = 10;
  fallbackByTab.clear();
  lastNativeFingerprints.clear();

  doc = installFakePage();
  PAGE_DOM_INSTALL(PAGE_DOM_VERSION);
  link = doc.el('a', { href: '/docs' }, 'Docs');
  (link as any).href = 'https://example.test/docs';
  nav = doc.el('nav', { 'aria-label': 'Main' }, link);
  save = doc.el('button', { id: 'save' }, 'Save');
  dupA = doc.el('button', {}, 'Dup');
  dupB = doc.el('button', {}, 'Dup');
  host = doc.el('x-host');
  deep = doc.el('button', { class: 'deep' }, 'Deep');
  host.attachShadow().append(doc.el('section', {}, deep));
  iframeEl = doc.el('iframe');
  const inner = installFakeFrame(iframeEl);
  inFrame = inner.el('button', {}, 'In frame');
  inner.body.append(inFrame);
  const main = doc.el('main', {}, doc.el('h1', {}, 'Title'), save, dupA, dupB, host, iframeEl);
  doc.body.append(nav, main);

  mainAx = axNodes({
    role: 'RootWebArea', name: 'Fixture', el: doc.documentElement, kids: [
      { role: 'navigation', name: 'Main', el: nav, kids: [{ role: 'link', name: 'Docs', el: link }] },
      { role: 'main', el: main, kids: [
        { role: 'heading', name: 'Title', el: main.children[0], props: { level: 1 } },
        { role: 'button', name: 'Save', el: save },
        { role: 'button', name: 'Dup', el: dupA },
        { role: 'button', name: 'Dup', el: dupB },
        { role: 'button', name: 'Deep', el: deep },
        { role: 'Iframe', el: iframeEl },
      ] },
    ],
  });
  childAx = axNodes({ role: 'RootWebArea', name: 'Frame', el: inner.documentElement, kids: [{ role: 'button', name: 'In frame', el: inFrame }] });
});

async function native(extra: Record<string, unknown> = {}) {
  await detachCdp(7); // fresh session per test
  return handleSnapshot({ tabId: 7, source: 'native', ...extra }) as Promise<any>;
}

describe('browser_snapshot source:"native"', () => {
  it('returns Chrome\'s tree and binds every ref to the live element', async () => {
    const res = await native();
    expect(res).toMatchObject({ success: true, source: 'native', compact: true, url: 'https://example.test/page', title: 'Fixture' });
    expect(res.nativeUnavailable).toBeUndefined();
    expect(flat(res.tree).map((n) => `${n.role}:${n.name ?? ''}`)).toEqual([
      'navigation:Main', 'link:Docs', 'main:', 'heading:Title', 'button:Save', 'button:Dup', 'button:Dup', 'button:Deep', 'button:In frame',
    ]);
    const registry = D().registry as Map<string, unknown>;
    expect(registry.get(named(res.tree, 'Save').ref)).toBe(save);
    expect(registry.get(named(res.tree, 'Deep').ref)).toBe(deep); // inside a closed shadow root
    expect(registry.get(named(res.tree, 'In frame').ref)).toBe(inFrame); // inside an iframe
    expect(named(res.tree, 'Docs').href).toBe('/docs'); // same-origin links are path-only
    expect(named(res.tree, 'Title').level).toBe(1);
  });

  it('batches the CDP bridge per frame (Chrome rejects mixing JS contexts)', async () => {
    const res = await native();
    expect(res.success).toBe(true);
    const calls = cdp.filter((c) => c.method === 'Runtime.callFunctionOn');
    expect(calls).toHaveLength(2); // top frame, then the iframe
    expect(cdp.some((c) => c.method === 'Runtime.releaseObjectGroup')).toBe(true);
  });

  it('keeps same-named siblings apart: acting on a ref hits that element, not the first match', async () => {
    const res = await native();
    const [first, second] = flat(res.tree).filter((n) => n.name === 'Dup');
    expect(first.ref).not.toBe(second.ref);
    await handleClick({ tabId: 7, ref: second.ref, trusted: false });
    expect(dupB.events).toContain('click');
    expect(dupA.events).not.toContain('click');
  });

  it('records a smart-selector fallback for every bound ref (stale-ref recovery works for native refs)', async () => {
    // The real generator needs tree walkers the fake DOM lacks: stub it (the installer is idempotent).
    (globalThis as any).__browserControllerFallbackRuntime = {
      generateFallback: (el: FakeElement) => ({ tag: el.tagName, text: el.textContent }),
    };
    const res = await native();
    const map = fallbackByTab.get(7)!;
    expect(map.get(named(res.tree, 'Save').ref)).toEqual({ tag: 'BUTTON', text: 'Save' });
    expect(map.get(named(res.tree, 'In frame').ref)).toEqual({ tag: 'BUTTON', text: 'In frame' });
    // A scoped snapshot adds to the map instead of replacing it.
    const before = map.size;
    await native({ selector: 'nav' });
    expect(fallbackByTab.get(7)!.size).toBeGreaterThan(before);
  });

  it('scopes by selector, including a selector that only matches inside a shadow root', async () => {
    const navOnly = await native({ selector: 'nav' });
    expect(flat(navOnly.tree).map((n) => n.name)).toEqual(['Main', 'Docs']);
    const deepOnly = await native({ selector: 'button.deep' });
    expect(deepOnly.tree).toMatchObject({ role: 'button', name: 'Deep' });
    expect((D().registry as Map<string, unknown>).get(deepOnly.tree.ref)).toBe(deep);
  });

  it('scopes by the ref of an earlier snapshot', async () => {
    const full = await native();
    const scoped = await native({ ref: named(full.tree, 'Main').ref });
    expect(flat(scoped.tree).map((n) => n.name)).toEqual(['Main', 'Docs']);
  });

  it('reports a bad selector, a missing root and a stale ref without touching CDP results', async () => {
    expect(await native({ selector: '###' })).toMatchObject({ success: false, error: expect.stringContaining('Invalid CSS selector') });
    expect(await native({ selector: '.nope' })).toMatchObject({ success: false, error: 'Root element not found' });
    expect(await native({ ref: 'gone-ref' })).toMatchObject({ success: false, error: expect.stringContaining('ref gone-ref is gone') });
  });

  it('flags only elements that appeared since the previous native snapshot', async () => {
    await native();
    const added = doc.el('button', {}, 'Added');
    doc.body.append(added);
    mainAx = axNodes({ role: 'RootWebArea', name: 'Fixture', el: doc.documentElement, kids: [
      { role: 'button', name: 'Save', el: save },
      { role: 'button', name: 'Added', el: added },
    ] });
    childAx = [];
    const res = await native();
    expect(flat(res.tree).filter((n) => n.isNew).map((n) => n.name)).toEqual(['Added']);
  });

  it('omits controls it could not bind from the compact tree and counts them', async () => {
    unresolvable.add(idOf(dupB)); // e.g. a control inside a user-agent shadow root
    const res = await native();
    expect(flat(res.tree).filter((n) => n.name === 'Dup').map((n) => Boolean(n.ref))).toEqual([true]);
    expect(res.unreachableNodes).toBe(1);
  });

  it('keeps them, ref-less, in the full tree', async () => {
    unresolvable.add(idOf(dupB));
    const res = await native({ compact: false });
    expect(flat(res.tree).filter((n) => n.name === 'Dup').map((n) => Boolean(n.ref))).toEqual([true, false]);
    expect(res.unreachableNodes).toBe(1);
  });

  it('refuses to bind an element that changed tag between the AX read and the bind', async () => {
    afterPaths = () => {
      // The page re-rendered: a <div> now sits where the Save <button> was.
      const parent = save.parentNode!;
      const swapped = doc.el('div', {}, 'Save');
      const i = parent.childNodes.indexOf(save);
      parent.childNodes.splice(i, 1, swapped);
      swapped.parentNode = parent;
    };
    const res = await native();
    expect(named(res.tree, 'Save')).toBeUndefined(); // never bound to the wrong element, and not offered
    expect(res.unreachableNodes).toBe(1);
    expect(named(res.tree, 'Deep').ref).toBeTruthy(); // the rest still bound
  });

  it('skips cross-origin frames whose tree is not reachable and reports them', async () => {
    const original = (globalThis as any).chrome.debugger.sendCommand;
    (globalThis as any).chrome.debugger.sendCommand = async (t: unknown, m: string, p: Record<string, any>) => {
      if (m === 'Accessibility.getFullAXTree' && p?.frameId === 'child') throw new Error('Frame with the given id was not found.');
      return original(t, m, p);
    };
    try {
      const res = await native();
      expect(res.success).toBe(true);
      expect(res.skippedFrames).toEqual(['about:srcdoc']);
      expect(named(res.tree, 'In frame')).toBeUndefined();
      expect(named(res.tree, 'Save')?.ref).toBeTruthy();
    } finally {
      (globalThis as any).chrome.debugger.sendCommand = original;
    }
  });

  it('falls back to the DOM tree, with the reason, when the debugger cannot attach', async () => {
    attachError = 'Cannot attach to this target.';
    const res = await native();
    expect(res.success).toBe(true);
    expect(res.source).toBeUndefined();
    expect(res.nativeUnavailable).toContain('Cannot attach to this target.');
    expect(flat(res.tree).some((n) => n.name === 'Save')).toBe(true);
  });

  it('rejects browser-internal pages like the DOM snapshot does', async () => {
    await expect(handleSnapshot({ tabId: 99, source: 'native' })).rejects.toThrow(/protected page/);
  });

  it('is opt-in: the default snapshot never touches the debugger', async () => {
    const res = await handleSnapshot({ tabId: 7 }) as any;
    expect(res.success).toBe(true);
    expect(res.source).toBeUndefined();
    expect(cdp).toEqual([]);
  });
});
