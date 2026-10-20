import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installFakePage, type FakeDocument, type FakeElement } from './helpers/fake-dom.js';

// chrome mock. executeScript runs the page function in-process against the fake page.
// The debugger attaches only when `cdpOk` is set, so each test picks the CDP or the synthetic path.
const cdp: Array<{ method: string; params: Record<string, unknown> }> = [];
let cdpOk = false;
(globalThis as any).chrome = {
  tabs: { get: async (id: number) => ({ id, url: 'https://example.test/page', windowId: 1 }), query: async () => [], onRemoved: { addListener: () => {} } },
  scripting: { executeScript: async (o: { func: (...a: any[]) => unknown; args?: unknown[] }) => [{ result: await o.func(...(o.args ?? [])) }] },
  storage: { session: { get: async () => ({}), set: async () => {} }, local: { get: async () => ({}), set: async () => {} } },
  debugger: {
    attach: async () => { if (!cdpOk) throw new Error('no debugger in tests'); },
    detach: async () => {},
    sendCommand: async (_t: unknown, method: string, params: Record<string, unknown> = {}) => { cdp.push({ method, params }); return {}; },
    onDetach: { addListener: () => {} },
  },
};

const { PAGE_DOM_INSTALL, PAGE_DOM_VERSION } = await import('../extension/lib/page-dom.js');
const { handleClick } = await import('../extension/handlers/interaction.js');
const { handleHover, handleSelect } = await import('../extension/handlers/interaction.js');
const { handlePressKey } = await import('../extension/handlers/interaction-keys.js');
const { handleFillForm } = await import('../extension/handlers/interaction-advanced.js');
const { handleSnapshot } = await import('../extension/handlers/inspection.js');
const { detachCdp } = await import('../extension/lib/cdp-session.js');
const { fallbackByTab } = await import('../extension/lib/state.js');

let doc: FakeDocument;
const D = () => (globalThis as any).__bcDom;

/** The page's hit-test, as the browser answers it: topmost first. */
function stackAt(...topmostFirst: FakeElement[]) {
  (doc as any).elementsFromPoint = () => topmostFirst;
}

/** Computed style with opacity, so the fake page can express an opacity:0 control. */
function styled(el: FakeElement) {
  const style = el.attrs.get('style') || '';
  return {
    display: el.isHiddenInTree ? 'none' : 'block',
    visibility: 'visible',
    opacity: style.includes('opacity:0') ? '0' : '1',
    overflowY: 'visible',
    overflowX: 'visible',
    whiteSpace: 'normal',
  };
}

function install() {
  doc = installFakePage();
  (globalThis as any).NodeFilter = { SHOW_ELEMENT: 1 };
  (doc as any).createTreeWalker = () => {
    const nodes: FakeElement[] = [];
    const visit = (n: FakeElement) => { for (const c of n.children) { nodes.push(c); visit(c); } };
    visit(doc.body);
    let i = 0;
    return { nextNode: () => nodes[i++] ?? null };
  };
  doc.defaultView.getComputedStyle = (el: FakeElement) => styled(el) as any;
  fallbackByTab.clear();
  PAGE_DOM_INSTALL(PAGE_DOM_VERSION);
}

/**
 * The custom checkbox pattern: a transparent native checkbox under a styled label.
 * The label is wider and to the right, so a click on the label's centre is visibly different
 * from a click on the checkbox's own centre.
 */
function customCheckbox(id = 'remember', labelText = 'Remember me') {
  const label = doc.el('label', { for: id }, labelText);
  (label as any).getBoundingClientRect = () => ({ left: 30, top: 10, width: 100, height: 20, right: 130, bottom: 30, x: 30, y: 10 });
  const box = doc.el('input', { type: 'checkbox', id, style: 'opacity:0' });
  (box as any).getBoundingClientRect = () => ({ left: 10, top: 10, width: 10, height: 10, right: 20, bottom: 20, x: 10, y: 10 });
  Object.defineProperty(box, 'labels', { value: [label], configurable: true });
  doc.body.append(box, label);
  return { box, label };
}

describe('custom checkbox: browser_snapshot lists a transparent control whose label is visible', () => {
  beforeEach(install);

  it('the opacity:0 checkbox is listed with its role, name, checked state and a ref', async () => {
    const { box } = customCheckbox();
    box.checked = true;
    const res = await handleSnapshot({ tabId: 1, compact: false });
    const flat: any[] = [];
    const walk = (n: any) => { if (!n) return; if (Array.isArray(n)) return n.forEach(walk); flat.push(n); walk(n.children); };
    walk(res.tree);
    const control = flat.find((n) => n.role === 'checkbox');
    expect(control).toMatchObject({ role: 'checkbox', name: 'Remember me', checked: true });
    expect(control.ref).toMatch(/^s/);
  });

  it('the same control is omitted when its label is hidden (nothing a person could see)', async () => {
    const { label } = customCheckbox();
    label.hidden = true;
    const res = await handleSnapshot({ tabId: 1, compact: false });
    expect(JSON.stringify(res.tree)).not.toContain('"role":"checkbox"');
  });

  it('a transparent checkbox inside a <label> that names another control is not listed', async () => {
    const wrap = doc.el('label', { for: 'other' }, 'Other field');
    const box = doc.el('input', { type: 'checkbox', id: 'stray', style: 'opacity:0' });
    (box as any).getBoundingClientRect = () => ({ left: 10, top: 10, width: 10, height: 10, right: 20, bottom: 20, x: 10, y: 10 });
    wrap.append(box);
    doc.body.append(wrap);
    expect(D().labelsOf(box)).toEqual([]);
    const res = await handleSnapshot({ tabId: 1, compact: false });
    expect(JSON.stringify(res.tree)).not.toContain('"role":"checkbox"');
  });

  it('an opacity:0 button stays omitted: only checkboxes and radios are exempt', async () => {
    doc.body.append(doc.el('button', { style: 'opacity:0' }, 'Fading out'));
    const res = await handleSnapshot({ tabId: 1 });
    expect(JSON.stringify(res.tree)).not.toContain('Fading out');
  });
});

describe('custom checkbox: browser_click reaches the control through its visible label', () => {
  beforeEach(install);

  it('synthetic path: the click is dispatched on the label, the checkbox gets none, and the result says via label', async () => {
    const { box, label } = customCheckbox();
    stackAt(label, box);
    const res = await handleClick({ tabId: 1, selector: '#remember' });
    expect(res).toMatchObject({ success: true, via: 'label', at: { x: 80, y: 20 } });
    expect(label.events).toContain('click');
    expect(box.events).not.toContain('click');
  });

  it('CDP path: the real mouse click lands on the label centre and the result says via label', async () => {
    cdpOk = true;
    await detachCdp(1);
    cdp.length = 0;
    const { box, label } = customCheckbox();
    stackAt(label, box);
    const res = await handleClick({ tabId: 1, selector: '#remember' });
    expect(res).toMatchObject({ success: true, input: 'cdp', via: 'label', at: { x: 80, y: 20 } });
    const pressed = cdp.filter((c) => c.method === 'Input.dispatchMouseEvent' && c.params.type === 'mousePressed');
    expect(pressed).toHaveLength(1);
    expect(pressed[0].params).toMatchObject({ x: 80, y: 20 });
    await detachCdp(1);
    cdpOk = false;
  });

  it('a transparent checkbox that is itself on top is clicked directly, not through its label', async () => {
    const { box, label } = customCheckbox();
    stackAt(box, label);
    const res = await handleClick({ tabId: 1, selector: '#remember' });
    expect(res).toMatchObject({ success: true, at: { x: 15, y: 15 } });
    expect(res.via).toBe('selector'); // how the element was resolved, not a label click
    expect(box.events).toContain('click');
    expect(label.events).not.toContain('click');
  });

  it('the click check passes a label hit as not covered (clickBlocker)', () => {
    const { box, label } = customCheckbox();
    stackAt(label, box);
    expect(D().clickBlocker(box)).toBeNull();
  });

  it('a radio is handled the same way', async () => {
    const label = doc.el('label', { for: 'pick-a' }, 'Option A');
    (label as any).getBoundingClientRect = () => ({ left: 30, top: 10, width: 100, height: 20, right: 130, bottom: 30, x: 30, y: 10 });
    const radio = doc.el('input', { type: 'radio', id: 'pick-a', style: 'opacity:0' });
    (radio as any).getBoundingClientRect = () => ({ left: 10, top: 10, width: 10, height: 10, right: 20, bottom: 20, x: 10, y: 10 });
    Object.defineProperty(radio, 'labels', { value: [label], configurable: true });
    doc.body.append(radio, label);
    stackAt(label, radio);
    const res = await handleClick({ tabId: 1, selector: '#pick-a' });
    expect(res).toMatchObject({ success: true, via: 'label' });
    expect(label.events).toContain('click');
  });

  it('an unrelated overlay on the checkbox is still ELEMENT_COVERED, and nothing is clicked', async () => {
    const { box, label } = customCheckbox();
    const cover = doc.el('div', { class: 'promo-banner' });
    doc.body.append(cover);
    stackAt(cover, box);
    const res = await handleClick({ tabId: 1, selector: '#remember' });
    expect(res).toMatchObject({ success: false, error: expect.stringMatching(/^ELEMENT_COVERED: .*div\.promo-banner/) });
    expect(box.events).not.toContain('click');
    expect(label.events).not.toContain('click');
  });

  it('an overlay on the label itself is ELEMENT_COVERED, not a label click', async () => {
    const { box, label } = customCheckbox();
    const cover = doc.el('div', { class: 'modal' });
    doc.body.append(cover);
    stackAt(cover, label, box);
    const res = await handleClick({ tabId: 1, selector: '#remember' });
    expect(res).toMatchObject({ success: false, error: expect.stringMatching(/^ELEMENT_COVERED: /) });
    expect(label.events).not.toContain('click');
  });

  it('a hidden (display:none) checkbox is still ELEMENT_HIDDEN even with a visible label', async () => {
    const { box, label } = customCheckbox();
    box.hidden = true;
    stackAt(label);
    const res = await handleClick({ tabId: 1, selector: '#remember' });
    expect(res).toMatchObject({ success: false, error: expect.stringMatching(/^ELEMENT_HIDDEN: /) });
    expect(label.events).not.toContain('click');
  });
});

describe('browser_click: the lock shield is never restyled by the agent input path', () => {
  beforeEach(install);

  it('a CDP click leaves the shield style untouched (no pointerEvents write in either direction)', async () => {
    cdpOk = true;
    await detachCdp(1);
    const shield = doc.el('div', { id: '__bc-lock-shield' });
    (shield as any).style = {};
    doc.body.append(shield);
    const btn = doc.el('button', { id: 'ok' }, 'OK');
    doc.body.append(btn);
    stackAt(btn);
    const res = await handleClick({ tabId: 1, selector: '#ok' });
    expect(res).toMatchObject({ success: true, input: 'cdp' });
    expect((shield as any).style).toEqual({});
    expect((globalThis as any).__bcAgentInputUntil).toBe(0);
    await detachCdp(1);
    cdpOk = false;
  });
});

describe('stale and unknown refs: one wording for every ref tool', () => {
  beforeEach(install);

  it('browser_hover: a ref never issued here is REF_NOT_FOUND (was "Element not found")', async () => {
    doc.body.append(doc.el('button', {}, 'Menu'));
    const res = await handleHover({ tabId: 1, ref: 'e5' });
    expect(res).toMatchObject({ success: false, error: expect.stringMatching(/^REF_NOT_FOUND: ref e5 /) });
  });

  it('browser_hover: a selector that matches nothing gets the selector message', async () => {
    const res = await handleHover({ tabId: 1, selector: '#nothing-here' });
    expect(res).toMatchObject({ success: false, error: 'No element matches selector #nothing-here on the current page (https://example.test/page).' });
  });

  it('browser_select: a ref issued earlier whose element is gone is REF_GONE', async () => {
    fallbackByTab.set(1, new Map([['sgone-0', { text: 'Colour', role: 'combobox', tag: 'SELECT', nth: 0 }]]));
    const res = await handleSelect({ tabId: 1, ref: 'sgone-0', value: 'red' });
    expect(res).toMatchObject({ success: false, error: expect.stringMatching(/^REF_GONE: ref sgone-0 /) });
  });

  it('browser_press_key: an unknown ref fails with REF_NOT_FOUND instead of pressing on the wrong control', async () => {
    doc.body.append(doc.el('input', {}));
    const res = await handlePressKey({ tabId: 1, ref: 'e9', key: 'Enter' });
    expect(res).toMatchObject({ success: false, error: expect.stringMatching(/^REF_NOT_FOUND: ref e9 /) });
    expect(doc.body.events).toEqual([]);
  });

  it('browser_press_key: a selector that matches nothing keeps the plain selector message', async () => {
    const res = await handlePressKey({ tabId: 1, selector: '#missing', key: 'Enter' });
    expect(res).toMatchObject({ success: false, error: 'No element matches selector #missing on the current page (https://example.test/page).' });
  });

  it('browser_fill_form: a field with neither ref nor selector says so', async () => {
    const res = await handleFillForm({ tabId: 1, fields: [{ value: 'x' }] });
    expect(res.fields[0]).toMatchObject({ success: false, error: 'ref or selector is required (get refs from browser_snapshot).' });
  });

  it('browser_fill_form: each field that does not resolve gets the same wording, in its own result', async () => {
    doc.body.append(doc.el('input', { id: 'real' }));
    const res = await handleFillForm({
      tabId: 1,
      fields: [{ ref: 'e7', value: 'x' }, { selector: '#missing', value: 'y' }, { selector: '#real', value: 'z' }],
    });
    expect(res.success).toBe(false);
    expect(res.fields[0]).toMatchObject({ success: false, error: expect.stringMatching(/^REF_NOT_FOUND: ref e7 /) });
    expect(res.fields[1]).toMatchObject({ success: false, error: 'No element matches selector #missing on the current page (https://example.test/page).' });
    expect(res.fields[2]).toMatchObject({ success: true, value: 'z' });
  });
});
