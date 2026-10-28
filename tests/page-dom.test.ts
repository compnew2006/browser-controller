import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installFakePage, installFakeFrame, type FakeDocument } from './helpers/fake-dom.js';

// chrome mock: executeScript runs the page function in-process against the fake page.
(globalThis as any).chrome = {
  tabs: { get: async (id: number) => ({ id, url: 'https://example.test/page', windowId: 1 }), query: async () => [], onRemoved: { addListener: () => {} } },
  scripting: { executeScript: async (o: { func: (...a: any[]) => unknown; args?: unknown[] }) => [{ result: await o.func(...(o.args ?? [])) }] },
  storage: { session: { get: async () => ({}), set: async () => {} }, local: { get: async () => ({}), set: async () => {} } },
  // No debugger: interaction tools take their synthetic path.
  debugger: { attach: async () => { throw new Error('no debugger in tests'); }, detach: async () => {}, sendCommand: async () => ({}), onDetach: { addListener: () => {} } },
};

const { PAGE_DOM_INSTALL, PAGE_DOM_VERSION } = await import('../extension/lib/page-dom.js');
const { handleSnapshot, handleGetPageText, handleWait } = await import('../extension/handlers/inspection.js');
const { parseTarget } = await import('../extension/lib/target.js');
const { fallbackByTab } = await import('../extension/lib/state.js');

let doc: FakeDocument;
const D = () => (globalThis as any).__bcDom;

describe('shared page DOM runtime (resolver)', () => {
  beforeEach(() => {
    doc = installFakePage();
    fallbackByTab.clear();
    PAGE_DOM_INSTALL(PAGE_DOM_VERSION);
  });

  it('the agent cursor is cosmetic: a page it cannot draw on yields no glide and no error', () => {
    // The fake page has no documentElement / createElement: nothing to draw with.
    expect(D().cursor(10, 20, 'click', 1)).toBe(0);
    expect(D().cursor(Number.NaN, 20)).toBe(0);
  });

  it('resolves refs from the registry — no data-mcp-ref attribute needed', () => {
    const btn = doc.el('button', {}, 'Save');
    doc.body.append(btn);
    D().registry.set('e1', btn);
    expect(D().resolveTarget(parseTarget('e1'))).toMatchObject({ el: btn, via: 'ref' });
  });

  it('a selector prefers the first VISIBLE match over a hidden duplicate', () => {
    const hidden = doc.el('input', { class: 'q' });
    hidden.hidden = true;
    const shown = doc.el('input', { class: 'q' });
    doc.body.append(hidden, shown);
    expect(D().resolveTarget(parseTarget('input.q')).el).toBe(shown);
  });

  it('a selector reaches into shadow roots when the light DOM has no match', () => {
    const host = doc.el('my-widget');
    const inner = doc.el('button', { id: 'deep' }, 'Deep');
    host.attachShadow().append(inner);
    doc.body.append(host);
    expect(D().resolveTarget(parseTarget('#deep')).el).toBe(inner);
  });

  it('an ambiguous stale fallback is reported gone instead of guessing the first match', () => {
    const a = doc.el('button', { class: 'MuiButton-root' }, 'Open');
    const b = doc.el('button', { class: 'MuiButton-root' }, 'Close');
    doc.body.append(a, b);
    // Descriptor of a third button that no longer exists: its robust selector
    // matches both survivors, its text matches neither.
    const fb = { robustSelector: 'button.MuiButton-root', text: 'Delete', role: 'button', tag: 'BUTTON', nth: 0 };
    expect(D().resolveTarget(parseTarget('e9'), fb)).toMatchObject({ error: 'REF_GONE' });
  });

  it('a stale fallback re-resolves when text + selector identify one element, and uses nth among twins', () => {
    const like1 = doc.el('button', { class: 'like' }, 'Like');
    const like2 = doc.el('button', { class: 'like' }, 'Like');
    const other = doc.el('button', { class: 'like' }, 'Liked');
    doc.body.append(like1, other, like2);
    const fb = { robustSelector: 'button.like', text: 'Like', role: 'button', tag: 'BUTTON', nth: 1 };
    const res = D().resolveTarget(parseTarget('e1'), fb);
    expect(res).toMatchObject({ el: like2, via: 'fallback' });
    // Re-bound: the next lookup is a direct registry hit.
    expect(D().resolveTarget(parseTarget('e1'))).toMatchObject({ el: like2, via: 'ref' });
  });

  it('a stale fallback with nth 1 is not the first look-alike left: the second row was removed, so the ref is gone', () => {
    // Ref e2 was the second "Delete" row; the second row is removed. The lone survivor is the first row.
    const first = doc.el('button', { class: 'del' }, 'Delete');
    doc.body.append(first);
    const robust = { robustSelector: 'button.del', text: 'Delete', role: 'button', tag: 'BUTTON', nth: 1 };
    const textOnly = { text: 'Delete', role: 'button', tag: 'BUTTON', nth: 1 };
    expect(D().resolveTarget(parseTarget('e2'), robust)).toMatchObject({ error: 'REF_GONE', ref: 'e2' });
    expect(D().resolveTarget(parseTarget('e2'), textOnly)).toMatchObject({ error: 'REF_GONE', ref: 'e2' });
    // Positive control: with the second row still there, nth 1 is that row.
    const second = doc.el('button', { class: 'del' }, 'Delete');
    doc.body.append(second);
    expect(D().resolveTarget(parseTarget('e2'), robust)).toMatchObject({ el: second, via: 'fallback' });
  });

  it('a snapshot of a target re-found by its descriptor says so on its last line', async () => {
    const like1 = doc.el('button', { class: 'like' }, 'Like');
    const like2 = doc.el('button', { class: 'like' }, 'Like');
    doc.body.append(like1, like2);
    fallbackByTab.set(1, new Map([['e7', { robustSelector: 'button.like', text: 'Like', role: 'button', tag: 'BUTTON', nth: 1 }]]));
    const res = await handleSnapshot({ tabId: 1, target: 'e7' });
    expect(res.success).toBe(true);
    expect(res.text.split('\n').at(-1)).toBe('note: e7 was re-found after the page changed');
    expect(res.rebound).toBeUndefined();
  });

  it('a ref issued by an earlier document is REF_GONE, never re-found by its descriptor', () => {
    // The tab's earlier documents showed refs up to e5: this document's counter starts there.
    doc = installFakePage();
    const like = doc.el('button', { class: 'like' }, 'Like');
    doc.body.append(like);
    PAGE_DOM_INSTALL(PAGE_DOM_VERSION, 5);
    const fb = { robustSelector: 'button.like', text: 'Like', role: 'button', tag: 'BUTTON', nth: 0 };
    expect(D().resolveTarget(parseTarget('e3'), fb)).toMatchObject({ error: 'REF_GONE', ref: 'e3', issued: true });
    expect(D().refIsEarlier('e3')).toBe(true);
    expect(D().refIsEarlier('e6')).toBe(false);
  });

  it('an element inside an invisible iframe is not visible (and wait(visible) does not pass)', async () => {
    const frame = doc.el('iframe');
    const inner = installFakeFrame(frame);
    const btn = inner.el('button', { id: 'in-frame' }, 'Go');
    inner.body.append(btn);
    doc.body.append(frame);
    expect(D().isVisible(btn)).toBe(true);
    frame.hidden = true; // e.g. opacity:0 / display:none on the <iframe>
    expect(D().isVisible(btn)).toBe(false);
    const res = await handleWait({ tabId: 1, target: '#in-frame', timeout: 300 });
    expect(res.success).toBe(false);
  });

  it('names come from textContent (not CSS-transformed innerText) and include shadow text', () => {
    const plain = doc.el('button', {}, 'Open alert dialog');
    const host = doc.el('fancy-button');
    host.attachShadow().append(doc.el('span', {}, 'Shadow label'));
    doc.body.append(plain, host);
    expect(D().nameOf(plain)).toBe('Open alert dialog');
    expect(D().nameOf(host)).toBe('Shadow label');
    expect(D().roleOf(doc.el('input', { type: 'search' }))).toBe('searchbox');
  });

  it('follows HTML-AAM for headers and footers: banner and contentinfo only outside sectioning content', () => {
    const pageHeader = doc.el('header');
    const article = doc.el('article');
    const postHeader = doc.el('header');
    const postFooter = doc.el('footer');
    const region = doc.el('div', { role: 'region' });
    const regionFooter = doc.el('footer');
    article.append(postHeader, postFooter);
    region.append(regionFooter);
    doc.body.append(pageHeader, article, region);
    expect(D().roleOf(pageHeader)).toBe('banner');
    expect(D().roleOf(article)).toBe('article');
    expect(D().roleOf(postHeader)).toBe('generic');
    expect(D().roleOf(postFooter)).toBe('generic');
    expect(D().roleOf(regionFooter)).toBe('generic');
  });
});

describe('repeated row controls (icon buttons in table rows)', () => {
  beforeEach(() => { doc = installFakePage(); fallbackByTab.clear(); PAGE_DOM_INSTALL(PAGE_DOM_VERSION); });
  // A snapshot here must not make later tests' first snapshot report isNew.

  // Smacc-style grid: code + name cells, then icon-only buttons named by title.
  function unitsTable(names: string[]) {
    const rows = names.map((n, i) => doc.el('tr', {},
      doc.el('td', {}, String(i + 1)),
      doc.el('td', {}, n),
      doc.el('td', {}, doc.el('button', { title: 'تعديل' }), doc.el('button', { title: 'حذف' }))));
    doc.body.append(doc.el('button', {}, 'اضافة جديد'), doc.el('table', {}, doc.el('tbody', {}, ...rows)));
    return rows;
  }

  it('cell boundaries separate words in composed names; inline markup does not', () => {
    const [row] = unitsTable(['قطعه']);
    expect(D().nameOf(row)).toBe('1 قطعه');
    expect(D().nameOf(doc.el('a', { href: '/l' }, 'Lo', doc.el('b', {}, 'g'), 'in'))).toBe('Login');
  });

  it('snapshot adds row context only to controls whose role+name repeats', async () => {
    unitsTable(['قطعه', 'درزن']);
    const lines: string[] = (await handleSnapshot({ tabId: 1 })).text.split('\n');
    expect(lines.find((l) => l.includes('اضافة جديد'))).not.toContain('context=');
    expect(lines.filter((l) => l.includes('"تعديل"')).map((l) => l.match(/context="([^"]*)"/)?.[1])).toEqual(['1 قطعه', '2 درزن']);
  });

  it('row context leaves out cells the user cannot see (hidden columns)', async () => {
    // SMACC's units grid carries a display:none column ("غير الأبعاد") in every row.
    const rows = ['قطعه', 'درزن'].map((n, i) => doc.el('tr', {},
      doc.el('td', {}, String(i + 1)), doc.el('td', {}, n), doc.el('td', { style: 'display:none' }, 'غير الأبعاد'),
      doc.el('td', {}, doc.el('button', { title: 'تعديل' }))));
    doc.body.append(doc.el('table', {}, doc.el('tbody', {}, ...rows)));
    const text: string = (await handleSnapshot({ tabId: 1 })).text;
    const contexts = (text.match(/context="[^"]*"/g) ?? []).map((c) => c.slice('context="'.length, -1));
    expect(contexts).toEqual(['1 قطعه', '2 درزن']);
  });

  it('row context stays inside maxChars on a long grid', async () => {
    // Each control line carries its row context (~50 chars); the budget must hold them all.
    unitsTable(Array.from({ length: 20 }, (_, i) => `صنف رقم ${i} وصف طويل للصنف لاختبار حد الحجم`));
    const res = await handleSnapshot({ tabId: 1, maxChars: 3000 });
    expect(res.truncated).toBe(true);
    expect(res.text.length).toBeLessThan(3000 + 100);
  });
});

describe('text= and point targets (the resolver, contract principle 2)', () => {
  beforeEach(() => { doc = installFakePage(); PAGE_DOM_INSTALL(PAGE_DOM_VERSION); });

  it('text= matches case-insensitively, and the control that owns the text is the target', () => {
    const span = doc.el('span', {}, 'Open alert dialog');
    const btn = doc.el('button', { class: 'MuiButton-root' }, span);
    doc.body.append(doc.el('div', {}, btn));
    expect(D().resolveTarget(parseTarget('text=OPEN ALERT DIALOG'))).toMatchObject({ el: btn, via: 'text' });
  });

  it('text= reaches text inside shadow roots', () => {
    const host = doc.el('cookie-banner');
    const accept = doc.el('button', {}, 'Accept all');
    host.attachShadow().append(accept);
    doc.body.append(host);
    expect(D().resolveTarget(parseTarget('text=accept all')).el).toBe(accept);
  });

  it('a point target is returned as that point, with the element under it', () => {
    const btn = doc.el('button', { id: 'go' }, 'Go');
    doc.body.append(btn);
    // Fake boxes sit at (10, 10), 100 × 20; the fake hit test finds no element.
    expect(D().resolveTarget(parseTarget('60,20'))).toMatchObject({ point: { x: 60, y: 20 }, via: 'point' });
  });
});

describe('selector targets skip hidden duplicates', () => {
  beforeEach(() => { doc = installFakePage(); PAGE_DOM_INSTALL(PAGE_DOM_VERSION); });

  it('a selector resolves to the visible field, not the hidden one that matches first', () => {
    const hidden = doc.el('input', { name: 'q' });
    hidden.hidden = true;
    const shown = doc.el('input', { name: 'q' });
    doc.body.append(hidden, shown);
    expect(D().resolveTarget(parseTarget('input[name="q"]')).el).toBe(shown);
  });

  it('wait(visible) succeeds when ANY match is visible', async () => {
    const hidden = doc.el('div', { class: 'dlg' });
    hidden.hidden = true;
    doc.body.append(hidden, doc.el('div', { class: 'dlg' }, 'Dialog'));
    const res = await handleWait({ tabId: 1, target: '.dlg', timeout: 500 });
    expect(res.success).toBe(true);
  });

  it('wait(text=...) waits for visible page text (a text condition is a target)', async () => {
    doc.body.append(doc.el('p', {}, 'Payment received'));
    expect((await handleWait({ tabId: 1, target: 'text=payment RECEIVED', timeout: 500 })).success).toBe(true);
    expect((await handleWait({ tabId: 1, target: 'text=refund', timeout: 300 })).success).toBe(false);
  });
});

describe('snapshot + text', () => {
  beforeEach(() => { doc = installFakePage(); fallbackByTab.clear(); });

  it('snapshot walks shadow DOM, prints no href, and every ref is a short e<n>', async () => {
    const host = doc.el('nav-bar');
    host.attachShadow().append(doc.el('a', { href: '/docs' }, 'Docs'));
    const a = doc.el('a', { href: '/x' }, 'X');
    (a as any).href = 'https://example.test/x';
    doc.body.append(host, a);
    const res = await handleSnapshot({ tabId: 1 });
    expect(res.text).toContain('link "Docs" [e');
    expect(res.text).toContain('link "X" [e');
    expect(res.text).not.toContain('href');
    expect(res.refs.length).toBeGreaterThan(1);
    for (const r of res.refs) expect(r.ref).toMatch(/^e\d+$/);
  });

  it('snapshot maxChars caps output and says so', async () => {
    for (let i = 0; i < 200; i++) doc.body.append(doc.el('button', {}, `Button number ${i}`));
    const res = await handleSnapshot({ tabId: 1, maxChars: 1000 });
    expect(res.truncated).toBe(true);
    expect(res.text).toContain('… truncated (');
    expect(res.text.length).toBeLessThan(1100);
  });

  it('text includes shadow content and says how much a maxChars cut left out', async () => {
    const host = doc.el('support-table');
    host.attachShadow().append(doc.el('p', {}, 'WebGPU supported'));
    doc.body.append(doc.el('p', {}, 'Intro'), host);
    const cut = await handleGetPageText({ tabId: 1, maxChars: 5 });
    expect(cut.text.startsWith('Intro')).toBe(true);
    expect(cut.text).toMatch(/… truncated \(\d+ more chars\)$/);
    const all = await handleGetPageText({ tabId: 1 });
    expect(all.text).toContain('WebGPU supported');
  });

  it('text with a target: that one element; a missing one is NOT_FOUND', async () => {
    doc.body.append(doc.el('p', { id: 'only' }, 'Solo'), doc.el('p', {}, 'Other'));
    expect(await handleGetPageText({ tabId: 1, target: '#only' })).toMatchObject({ success: true, text: 'Solo' });
    expect(await handleGetPageText({ tabId: 1, target: '#missing' })).toMatchObject({ success: false, error: 'NOT_FOUND: #missing matches nothing' });
  });
});
