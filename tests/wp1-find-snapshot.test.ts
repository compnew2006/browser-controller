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
const { handleFind, handleSnapshot } = await import('../extension/handlers/inspection.js');
const { handleClick } = await import('../extension/handlers/interaction.js');
const { fallbackByTab, nextRefPrefix } = await import('../extension/lib/state.js');

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

describe('browser_find: query text and ranking', () => {
  beforeEach(install);

  it('a hyphenated word is a plain query, not a regex (used to crash to null)', async () => {
    doc.body.append(doc.el('button', {}, 'Sign-in'), doc.el('a', { href: '/x' }, 'Other'));
    const res = await handleFind({ tabId: 1, query: 'sign-in button' });
    expect(res).not.toBeNull();
    expect(res.matches[0]).toMatchObject({ role: 'button', name: 'Sign-in' });
  });

  it('brackets, emoji and role-named words in the query do not crash the search', async () => {
    doc.body.append(doc.el('button', {}, '[beta] launch'), doc.el('button', {}, 'constructor'));
    for (const query of ['[beta] launch', '🚀 launch', 'constructor', 'toString', '(', '\\d+']) {
      const res = await handleFind({ tabId: 1, query });
      expect(res, query).not.toBeNull();
      expect(res.success, query).toBe(true);
    }
    expect((await handleFind({ tabId: 1, query: '[beta]' })).matches[0]).toMatchObject({ name: '[beta] launch' });
  });

  it('an exact word beats a word found only inside a longer word', async () => {
    doc.body.append(doc.el('button', {}, 'Scarter sale'), doc.el('button', {}, 'Cart'));
    const res = await handleFind({ tabId: 1, query: 'cart' });
    expect(res.matches.map((m: any) => m.name)).toEqual(['Cart']);
  });

  it('a partial word still finds the control when no exact word exists anywhere', async () => {
    doc.body.append(doc.el('button', {}, 'Login now'));
    const res = await handleFind({ tabId: 1, query: 'log' });
    expect(res.matches.map((m: any) => m.name)).toEqual(['Login now']);
  });

  it('never returns the extension\'s own shield or cursor elements', async () => {
    doc.body.append(doc.el('button', { id: '__bc-lock-shield' }, 'Stop agent control'), doc.el('button', {}, 'Stop playback'));
    const res = await handleFind({ tabId: 1, query: 'stop' });
    expect(res.matches.map((m: any) => m.name)).toEqual(['Stop playback']);
  });
});

describe('browser_snapshot: what it lists and what it shows', () => {
  beforeEach(install);

  it('never prints a password value', async () => {
    doc.body.append(doc.el('input', { type: 'password', value: 'hunter2-secret', 'aria-label': 'Password' }));
    const res = await handleSnapshot({ tabId: 1, compact: false });
    const json = JSON.stringify(res.tree);
    expect(json).not.toContain('hunter2');
    expect(json).toContain('"name":"Password"');
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
    const json = JSON.stringify(res.tree);
    expect(json).not.toContain('Fading out');
    expect(json).not.toContain('Inert control');
    expect(json).not.toContain('Decorative twin');
    expect(json).toContain('Far below');
  });

  it('marks a cross-origin iframe instead of silently dropping it', async () => {
    doc.body.append(doc.el('iframe', { src: 'https://payments.other.example/embed?x=1' }));
    const res = await handleSnapshot({ tabId: 1 });
    expect(JSON.stringify(res.tree)).toContain('"name":"cross-origin: https://payments.other.example"');
  });

  it('the extension shield is not page content', async () => {
    doc.body.append(doc.el('div', { id: '__bc-lock-shield' }, doc.el('div', { class: '__bc-shield-label' }, 'browser_click')), doc.el('button', {}, 'Real'));
    const res = await handleSnapshot({ tabId: 1 });
    const json = JSON.stringify(res.tree);
    expect(json).toContain('"name":"Real"');
    expect(json).not.toContain('browser_click');
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
    const buttons: any[] = [];
    const visit = (n: any) => { if (!n) return; if (Array.isArray(n)) return n.forEach(visit); if (n.role === 'button') buttons.push(n); visit(n.children); };
    visit(res.tree);
    expect(buttons.length).toBeGreaterThan(20);
    const fallbacks = fallbackByTab.get(1)!;
    buttons.slice(0, 20).forEach((b, i) => expect(fallbacks.get(b.ref).nth).toBe(i));
    // One walk and one style read per element per snapshot pass, not per ref.
    expect(walks).toBeLessThanOrEqual(3);
    expect(styleReads).toBeLessThan(4 * 6001);
    expect(ms).toBeLessThan(5000);
  });

  it('bounds the ref registry: refs from snapshots older than the last generations are dropped', async () => {
    doc.body.append(doc.el('button', {}, 'Alpha'), doc.el('button', {}, 'Beta'));
    const first = await handleSnapshot({ tabId: 1 });
    const oldRef = first.tree[0].ref as string;
    expect(D().resolve(oldRef, null, null)).toMatchObject({ via: 'ref' });
    for (let i = 0; i < 30; i++) await handleSnapshot({ tabId: 1 });
    expect(D().registry.size).toBeLessThanOrEqual(20);
    expect(D().resolve(oldRef, null, null)).toMatchObject({ error: 'REF_GONE' });
  });

  it('a ref evicted from the registry gives the REF_GONE style error through browser_click', async () => {
    doc.body.append(doc.el('button', {}, 'Alpha'));
    const first = await handleSnapshot({ tabId: 1 });
    const oldRef = first.tree.ref as string;
    fallbackByTab.clear();
    for (let i = 0; i < 12; i++) await handleSnapshot({ tabId: 1 });
    const res = await handleClick({ tabId: 1, ref: oldRef });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/^REF_(GONE|NOT_FOUND)/);
  });
});

describe('stale refs: one answer, at most five look-alikes', () => {
  beforeEach(install);

  it('a gone ref with a known name lists at most 5 look-alike refs, never the page', async () => {
    for (let i = 1; i <= 40; i++) doc.body.append(doc.el('button', {}, `Item ${i}`));
    // The missing ref was issued earlier for "Itme 7" (a renamed control): no element matches it.
    fallbackByTab.set(1, new Map([['sgone-0', { text: 'Itme 7', role: 'button', tag: 'BUTTON', nth: 0 }]]));
    const res = await handleClick({ tabId: 1, ref: 'sgone-0' });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/^REF_GONE: ref sgone-0 /);
    expect(res.freshRefs.length).toBeGreaterThan(0);
    expect(res.freshRefs.length).toBeLessThanOrEqual(5);
    expect(res.freshRefs[0].name).toMatch(/^Item/);
    expect(JSON.stringify(res).length).toBeLessThan(800);
  });

  it('a mistyped ref (never issued here) says so and lists nothing', async () => {
    doc.body.append(doc.el('button', {}, 'Save'));
    const res = await handleClick({ tabId: 1, ref: 'e5' });
    expect(res.error).toMatch(/^REF_NOT_FOUND: ref e5 /);
    expect(res.freshRefs).toBeUndefined();
  });

  it('a snapshot scoped to an unknown ref uses the same stale-ref wording, not its own', async () => {
    doc.body.append(doc.el('button', {}, 'Save'));
    const res = await handleSnapshot({ tabId: 1, ref: 'e9' });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/^REF_NOT_FOUND: ref e9 /);
    expect(res).not.toHaveProperty('_ref');
  });
});

describe('ref prefixes', () => {
  it('do not repeat within a long session (used to wrap after 1,296)', () => {
    const prefixes = new Set(Array.from({ length: 5000 }, () => nextRefPrefix('s')));
    expect(prefixes.size).toBe(5000);
  });
});

afterEach(() => { fallbackByTab.clear(); });
