import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installFakePage, installFakeFrame, type FakeDocument } from './helpers/fake-dom.js';

const cdp: Array<Record<string, any>> = [];
/** Mouse presses the tools sent over CDP. */
const presses = () => cdp.filter((c) => c.method === 'Input.dispatchMouseEvent' && c.type === 'mousePressed');

// chrome mock: executeScript runs the page function in-process against the fake page.
(globalThis as any).chrome = {
  tabs: { get: async (id: number) => ({ id, url: 'https://example.test/page', windowId: 1 }), query: async () => [], onRemoved: { addListener: () => {} } },
  scripting: { executeScript: async (o: { func: (...a: any[]) => unknown; args?: unknown[] }) => [{ result: await o.func(...(o.args ?? [])) }] },
  storage: { session: { get: async () => ({}), set: async () => {} }, local: { get: async () => ({}), set: async () => {} } },
  // The debugger records the input the tools send; the page functions run against the fake page.
  debugger: { attach: async () => {}, detach: async () => {}, sendCommand: async (_t: unknown, method: string, params: any = {}) => { cdp.push({ method, ...params }); return {}; }, onDetach: { addListener: () => {} } },
};

const { PAGE_DOM_INSTALL, PAGE_DOM_VERSION } = await import('../extension/lib/page-dom.js');
const { handleFind, handleSnapshot, handleGetPageText, handleWait } = await import('../extension/handlers/inspection.js');
const { handleClick, handleType } = await import('../extension/handlers/interaction.js');
const { fallbackByTab, lastSnapshotFingerprints } = await import('../extension/lib/state.js');

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
    D().registry.set('s1-0', btn);
    expect(D().resolve('s1-0', null, null)).toMatchObject({ el: btn, via: 'ref' });
  });

  it('a selector prefers the first VISIBLE match over a hidden duplicate', () => {
    const hidden = doc.el('input', { class: 'q' });
    hidden.hidden = true;
    const shown = doc.el('input', { class: 'q' });
    doc.body.append(hidden, shown);
    expect(D().resolve(null, 'input.q', null).el).toBe(shown);
  });

  it('a selector reaches into shadow roots when the light DOM has no match', () => {
    const host = doc.el('my-widget');
    const inner = doc.el('button', { id: 'deep' }, 'Deep');
    host.attachShadow().append(inner);
    doc.body.append(host);
    expect(D().resolve(null, '#deep', null).el).toBe(inner);
  });

  it('an ambiguous stale fallback is reported gone instead of guessing the first match', () => {
    const a = doc.el('button', { class: 'MuiButton-root' }, 'Open');
    const b = doc.el('button', { class: 'MuiButton-root' }, 'Close');
    doc.body.append(a, b);
    // Descriptor of a third button that no longer exists: its robust selector
    // matches both survivors, its text matches neither.
    const fb = { robustSelector: 'button.MuiButton-root', text: 'Delete', role: 'button', tag: 'BUTTON', nth: 0 };
    expect(D().resolve('gone-ref', null, fb)).toMatchObject({ error: 'REF_GONE' });
  });

  it('a stale fallback re-resolves when text + selector identify one element, and uses nth among twins', () => {
    const like1 = doc.el('button', { class: 'like' }, 'Like');
    const like2 = doc.el('button', { class: 'like' }, 'Like');
    const other = doc.el('button', { class: 'like' }, 'Liked');
    doc.body.append(like1, other, like2);
    const fb = { robustSelector: 'button.like', text: 'Like', role: 'button', tag: 'BUTTON', nth: 1 };
    const res = D().resolve('old', null, fb);
    expect(res).toMatchObject({ el: like2, via: 'fallback' });
    // Re-bound: the next lookup is a direct registry hit.
    expect(D().resolve('old', null, null)).toMatchObject({ el: like2, via: 'ref' });
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
    const res = await handleWait({ tabId: 1, selector: '#in-frame', timeout: 300 });
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
});

describe('browser_find (tokenized, role-aware, wrapper-suppressing)', () => {
  beforeEach(() => { doc = installFakePage(); fallbackByTab.clear(); });

  it('multi-word query finds the search input by role word + attributes', async () => {
    doc.body.append(
      doc.el('div', { class: 'header' }, doc.el('a', { href: '/' }, 'Home')),
      doc.el('input', { type: 'search', placeholder: 'Search docs', name: 'q' }),
    );
    const res = await handleFind({ tabId: 1, query: 'search input', limit: 3 });
    expect(res.success).toBe(true);
    expect(res.matches[0]).toMatchObject({ role: 'searchbox', tag: 'input' });
  });

  it('prefers the button over the wrappers whose text contains the same words', async () => {
    const btn = doc.el('button', {}, 'Open alert dialog');
    doc.body.append(doc.el('div', { class: 'demo' }, doc.el('div', {}, btn)));
    const res = await handleFind({ tabId: 1, query: 'Open alert dialog button', limit: 5 });
    expect(res.matches[0]).toMatchObject({ role: 'button', name: 'Open alert dialog' });
    expect(res.matches.every((m: any) => m.tag !== 'div')).toBe(true);
    // The ref works in the action tools (registry-backed).
    cdp.length = 0;
    const click = await handleClick({ tabId: 1, ref: res.matches[0].ref });
    expect(click.success).toBe(true);
    expect(btn.events).toContain('scrollIntoView'); // the element the real click was aimed at
    expect(presses()).toHaveLength(1);
  });

  it('finds controls inside shadow DOM and honours the role filter', async () => {
    const host = doc.el('site-search');
    host.attachShadow().append(doc.el('button', { 'aria-label': 'Search' }), doc.el('a', { href: '/s' }, 'Search help'));
    doc.body.append(host);
    const res = await handleFind({ tabId: 1, query: 'search', role: 'button' });
    expect(res.matches).toHaveLength(1);
    expect(res.matches[0]).toMatchObject({ role: 'button', name: 'Search' });
  });

  it('returns a hint instead of silence when nothing matches', async () => {
    doc.body.append(doc.el('p', {}, 'nothing here'));
    const res = await handleFind({ tabId: 1, query: 'checkout button' });
    expect(res.matches).toHaveLength(0);
    expect(res.hint).toMatch(/snapshot|text/);
  });
});

describe('repeated row controls (icon buttons in table rows)', () => {
  beforeEach(() => { doc = installFakePage(); fallbackByTab.clear(); PAGE_DOM_INSTALL(PAGE_DOM_VERSION); });
  // A snapshot here must not make later tests' first snapshot report isNew.
  afterEach(() => { lastSnapshotFingerprints.clear(); });

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

  it('find ranks the button in the row the query names first, and says which row', async () => {
    const rows = unitsTable(['قطعه', 'درزن', 'بكت', 'كرتون', 'ربطة']);
    const res = await handleFind({ tabId: 1, query: 'تعديل كرتون', limit: 3 });
    expect(res.matches[0]).toMatchObject({ role: 'button', name: 'تعديل', context: '4 كرتون' });
    const click = await handleClick({ tabId: 1, ref: res.matches[0].ref });
    expect(click.success).toBe(true);
    expect(rows[3].children[2].children[0].events).toContain('scrollIntoView');
    expect(rows[2].children[2].children[0].events).not.toContain('scrollIntoView');
  });

  it('compact snapshot adds row context only to controls whose role+name repeats', async () => {
    unitsTable(['قطعه', 'درزن']);
    const res = await handleSnapshot({ tabId: 1 });
    const buttons = res.snapshot.split('\n').filter((l: string) => l.includes('button "'));
    expect(buttons.find((b: string) => b.includes('اضافة جديد'))).not.toContain('(row:');
    expect(buttons.filter((b: string) => b.includes('"تعديل"')).map((b: string) => /\(row: (.*)\)$/.exec(b)?.[1])).toEqual(['1 قطعه', '2 درزن']);
  });

  it('row context leaves out cells the user cannot see (hidden columns)', async () => {
    // SMACC's units grid carries a display:none column ("غير الأبعاد") in every row.
    const rows = ['قطعه', 'درزن'].map((n, i) => doc.el('tr', {},
      doc.el('td', {}, String(i + 1)), doc.el('td', {}, n), doc.el('td', { style: 'display:none' }, 'غير الأبعاد'),
      doc.el('td', {}, doc.el('button', { title: 'تعديل' }))));
    doc.body.append(doc.el('table', {}, doc.el('tbody', {}, ...rows)));
    const res = await handleSnapshot({ tabId: 1 });
    const contexts = res.snapshot.split('\n').map((l: string) => /\(row: (.*)\)$/.exec(l)?.[1]).filter(Boolean);
    expect(contexts).toEqual(['1 قطعه', '2 درزن']);
  });

  it('row context stays inside maxChars on a long grid', async () => {
    // The 41 control nodes fit in 3000 chars; their row contexts (~50 chars each) would not.
    unitsTable(Array.from({ length: 20 }, (_, i) => `صنف رقم ${i} وصف طويل للصنف لاختبار حد الحجم`));
    const res = await handleSnapshot({ tabId: 1, maxChars: 1500 });
    expect(res.truncated).toBe(true);
    expect(res.snapshot.length).toBeLessThanOrEqual(1500);
  });
});

describe('browser_click text', () => {
  beforeEach(() => { doc = installFakePage(); cdp.length = 0; });

  it('matches case-insensitively and clicks the control that owns the text', async () => {
    const span = doc.el('span', {}, 'Open alert dialog');
    const btn = doc.el('button', { class: 'MuiButton-root' }, span);
    doc.body.append(doc.el('div', {}, btn));
    const res = await handleClick({ tabId: 1, text: 'OPEN ALERT DIALOG' });
    expect(res).toEqual({ success: true, clicked: 'button "Open alert dialog"' });
    expect(btn.events).toContain('scrollIntoView');
    expect(span.events).not.toContain('scrollIntoView');
    expect(presses()).toHaveLength(1);
  });

  it('plain text: the element holding it, not the wrappers around it', async () => {
    const p = doc.el('p', {}, 'Payment received');
    const inner = doc.el('div', {}, p);
    doc.body.append(doc.el('section', {}, inner));
    expect(await handleClick({ tabId: 1, text: 'payment received' })).toMatchObject({ success: true, clicked: expect.stringContaining('"Payment received"') });
    expect(p.events).toContain('scrollIntoView');
    expect(inner.events).not.toContain('scrollIntoView');
  });

  it('an exact match beats a longer one; equal matches are counted', async () => {
    const save = doc.el('button', {}, 'Save');
    doc.body.append(doc.el('button', {}, 'Save draft'), save, doc.el('button', {}, 'Save'));
    const res = await handleClick({ tabId: 1, text: 'save' });
    expect(res).toMatchObject({ success: true, clicked: 'button "Save"', matches: 2 });
    expect(save.events).toContain('scrollIntoView');
  });

  it('reaches text inside shadow roots', async () => {
    const host = doc.el('cookie-banner');
    const accept = doc.el('button', {}, 'Accept all');
    host.attachShadow().append(accept);
    doc.body.append(host);
    const res = await handleClick({ tabId: 1, text: 'accept all' });
    expect(res.success).toBe(true);
    expect(accept.events).toContain('scrollIntoView');
  });
});

describe('selector actions skip hidden duplicates', () => {
  beforeEach(() => { doc = installFakePage(); });

  it('type goes to the visible field, not the hidden one that matches first', async () => {
    const hidden = doc.el('input', { name: 'q' });
    hidden.hidden = true;
    hidden.value = '';
    const shown = doc.el('input', { name: 'q' });
    shown.value = '';
    doc.body.append(hidden, shown);
    const res = await handleType({ tabId: 1, selector: 'input[name="q"]', text: 'abc' });
    expect(res.success).toBe(true);
    expect(doc.activeElement).toBe(shown); // focused, then real key presses
    expect(cdp.filter((c) => c.method === 'Input.dispatchKeyEvent' && c.type === 'keyDown').map((c) => c.key)).toEqual(['a', 'b', 'c']);
  });

  it('wait(visible) succeeds when ANY match is visible', async () => {
    const hidden = doc.el('div', { class: 'dlg' });
    hidden.hidden = true;
    doc.body.append(hidden, doc.el('div', { class: 'dlg' }, 'Dialog'));
    const res = await handleWait({ tabId: 1, selector: '.dlg', timeout: 500 });
    expect(res.success).toBe(true);
  });

  it('wait(text) waits for page text', async () => {
    doc.body.append(doc.el('p', {}, 'Payment received'));
    expect((await handleWait({ tabId: 1, text: 'payment RECEIVED', timeout: 500 })).success).toBe(true);
    expect((await handleWait({ tabId: 1, text: 'refund', timeout: 300 })).success).toBe(false);
  });
});

describe('snapshot + text', () => {
  beforeEach(() => { doc = installFakePage(); fallbackByTab.clear(); });

  it('snapshot lines include shadow-DOM controls, short refs, no "+" on the first snapshot, path-only same-origin links', async () => {
    const host = doc.el('nav-bar');
    host.attachShadow().append(doc.el('a', { href: '/docs' }, 'Docs'));
    const a = doc.el('a', { href: '/x' }, 'X');
    (a as any).href = 'https://example.test/x';
    doc.body.append(host, a);
    const res = await handleSnapshot({ tabId: 1, links: true });
    const lines: string[] = res.snapshot.split('\n');
    expect(lines.some((l) => /^- link "Docs" \[[^\]]+\]/.test(l.trim()))).toBe(true);
    expect(lines.every((l) => l.trim().startsWith('- '))).toBe(true);
    expect(res.snapshot).toContain('→ /x');
    expect((await handleSnapshot({ tabId: 1 })).snapshot).not.toContain('→'); // link targets only on request
    const refs = res.snapshot.match(/\[[a-z0-9]+-\d+\]/g) ?? [];
    expect(refs.length).toBeGreaterThan(1);
    for (const r of refs) expect(r.length).toBeLessThan(20);
    const again = await handleSnapshot({ tabId: 1 });
    expect(again.snapshot.includes('+ ')).toBe(false); // nothing new on an unchanged page
    doc.body.append(doc.el('button', {}, 'Fresh'));
    const third = await handleSnapshot({ tabId: 1 });
    expect(third.snapshot.split('\n').find((l: string) => l.includes('"Fresh"'))?.trim().startsWith('+ ')).toBe(true);
  });

  it('snapshot maxChars caps output and says so', async () => {
    for (let i = 0; i < 200; i++) doc.body.append(doc.el('button', {}, `Button number ${i}`));
    const res = await handleSnapshot({ tabId: 1, maxChars: 1000 });
    expect(res.truncated).toBe(true);
    expect(res.snapshot.length).toBeLessThanOrEqual(1000);
    expect(res.hint).toMatch(/maxChars/);
  });

  it('text includes shadow content and supports offset paging', async () => {
    const host = doc.el('support-table');
    host.attachShadow().append(doc.el('p', {}, 'WebGPU supported'));
    doc.body.append(doc.el('p', {}, 'Intro'), host);
    const res = await handleGetPageText({ tabId: 1, maxLength: 5 });
    expect(res.text.startsWith('Intro')).toBe(true);
    expect(res.nextOffset).toBe(5);
    const all = await handleGetPageText({ tabId: 1 });
    expect(all.text).toContain('WebGPU supported');
  });

  it('text with a selector list returns every match, not just the first', async () => {
    doc.body.append(doc.el('h1', {}, 'Title'), doc.el('p', {}, 'Body'), doc.el('span', { class: 'price' }, '42 SAR'));
    const res = await handleGetPageText({ tabId: 1, selector: 'h1, .price' });
    expect(res.text).toContain('Title');
    expect(res.text).toContain('42 SAR');
    expect(res.text).not.toContain('Body');
    expect(res.matches).toBe(2);
  });

  it('text with a selector skips nested matches and hidden duplicates', async () => {
    const outer = doc.el('div', { class: 'card' });
    outer.append(doc.el('div', { class: 'card' }, 'Inner'));
    const hidden = doc.el('div', { class: 'card' }, 'Hidden');
    hidden.hidden = true;
    doc.body.append(outer, hidden);
    const res = await handleGetPageText({ tabId: 1, selector: '.card' });
    expect(res.text.match(/Inner/g)).toHaveLength(1);
    expect(res.text).not.toContain('Hidden');
    expect(res.matches).toBeUndefined();
  });

  it('text with one selector match keeps the single-element shape', async () => {
    doc.body.append(doc.el('p', { id: 'only' }, 'Solo'));
    const res = await handleGetPageText({ tabId: 1, selector: '#only' });
    expect(res.text).toBe('Solo');
    expect(res.matches).toBeUndefined();
    expect(await handleGetPageText({ tabId: 1, selector: '#missing' })).toMatchObject({ success: false, error: 'Element not found' });
  });
});
