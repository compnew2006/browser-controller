import { beforeEach, describe, expect, it } from 'vitest';
import { installFakePage, installFakeFrame, type FakeDocument, type FakeElement } from './helpers/fake-dom.js';

// Slice U: browser_fill reaches a hidden file input through a selector, its label or the visible
// upload button (D.fileInputFor), the safety classifier sees the same upload, and the focused
// element is found by one shared deep-active walk (D.deepActiveElement).

const cdp: Array<{ method: string; params: Record<string, any> }> = [];

(globalThis as any).chrome = {
  tabs: { get: async (id: number) => ({ id, url: 'https://example.test/page', windowId: 1 }), query: async () => [], onRemoved: { addListener: () => {} } },
  scripting: {
    executeScript: async (o: { func: (...a: any[]) => unknown; args?: unknown[] }) => {
      const pageFn = new Function(`return (${o.func.toString()});`)() as (...a: any[]) => unknown;
      return [{ result: await pageFn(...(o.args ?? [])) }];
    },
  },
  storage: { session: { get: async () => ({}), set: async () => {} }, local: { get: async () => ({ agentCursor: false }), set: async () => {} } },
  debugger: {
    attach: async () => {},
    detach: async () => {},
    sendCommand: async (_t: unknown, method: string, params: Record<string, any> = {}) => {
      cdp.push({ method, params });
      return method === 'Runtime.evaluate' ? { result: { objectId: 'obj-1' } } : {};
    },
    onEvent: { addListener: () => {} },
    onDetach: { addListener: () => {} },
  },
};

const { PAGE_DOM_INSTALL, PAGE_DOM_VERSION } = await import('../extension/lib/page-dom.js');
const { handleFill } = await import('../extension/handlers/interaction-advanced.js');
const { handleClassifyAction } = await import('../extension/handlers/action-safety.js');
const { handleType } = await import('../extension/handlers/interaction.js');
const { detachCdp } = await import('../extension/lib/cdp-session.js');
const { fallbackByTab } = await import('../extension/lib/state.js');

let doc: FakeDocument;
const D = () => (globalThis as any).__bcDom;
const setFiles = () => cdp.filter((c) => c.method === 'DOM.setFileInputFiles');
const hiddenFile = (attrs: Record<string, string> = {}) => doc.el('input', { type: 'file', style: 'display:none', ...attrs });

beforeEach(async () => {
  cdp.length = 0;
  await detachCdp(1);
  doc = installFakePage();
  (globalThis as any).innerWidth = 1000;
  (globalThis as any).innerHeight = 700;
  fallbackByTab.clear();
  PAGE_DOM_INSTALL(PAGE_DOM_VERSION);
});

describe('D.fileInputFor: which file input an element controls', () => {
  it('1. the element itself', () => {
    const f = hiddenFile();
    doc.body.append(f);
    expect(D().fileInputFor(f)).toBe(f);
  });

  it('2. a label controls its file input', () => {
    const f = hiddenFile({ id: 'g' });
    const label = doc.el('label', { for: 'g' }, 'Attach');
    (label as any).control = f;
    doc.body.append(label, f);
    expect(D().fileInputFor(label)).toBe(f);
  });

  it('2. a label whose control is not a file input maps to nothing', () => {
    const t = doc.el('input', { id: 't', type: 'text' });
    const label = doc.el('label', { for: 't' }, 'Name');
    (label as any).control = t;
    doc.body.append(label, t);
    expect(D().fileInputFor(label)).toBeNull();
  });

  it('3. a file input inside the element', () => {
    const f = hiddenFile();
    const wrap = doc.el('div', {}, f);
    doc.body.append(wrap);
    expect(D().fileInputFor(wrap)).toBe(f);
  });

  it('4. Odoo: the button next to a d-none file input', () => {
    const btn = doc.el('button', { type: 'submit' }, 'Upload');
    const f = hiddenFile({ class: 'd-none' });
    doc.body.append(doc.el('span', { class: 'o_file_input' }, btn, f));
    expect(D().fileInputFor(btn)).toBe(f);
  });

  it('4. an ancestor with two file inputs is ambiguous: nothing', () => {
    const btn = doc.el('button', {}, 'Upload');
    doc.body.append(doc.el('span', {}, btn, hiddenFile(), hiddenFile()));
    expect(D().fileInputFor(btn)).toBeNull();
  });

  it('4. only three levels up are searched', () => {
    const btn = doc.el('button', {}, 'Upload');
    const f = hiddenFile();
    const l1 = doc.el('div', {}, btn);
    const l2 = doc.el('div', {}, l1);
    const l3 = doc.el('div', {}, l2);
    doc.body.append(doc.el('div', {}, l3, f)); // 4th ancestor holds the input
    expect(D().fileInputFor(btn)).toBeNull();
    const l3b = doc.el('div', {}, doc.el('div', {}, doc.el('button', {}, 'Go')), hiddenFile());
    doc.body.append(l3b);
    const go = l3b.children[0].children[0];
    expect(D().fileInputFor(go)).not.toBeNull(); // 2 levels up
  });

  it('5. a text field beside a file input is not a file field', () => {
    const t = doc.el('input', { type: 'text', id: 'name' });
    doc.body.append(doc.el('div', {}, t, hiddenFile()));
    expect(D().fileInputFor(t)).toBeNull();
  });

  it('5. an ARIA form control beside a file input is not a file field', () => {
    for (const role of ['switch', 'checkbox', 'radio', 'textbox', 'combobox', 'slider']) {
      const c = doc.el('div', { role, 'aria-checked': 'false' });
      doc.body.append(doc.el('span', {}, c, hiddenFile()));
      expect(D().fileInputFor(c), role).toBeNull();
    }
  });

  it('5. an element with no file input near it', () => {
    const b = doc.el('button', {}, 'Go');
    doc.body.append(b);
    expect(D().fileInputFor(b)).toBeNull();
  });
});

describe('resolveTarget: hidden file input by selector, for file use only', () => {
  it('with { file: true } a hidden input[type=file] resolves', () => {
    const f = hiddenFile({ id: 'up' });
    doc.body.append(f);
    expect(D().resolveTarget({ kind: 'selector', selector: 'input[type=file]' }, null, { file: true }).el).toBe(f);
  });

  it('without the option it stays ELEMENT_HIDDEN', () => {
    doc.body.append(hiddenFile());
    expect(D().resolveTarget({ kind: 'selector', selector: 'input[type=file]' }).error).toMatch(/^ELEMENT_HIDDEN: /);
  });

  it('with the option a hidden non-file element stays ELEMENT_HIDDEN', () => {
    doc.body.append(doc.el('input', { type: 'text', id: 'x', style: 'display:none' }));
    expect(D().resolveTarget({ kind: 'selector', selector: '#x' }, null, { file: true }).error).toMatch(/^ELEMENT_HIDDEN: /);
  });
});

describe('browser_fill reaches a hidden file input', () => {
  const PATH = ['/tmp/a.pdf'];

  it('by selector', async () => {
    const f = hiddenFile({ class: 'd-none' });
    doc.body.append(doc.el('span', { class: 'o_file_input' }, doc.el('button', { type: 'submit' }, 'Upload'), f));
    const res = await handleFill({ tabId: 1, fields: [{ target: 'input[type=file]', value: PATH }] });
    expect(res).toMatchObject({ success: true });
    expect(setFiles()[0]?.params).toEqual({ files: PATH, objectId: 'obj-1' });
    expect(f.attrs.has('data-bc-upload')).toBe(false);
  });

  it('by the visible upload button ref', async () => {
    const btn = doc.el('button', { type: 'submit' }, 'Upload');
    doc.body.append(doc.el('span', { class: 'o_file_input' }, btn, hiddenFile({ class: 'd-none' })));
    const ref = D().refFor(btn);
    const res = await handleFill({ tabId: 1, fields: [{ target: ref, value: PATH }] });
    expect(res).toMatchObject({ success: true });
    expect(setFiles()).toHaveLength(1);
  });

  it('by the label text', async () => {
    const f = hiddenFile({ id: 'g' });
    const label = doc.el('label', { for: 'g' }, 'Attach');
    (label as any).control = f;
    doc.body.append(label, f);
    const res = await handleFill({ tabId: 1, fields: [{ target: 'text=Attach', value: PATH }] });
    expect(res).toMatchObject({ success: true });
    expect(setFiles()).toHaveLength(1);
  });

  it('a hidden text field by selector is still ELEMENT_HIDDEN', async () => {
    doc.body.append(doc.el('input', { type: 'text', id: 'x', style: 'display:none' }));
    const res = await handleFill({ tabId: 1, fields: [{ target: '#x', value: 'hi' }] });
    expect(res.success).toBe(false);
    expect(res.error).toContain('ELEMENT_HIDDEN');
  });

  it('an ARIA switch beside a file input still fills as a switch, never as a file', async () => {
    const sw = doc.el('button', { id: 'sw', role: 'switch', 'aria-checked': 'false' }, 'Notify');
    doc.body.append(doc.el('span', {}, sw, hiddenFile({ class: 'd-none' })));
    const res = await handleFill({ tabId: 1, fields: [{ target: '#sw', value: true }] });
    expect(res.error ?? '').not.toMatch(/file/i);
    expect(setFiles()).toEqual([]);
    const cls = await handleClassifyAction({ tabId: 1, action: 'browser_fill', fields: [{ target: '#sw', value: true }] });
    expect(cls.categories).not.toContain('upload');
  });

  it('a plain button with no file input is still not a form field', async () => {
    doc.body.append(doc.el('button', { id: 'b' }, 'Go'));
    const res = await handleFill({ tabId: 1, fields: [{ target: '#b', value: PATH }] });
    expect(res.error).toContain('not a form field');
    expect(setFiles()).toEqual([]);
  });
});

describe('safety classifier: an upload through a visible target is an upload', () => {
  it('browser_fill on the visible button reports upload (SECURITY)', async () => {
    const btn = doc.el('button', { id: 'up', type: 'submit' }, 'Upload');
    doc.body.append(doc.el('span', {}, btn, hiddenFile({ class: 'd-none' })));
    const res = await handleClassifyAction({ tabId: 1, action: 'browser_fill', fields: [{ target: '#up', value: ['/tmp/a.pdf'] }] });
    expect(res.categories).toContain('upload');
  });

  it('browser_fill on a hidden file input by selector reports upload', async () => {
    doc.body.append(hiddenFile());
    const res = await handleClassifyAction({ tabId: 1, action: 'browser_fill', fields: [{ target: 'input[type=file]', value: ['/tmp/a.pdf'] }] });
    expect(res.categories).toContain('upload');
  });

  it('browser_fill on a label reports upload', async () => {
    const f = hiddenFile({ id: 'g' });
    const label = doc.el('label', { for: 'g' }, 'Attach');
    (label as any).control = f;
    doc.body.append(label, f);
    const res = await handleClassifyAction({ tabId: 1, action: 'browser_fill', fields: [{ target: 'text=Attach', value: ['/tmp/a.pdf'] }] });
    expect(res.categories).toContain('upload');
  });

  it('browser_fill on a text field next to a file input is not an upload', async () => {
    doc.body.append(doc.el('div', {}, doc.el('input', { type: 'text', id: 'n' }), hiddenFile()));
    const res = await handleClassifyAction({ tabId: 1, action: 'browser_fill', fields: [{ target: '#n', value: 'x' }] });
    expect(res.categories).not.toContain('upload');
  });

  it('browser_click on a hidden file input by selector is still ELEMENT_HIDDEN', async () => {
    doc.body.append(hiddenFile());
    await expect(handleClassifyAction({ tabId: 1, action: 'browser_click', target: 'input[type=file]' })).rejects.toThrow(/ELEMENT_HIDDEN/);
  });

  it('classifier fingerprints feed handleFill unchanged (same element, same selector rule)', async () => {
    const f = hiddenFile({ class: 'd-none' });
    doc.body.append(doc.el('span', {}, doc.el('button', { id: 'up' }, 'Upload'), f));
    for (const target of ['input[type=file]', '#up']) {
      cdp.length = 0;
      const fields = [{ target, value: ['/tmp/a.pdf'] }];
      const { fingerprints } = await handleClassifyAction({ tabId: 1, action: 'browser_fill', fields });
      expect(fingerprints).toHaveLength(1);
      const res = await handleFill({ tabId: 1, fields, expectFingerprints: fingerprints });
      expect(res).toMatchObject({ success: true });
      expect(setFiles()).toHaveLength(1);
    }
  });
});

describe('D.deepActiveElement: one walk for the classifier and pageLocate', () => {
  /** A host whose root is closed: only chrome.dom.openOrClosedShadowRoot reaches it. */
  function closedRoot(host: FakeElement, inner: FakeElement | null) {
    const root = { nodeType: 11, activeElement: inner };
    (globalThis as any).chrome.dom = { openOrClosedShadowRoot: (el: unknown) => (el === host ? root : null) };
    return root;
  }

  it('enters a closed shadow root', () => {
    const host = doc.el('div', {});
    const inner = doc.el('input', { type: 'text' });
    doc.body.append(host);
    closedRoot(host, inner);
    doc.activeElement = host;
    expect(D().deepActiveElement()).toBe(inner);
  });

  it('never enters the vault approval card’s closed root (specs/006 FR-005)', () => {
    const host = doc.el('bc-vault-approval', {});
    (host as any).__bcVaultHost = true;
    const allow = doc.el('button', {});
    doc.body.append(host);
    closedRoot(host, allow);
    doc.activeElement = host;
    expect(D().deepActiveElement()).toBe(host);
  });

  it('enters an open shadow root and a same-origin frame with focus', () => {
    const host = doc.el('div', {});
    const inner = doc.el('input', { type: 'text' });
    host.attachShadow();
    doc.body.append(host);
    Object.defineProperty(host.shadowRoot, 'activeElement', { value: inner });
    doc.activeElement = host;
    expect(D().deepActiveElement()).toBe(inner);
    const frame = doc.el('iframe', {});
    doc.body.append(frame);
    const inDoc = installFakeFrame(frame);
    const field = inDoc.el('input', {});
    inDoc.body.append(field);
    field.focus();
    doc.activeElement = frame;
    expect(D().deepActiveElement()).toBe(field);
  });

  it('classifier fingerprints the element inside a closed root, and a typed Enter then passes', async () => {
    const host = doc.el('div', {});
    const inner = doc.el('input', { type: 'text', id: 'in' });
    doc.body.append(host);
    closedRoot(host, inner);
    doc.activeElement = host;
    const res = await handleClassifyAction({ tabId: 1, action: 'browser_type', key: 'Enter' });
    expect(res.fingerprints).toEqual([D().safetyFingerprint(inner)]);
    // The dispatch-time check (pageLocate) walks to the same element: no SAFETY_TARGET_CHANGED.
    await expect(handleType({ tabId: 1, key: 'Enter', expectFingerprints: res.fingerprints })).resolves.not.toMatchObject({ error: expect.stringContaining('SAFETY_TARGET_CHANGED') });
  });
});
