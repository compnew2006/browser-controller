import { beforeEach, describe, expect, it } from 'vitest';

// WP2b: browser_drag (stale start point) and browser_fill_form (submit target).
// The injected page functions run in this process against a small fake page:
// a scrollable document (scroll position models the viewport), and form fields
// that record what the page would have seen.

const cdp: Array<{ method: string; params: Record<string, unknown> }> = [];

/** Document scroll offset of the fake page; the viewport is 1000×700. */
let scrollY = 0;

class FakeTarget {
  submitClicks = 0;
  value = '';
  focused = false;
  type = '';
  tagName = 'INPUT';
  isContentEditable = false;
  checked = false;
  form: FakeForm | null = null;
  constructor(public docTop: number, public left = 10) {}
  getBoundingClientRect() {
    return { left: this.left, top: this.docTop - scrollY, width: 100, height: 40, right: 0, bottom: 0 };
  }
  scrollIntoView() { scrollY = this.docTop + 20 - 350; } // centres the element
  focus() { this.focused = true; }
  dispatchEvent() { return true; }
  click() { this.submitClicks += 1; }
}

class FakeForm {
  elements: FakeTarget[] = [];
  requestCalls: Array<FakeTarget | null> = [];
  submitted = 0;
  submitCalled = false;
  blockSubmit = false;
  private listeners: Array<() => void> = [];
  addEventListener(type: string, listener: () => void) { if (type === 'submit') this.listeners.push(listener); }
  removeEventListener(type: string, listener: () => void) { this.listeners = this.listeners.filter((l) => l !== listener); }
  requestSubmit(submitter?: FakeTarget) {
    this.requestCalls.push(submitter ?? null);
    if (this.blockSubmit) return;
    this.submitted += 1;
    for (const listener of [...this.listeners]) listener();
  }
  submit() { this.submitCalled = true; }
  querySelector() {
    return this.elements.find((el) => el.type === 'submit') ?? null;
  }
}

/** The page's own form, which a submit must never touch when the fields belong elsewhere. */
const unrelatedForm = new FakeForm();
const fieldsByRef = new Map<string, FakeTarget>();

const runInPage = async (opts: { func: (...args: unknown[]) => unknown; args?: unknown[] }) => [{ result: opts.func(...(opts.args ?? [])) }];

(globalThis as unknown as { chrome: unknown }).chrome = {
  tabs: {
    get: async (id: number) => ({ id, url: 'https://example.test/', windowId: 1 }),
    onRemoved: { addListener: () => {} },
  },
  scripting: { executeScript: runInPage },
  storage: {
    session: { get: async () => ({}), set: async () => {} },
    local: { get: async () => ({}), set: async () => {} },
  },
  debugger: {
    attach: async () => {},
    detach: async () => {},
    sendCommand: async (_t: unknown, method: string, params: Record<string, unknown> = {}) => {
      cdp.push({ method, params });
      return {};
    },
    onDetach: { addListener: () => {} },
  },
};

Object.assign(globalThis, {
  window: globalThis,
  innerWidth: 1000,
  innerHeight: 700,
  HTMLInputElement: class {},
  HTMLTextAreaElement: class {},
  HTMLSelectElement: class {},
  document: {
    getElementById: () => null,
    querySelector: () => unrelatedForm,
    execCommand: () => true,
    activeElement: null,
    body: null,
  },
  __bcDom: {
    v: 1,
    resolve: (ref: string | undefined) => ({ el: ref ? fieldsByRef.get(ref) ?? null : null }),
    centerOf: (el: FakeTarget) => {
      const rect = el.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, rect };
    },
  },
});

const { handleDrag, handleFillForm } = await import('../extension/handlers/interaction-advanced.js');
const inputs = () => cdp.filter((c) => c.method.startsWith('Input.'));

beforeEach(() => {
  cdp.length = 0;
  scrollY = 0;
  fieldsByRef.clear();
  unrelatedForm.requestCalls = [];
  unrelatedForm.submitted = 0;
  unrelatedForm.submitCalled = false;
});

describe('browser_drag: the start point is measured after the last scroll', () => {
  it('fails with TARGET_OFFSCREEN and presses nothing when the drop target cannot share the viewport with the source', async () => {
    // Source near the top, target 2000 px down: revealing the target moves the source out of view.
    fieldsByRef.set('src', new FakeTarget(100));
    fieldsByRef.set('dst', new FakeTarget(2000));

    const result = await handleDrag({ tabId: 5, startRef: 'src', endRef: 'dst', steps: 2 });

    expect(result).toMatchObject({ success: false, error: expect.stringMatching(/^TARGET_OFFSCREEN/) });
    expect(inputs()).toEqual([]);
  });

  it('drags between two in-view points, at the coordinates measured after scrolling', async () => {
    fieldsByRef.set('src', new FakeTarget(1000));
    fieldsByRef.set('dst', new FakeTarget(1100));

    const result = await handleDrag({ tabId: 5, startRef: 'src', endRef: 'dst', steps: 1 });

    expect(result).toMatchObject({ success: true, from: { x: 60, y: 350 }, to: { x: 60, y: 450 } });
    expect(inputs().find((c) => c.params.type === 'mousePressed')?.params).toMatchObject({ x: 60, y: 350 });
    expect(inputs().find((c) => c.params.type === 'mouseReleased')?.params).toMatchObject({ x: 60, y: 450 });
  });
});

describe('browser_fill_form: submit targets the form that holds the filled fields', () => {
  it('submits the one form holding every field through requestSubmit with its submit button, not the page form', async () => {
    const form = new FakeForm();
    const name = new FakeTarget(100); name.form = form;
    const email = new FakeTarget(140); email.form = form; email.type = 'email';
    const send = new FakeTarget(180); send.form = form; send.type = 'submit';
    form.elements.push(name, email, send);
    fieldsByRef.set('name', name);
    fieldsByRef.set('email', email);

    const result = await handleFillForm({
      tabId: 5,
      fields: [{ ref: 'name', value: 'Ada' }, { ref: 'email', value: 'ada@example.test' }],
      submit: true,
    });

    expect(result).toMatchObject({ success: true, submitted: true });
    expect(form.requestCalls).toEqual([send]);
    expect(form.submitCalled).toBe(false);
    expect(send.submitClicks).toBe(0);
    expect(name.value).toBe('Ada');
    expect(unrelatedForm.requestCalls).toEqual([]);
  });

  it('fails with FORM_AMBIGUOUS when the fields span two forms, filling and submitting nothing', async () => {
    const first = new FakeForm();
    const second = new FakeForm();
    const a = new FakeTarget(100); a.form = first;
    const b = new FakeTarget(140); b.form = second;
    first.elements.push(a);
    second.elements.push(b);
    fieldsByRef.set('a', a);
    fieldsByRef.set('b', b);

    const result = await handleFillForm({ tabId: 5, fields: [{ ref: 'a', value: 'x' }, { ref: 'b', value: 'y' }], submit: true });

    expect(result).toMatchObject({ success: false, error: expect.stringMatching(/^FORM_AMBIGUOUS/) });
    expect(a.value).toBe('');
    expect(b.value).toBe('');
    expect(first.requestCalls).toEqual([]);
    expect(second.requestCalls).toEqual([]);
  });

  it('fails with NO_FORM when no field is inside a form, and never submits the page form', async () => {
    const loose = new FakeTarget(100); // no form
    fieldsByRef.set('loose', loose);

    const result = await handleFillForm({ tabId: 5, fields: [{ ref: 'loose', value: 'x' }], submit: true });

    expect(result).toMatchObject({ success: false, error: expect.stringMatching(/^NO_FORM/) });
    expect(loose.value).toBe('');
    expect(unrelatedForm.requestCalls).toEqual([]);
    expect(unrelatedForm.submitCalled).toBe(false);
  });

  it('a lone text field submits its form with requestSubmit() when there is no submit button', async () => {
    const form = new FakeForm();
    const search = new FakeTarget(100); search.form = form; search.type = 'search';
    form.elements.push(search);
    fieldsByRef.set('search', search);

    const result = await handleFillForm({ tabId: 5, fields: [{ ref: 'search', value: 'lamps' }], submit: true });

    expect(result).toMatchObject({ success: true, submitted: true });
    expect(form.requestCalls).toEqual([null]);
    expect(form.submitCalled).toBe(false);
  });

  it('reports SUBMIT_BLOCKED when constraint validation stops the submit', async () => {
    const form = new FakeForm();
    form.blockSubmit = true;
    const name = new FakeTarget(100); name.form = form;
    form.elements.push(name);
    fieldsByRef.set('name', name);

    const result = await handleFillForm({ tabId: 5, fields: [{ ref: 'name', value: 'Ada' }], submit: true });

    expect(result).toMatchObject({ success: false, error: expect.stringMatching(/^SUBMIT_BLOCKED/), submitted: false });
    expect(name.value).toBe('Ada');
  });

  it('a field that fails to fill blocks the submit: a partly filled form is not sent', async () => {
    const form = new FakeForm();
    const name = new FakeTarget(100); name.form = form;
    const send = new FakeTarget(140); send.form = form; send.type = 'submit';
    form.elements.push(name, send);
    fieldsByRef.set('name', name);

    const result = await handleFillForm({
      tabId: 5,
      fields: [{ ref: 'name', value: 'Ada' }, { ref: 'missing', value: 'x' }],
      submit: true,
    });

    expect(result).toMatchObject({ success: false, error: expect.stringContaining('the form was not submitted') });
    expect(form.requestCalls).toEqual([]);
  });

  it('without submit, filling is unchanged and nothing is submitted', async () => {
    const form = new FakeForm();
    const name = new FakeTarget(100); name.form = form;
    form.elements.push(name);
    fieldsByRef.set('name', name);

    const result = await handleFillForm({ tabId: 5, fields: [{ ref: 'name', value: 'Ada' }] });

    expect(result).toEqual({ success: true, fields: [{ selector: 'name', success: true, value: 'Ada' }] });
    expect(name.value).toBe('Ada');
    expect(form.requestCalls).toEqual([]);
  });
});
