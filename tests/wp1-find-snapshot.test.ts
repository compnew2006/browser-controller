import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installFakePage, type FakeDocument, type FakeElement } from './helpers/fake-dom.js';

// chrome mock: executeScript runs the page function in-process against the fake page.
(globalThis as any).chrome = {
  tabs: { get: async (id: number) => ({ id, url: 'https://example.test/page', windowId: 1 }), query: async () => [], onRemoved: { addListener: () => {} } },
  scripting: { executeScript: async (o: { func: (...a: any[]) => unknown; args?: unknown[] }) => [{ result: await o.func(...(o.args ?? [])) }] },
  storage: { session: { get: async () => ({}), set: async () => {} }, local: { get: async () => ({}), set: async () => {} } },
  debugger: { attach: async () => { throw new Error('no debugger in tests'); }, detach: async () => {}, sendCommand: async () => ({}), onDetach: { addListener: () => {} } },
};

const { PAGE_DOM_INSTALL, PAGE_DOM_VERSION } = await import('../extension/lib/page-dom.js');
const { handleSnapshot } = await import('../extension/handlers/inspection.js');
const { fallbackByTab } = await import('../extension/lib/state.js');
const { parseTarget } = await import('../extension/lib/target.js');

let doc: FakeDocument;
const D = () => (globalThis as any).__bcDom;

/** Depth-first element walk of the body, the way document.createTreeWalker yields it. */
function bodyWalker(root: FakeElement) {
  const nodes: FakeElement[] = [];
  const visit = (n: FakeElement) => { for (const c of n.children) { nodes.push(c); visit(c); } };
  visit(root);
  let i = 0;
  return { nextNode: () => nodes[i++] ?? null };
}

function install() {
  doc = installFakePage();
  (globalThis as any).NodeFilter = { SHOW_ELEMENT: 1 };
  (doc as any).createTreeWalker = () => bodyWalker(doc.body);
  fallbackByTab.clear();
  PAGE_DOM_INSTALL(PAGE_DOM_VERSION);
}

/** Computed style with opacity and overflow, so the fake page can express them. */
function styled(el: FakeElement) {
  const style = el.attrs.get('style') || '';
  return {
    display: style.includes('display:contents') ? 'contents' : el.isHiddenInTree ? 'none' : 'block',
    visibility: style.includes('visibility:hidden') ? 'hidden' : 'visible',
    opacity: style.includes('opacity:0') ? '0' : '1',
    overflowY: style.includes('overflow:auto') ? 'auto' : 'visible',
    overflowX: 'visible',
    whiteSpace: 'normal',
  };
}

describe('browser_snapshot: what it lists and what it shows', () => {
  beforeEach(install);

  it('never prints a password value', async () => {
    doc.body.append(doc.el('input', { type: 'password', value: 'hunter2-secret', 'aria-label': 'Password' }));
    const res = await handleSnapshot({ tabId: 1 });
    expect(res.text).not.toContain('hunter2');
    expect(res.text).toContain('textbox "Password"');
  });

  it('omits elements that are opacity:0, inert, or inside aria-hidden="true", but keeps off-screen ones', async () => {
    doc.defaultView.getComputedStyle = (el: FakeElement) => styled(el) as any;
    doc.body.append(
      doc.el('button', { style: 'opacity:0' }, 'Fading out'),
      doc.el('button', { inert: '' }, 'Inert control'),
      doc.el('div', { 'aria-hidden': 'true' }, doc.el('button', {}, 'Decorative twin')),
      doc.el('button', { style: 'position:absolute;top:5000px' }, 'Far below'),
    );
    const res = await handleSnapshot({ tabId: 1 });
    expect(res.text).not.toContain('Fading out');
    expect(res.text).not.toContain('Inert control');
    expect(res.text).not.toContain('Decorative twin');
    expect(res.text).toContain('Far below');
  });

  it('marks a cross-origin iframe instead of silently dropping it', async () => {
    doc.body.append(doc.el('iframe', { src: 'https://payments.other.example/embed?x=1' }));
    const res = await handleSnapshot({ tabId: 1 });
    expect(res.text).toContain('iframe "cross-origin https://payments.other.example" (not readable)');
  });

  it('the extension shield is not page content', async () => {
    doc.body.append(doc.el('div', { id: '__bc-lock-shield' }, doc.el('div', { class: '__bc-shield-label' }, 'browser_click')), doc.el('button', {}, 'Real'));
    const res = await handleSnapshot({ tabId: 1 });
    expect(res.text).toContain('button "Real"');
    expect(res.text).not.toContain('browser_click');
  });

  it('numbers look-alike controls in document order (nth) without re-walking the page per ref', async () => {
    // 3,000 rows, each with an "Edit" button: a 1,000-row table froze the tab when every
    // ref re-walked the whole body and read styles of every same-role element.
    for (let i = 0; i < 3000; i++) doc.body.append(doc.el('div', { role: 'row' }, doc.el('span', {}, `Carton ${i}`), doc.el('button', {}, 'Edit')));
    let walks = 0;
    let styleReads = 0;
    const counted = (el: FakeElement) => { styleReads++; return styled(el) as any; };
    (doc as any).createTreeWalker = () => { walks++; return bodyWalker(doc.body); };
    doc.defaultView.getComputedStyle = counted as any;
    (globalThis as any).getComputedStyle = counted;
    const started = Date.now();
    const res = await handleSnapshot({ tabId: 1 });
    const ms = Date.now() - started;
    expect(res.success).toBe(true);
    const edits = res.refs.filter((r: any) => r.role === 'button');
    expect(edits.length).toBeGreaterThan(20);
    const fallbacks = fallbackByTab.get(1)!;
    edits.slice(0, 20).forEach((b: any, i: number) => expect(fallbacks.get(b.ref).nth).toBe(i));
    // One walk and one style read per element per snapshot pass, not per ref.
    expect(walks).toBeLessThanOrEqual(3);
    expect(styleReads).toBeLessThan(4 * 6001);
    expect(ms).toBeLessThan(5000);
  });

  it('the registry keeps the refs of elements still on the page, across many snapshots', async () => {
    doc.body.append(doc.el('button', {}, 'Alpha'), doc.el('button', {}, 'Beta'));
    const first = await handleSnapshot({ tabId: 1 });
    const alphaRef = first.refs[0].ref as string;
    for (let i = 0; i < 30; i++) await handleSnapshot({ tabId: 1 });
    expect(D().registry.size).toBe(2);
    expect(D().resolveTarget(parseTarget(alphaRef))).toMatchObject({ via: 'ref' });
    expect(first.refs[0].ref).toBe(alphaRef);
  });

  it('a ref whose element is gone is worded REF_GONE when it was issued, by the snapshot too', async () => {
    const alpha = doc.el('button', {}, 'Alpha');
    doc.body.append(alpha);
    const ref = (await handleSnapshot({ tabId: 1 })).refs[0].ref as string;
    alpha.isConnected = false;
    doc.body.childNodes.length = 0;
    fallbackByTab.clear();
    const res = await handleSnapshot({ tabId: 1, target: ref });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(new RegExp(`^REF_GONE: ref ${ref} `));
  });
});

describe('stale refs on a snapshot target', () => {
  beforeEach(install);

  it('a snapshot scoped to an unknown ref uses the same stale-ref wording, not its own', async () => {
    doc.body.append(doc.el('button', {}, 'Save'));
    const res = await handleSnapshot({ tabId: 1, target: 'e9' });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/^REF_NOT_FOUND: ref e9 /);
    expect(res).not.toHaveProperty('_ref');
  });
});
