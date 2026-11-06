import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installFakeFrame, installFakePage, type FakeDocument, type FakeElement } from './helpers/fake-dom.js';
import { VaultRedactionRegistry } from '../mcp-server/src/vault/redaction.js';
import { snapshotTool } from '../mcp-server/src/tools/snapshot.js';
import type { ToolHost } from '../mcp-server/src/tools/types.js';

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

describe('incremental browser snapshots', () => {
  const hosts = new Map<string, ToolHost>();
  beforeEach(() => { install(); hosts.clear(); });

  const read = async (params: Record<string, unknown>, session = 'delta-session') => {
    let host = hosts.get(session);
    if (!host) {
      host = { callTool: async (_tool, p) => handleSnapshot(p) };
      hosts.set(session, host);
    }
    const result = await snapshotTool.handler(host, { tabId: 1, delta: true, ...params });
    const raw = (result.content[0] as { text: string }).text;
    const end = raw.indexOf('\n');
    return { ...JSON.parse(end < 0 ? raw : raw.slice(0, end)), ...(end < 0 ? {} : { text: raw.slice(end + 1) }), raw };
  };

  it('returns a changed-line splice and compact unchanged markers with stable refs', async () => {
    const buttons = Array.from({ length: 20 }, (_, i) => doc.el('button', { 'aria-label': `Button ${i}` }));
    doc.body.append(...buttons);
    const first = await read({});
    expect(first.kind).toBe('full');
    expect(first.revision).toBeTruthy();
    buttons[8].setAttribute('aria-label', 'Changed');
    const next = await read({ since: first.revision });
    expect(next.kind).toBe('delta');
    const full = await handleSnapshot({ tabId: 1 });
    const reconstructed = first.text.split('\n');
    reconstructed.splice(next.startLine, next.deleteCount, ...next.lines);
    expect(reconstructed.join('\n')).toBe(full.text);
    expect(full.text).toContain('button "Changed" [e9]');
    const unchanged = await read({ since: next.revision });
    expect(unchanged).toMatchObject({ kind: 'delta', baseRevision: next.revision, deleteCount: 0, lines: [] });
    expect(unchanged).not.toHaveProperty('text');
  });

  it('fails closed when concurrent callers advance the same revision', async () => {
    doc.body.append(...Array.from({ length: 20 }, (_, i) => doc.el('button', {}, `Control ${i}`)));
    const first = await read({});
    const results = await Promise.all([read({ since: first.revision }), read({ since: first.revision })]);
    expect(results.filter((r) => r.kind === 'delta')).toHaveLength(1);
    expect(results.filter((r) => r.kind === 'full' && r.reason === 'baseline-unavailable')).toHaveLength(1);
  });

  it('does not reuse baselines across sessions, tabs, or query scopes', async () => {
    doc.body.append(doc.el('button', {}, 'Save'));
    const first = await read({});
    expect(await read({ since: first.revision }, 'other-session')).toMatchObject({ kind: 'full', reason: 'baseline-unavailable' });
    expect(await read({ tabId: 2, since: first.revision })).toMatchObject({ kind: 'full', reason: 'baseline-unavailable' });
    expect(await read({ query: 'Save', since: first.revision })).toMatchObject({ kind: 'full', reason: 'baseline-unavailable' });
    expect(await read({ since: first.revision }, '')).toMatchObject({ kind: 'full', reason: 'baseline-unavailable' });
  });

  it('resets on a document replacement at the same URL and a same-origin frame reload', async () => {
    const frame = doc.el('iframe', { src: 'https://example.test/frame' });
    const inside = installFakeFrame(frame);
    inside.body.append(inside.el('button', {}, 'Inside'));
    doc.body.append(frame);
    const first = await read({});
    const replacement = installFakeFrame(frame);
    replacement.body.append(replacement.el('button', {}, 'Inside'));
    const next = await read({ since: first.revision });
    expect(next).toMatchObject({ kind: 'full', reason: 'document-changed' });
    install();
    const afterNavigation = await read({ since: next.revision });
    expect(afterNavigation).toMatchObject({ kind: 'full', reason: 'document-changed' });
  });

  it('never offers a truncated baseline and refuses since without delta', async () => {
    doc.body.append(doc.el('button', {}, 'First'));
    const first = await read({ maxChars: 200 });
    expect(first.revision).toBeTruthy();
    for (let i = 0; i < 30; i++) doc.body.append(doc.el('button', {}, `Long button ${i}`));
    const cut = await read({ maxChars: 200, since: first.revision });
    expect(cut).toMatchObject({ kind: 'full', reason: 'truncated', revision: null });
    doc.body.childNodes.length = 1;
    const later = await read({ maxChars: 200, since: first.revision });
    expect(later).toMatchObject({ kind: 'full', reason: 'baseline-unavailable' });
    await expect(handleSnapshot({ tabId: 1, since: 'old' })).rejects.toThrow('since requires delta:true');
  });

  it('expires an idle baseline instead of reusing it indefinitely', async () => {
    vi.useFakeTimers();
    try {
      doc.body.append(doc.el('button', {}, 'Save'));
      const first = await read({});
      await vi.advanceTimersByTimeAsync(30_001);
      const later = await read({ since: first.revision });
      expect(later).toMatchObject({ kind: 'full', reason: 'baseline-unavailable' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps password values masked in full and incremental output', async () => {
    const password = doc.el('input', { type: 'password', value: 'secret-one', 'aria-label': 'Password' });
    doc.body.append(password, ...Array.from({ length: 20 }, (_, i) => doc.el('button', {}, `Item ${i}`)));
    const first = await read({});
    expect(JSON.stringify(first)).not.toContain('secret-one');
    password.value = 'secret-two';
    const next = await read({ since: first.revision });
    expect(JSON.stringify(next)).not.toContain('secret-two');
  });

  it('compares only daemon-sanitized text, including multiline vault secrets', async () => {
    const secret = ['private-alpha', 'private-beta'].join('\n');
    doc.body.append(doc.el('textarea', { value: secret, 'aria-label': 'Notes' }));
    const registry = new VaultRedactionRegistry();
    registry.register('scope', secret, 'document');
    const host: ToolHost = { callTool: async (_tool, p) => registry.sanitize('scope', await handleSnapshot(p), { toolName: 'browser_snapshot' }) };
    const baseline = await snapshotTool.handler(host, { tabId: 1, delta: true });
    const text = (baseline.content[0] as { text: string }).text;
    expect(text).not.toContain('private-alpha');
    expect(text).not.toContain('private-beta');
  });
});
