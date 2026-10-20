import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  PAGE_ACT_V2,
  PAGE_OBSERVE_V2,
  PAGE_V2_INSTALL,
} from '../extension/lib/observation-v2.js';

// WP2b regression tests for the page-side browser_act / browser_observe
// pipeline: occlusion through the extension's own overlays, mouse-order pointer
// events, Enter submission, navigation detection, OBSERVATION_EXPIRED, and the
// checked/actionable semantics of browser_observe.

/** An event as the page runtime builds it: its init, and a cancel bit handlers may set. */
class FakeEvent {
  defaultPrevented = false;
  constructor(public type: string, public init: Record<string, any> = {}) {}
  preventDefault() { this.defaultPrevented = true; }
}

class FakeForm {
  elements: FakeElement[] = [];
  /** Calls to requestSubmit, with the submitter it was given (null: none). */
  requestCalls: Array<FakeElement | null> = [];
  /** Submit events that actually fired. */
  submitted = 0;
  submitCalled = false;
  /** Constraint validation stops the submit: no event fires. */
  blockSubmit = false;
  private listeners: Array<() => void> = [];

  addEventListener(type: string, listener: () => void) { if (type === 'submit') this.listeners.push(listener); }
  removeEventListener(type: string, listener: () => void) { this.listeners = this.listeners.filter((l) => l !== listener); }
  requestSubmit(submitter?: FakeElement) {
    this.requestCalls.push(submitter ?? null);
    if (this.blockSubmit) return;
    this.submitted += 1;
    for (const listener of [...this.listeners]) listener();
  }
  submit() { this.submitCalled = true; }
  querySelector() {
    return this.elements.find((el) => el.tagName === 'BUTTON' && (el.type === '' || el.type === 'submit')) ?? null;
  }
  getAttribute() { return null; }
}

class FakeElement {
  tagName: string;
  type: string;
  id: string;
  value = '';
  innerText: string;
  textContent: string;
  ownerDocument: FakeDocument;
  root: any;
  attrs = new Map<string, string>();
  /** Every event dispatched here, in order, with its init. */
  log: Array<{ type: string; init: Record<string, any> }> = [];
  /** Per-type handlers a test attaches; they may cancel with preventDefault(). */
  handlers: Record<string, (event: FakeEvent) => void> = {};
  style: Record<string, string> = { display: 'block', visibility: 'visible', opacity: '1', pointerEvents: 'auto' };
  isConnected = true;
  hidden = false;
  disabled = false;
  readOnly = false;
  checked = false;
  selected = false;
  multiple = false;
  isContentEditable = false;
  tabIndex = -1;
  scrollHeight = 20;
  clientHeight = 20;
  scrollWidth = 100;
  clientWidth = 100;
  parentElement: FakeElement | null = null;
  shadowRoot: any = null;
  contentDocument: any = null;
  options: FakeElement[] = [];
  labels: FakeElement[] = [];
  form: FakeForm | null = null;
  rect = { left: 10, top: 20, width: 120, height: 32 };
  focused = false;

  constructor(document: FakeDocument, tagName: string, text = '', attrs: Record<string, string> = {}) {
    this.ownerDocument = document;
    this.root = document;
    this.tagName = tagName.toUpperCase();
    this.type = attrs.type || '';
    this.id = attrs.id || '';
    this.innerText = text;
    this.textContent = text;
    for (const [key, value] of Object.entries(attrs)) this.attrs.set(key, value);
    if (['BUTTON', 'A', 'INPUT', 'TEXTAREA', 'SELECT'].includes(this.tagName)) this.tabIndex = 0;
  }

  get events() { return this.log.map((entry) => entry.type); }
  getAttribute(name: string) { return this.attrs.get(name) ?? null; }
  hasAttribute(name: string) { return this.attrs.has(name); }
  setAttribute(name: string, value: string) { this.attrs.set(name, value); }
  getBoundingClientRect() { return { ...this.rect, right: this.rect.left + this.rect.width, bottom: this.rect.top + this.rect.height }; }
  getRootNode() { return this.root; }
  dispatchEvent(event: FakeEvent) {
    this.log.push({ type: event.type, init: event.init });
    this.handlers[event.type]?.(event);
    return !event.defaultPrevented;
  }
  focus() { this.focused = true; this.ownerDocument.activeElement = this; }
  scrollIntoView() {}
  scrollBy() {}
}

class FakeDocument {
  elements: FakeElement[] = [];
  title = 'Example';
  readyState = 'complete';
  body = { innerText: 'Continue', textContent: 'Continue' };
  documentElement = { clientWidth: 1000, clientHeight: 700, appendChild() {} };
  activeElement: FakeElement | null = null;
  defaultView: any;
  /** The single element a point hits, when `stack` is not given. */
  hit: FakeElement | null = null;
  /** Everything stacked at the probed point, topmost first. */
  stack: FakeElement[] | null = null;

  constructor() {
    this.defaultView = {
      innerWidth: 1000,
      innerHeight: 700,
      getComputedStyle: (element: FakeElement) => element.style,
      requestAnimationFrame: (callback: () => void) => callback(),
      Event: FakeEvent,
      MouseEvent: FakeEvent,
      PointerEvent: FakeEvent,
      KeyboardEvent: FakeEvent,
      HTMLInputElement: class {},
      HTMLTextAreaElement: class {},
    };
  }

  add(tag: string, text = '', attrs: Record<string, string> = {}) {
    const element = new FakeElement(this, tag, text, attrs);
    this.elements.push(element);
    return element;
  }
  getElementById(id: string) { return this.elements.find((element) => element.id === id) || null; }
  querySelectorAll() { return this.elements; }
  elementsFromPoint() { return this.stack ?? (this.hit ? [this.hit] : []); }
  elementFromPoint() { return this.elementsFromPoint()[0] ?? null; }
  getRootNode() { return this; }
  execCommand() { return true; }
}

const CLICK_EVENTS = [
  'pointerover', 'pointerenter', 'mouseover', 'mouseenter', 'pointermove', 'mousemove',
  'pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click',
];

const originalGlobals = {
  document: globalThis.document,
  location: globalThis.location,
  MutationObserver: globalThis.MutationObserver,
  innerWidth: (globalThis as any).innerWidth,
  innerHeight: (globalThis as any).innerHeight,
  scrollBy: (globalThis as any).scrollBy,
  requestAnimationFrame: globalThis.requestAnimationFrame,
};

function install(document: FakeDocument) {
  (globalThis as any).document = document;
  (globalThis as any).location = { href: 'https://example.test/form' };
  (globalThis as any).innerWidth = 1000;
  (globalThis as any).innerHeight = 700;
  (globalThis as any).scrollBy = () => {};
  (globalThis as any).requestAnimationFrame = (callback: () => void) => callback();
  delete (globalThis as any).__browserControllerObservationV2;
  PAGE_V2_INSTALL();
}

function observe(document: FakeDocument, snapshotId = 's_test') {
  install(document);
  return PAGE_OBSERVE_V2({
    snapshotId,
    sessionId: 'session-a',
    mode: 'compact',
    maxElements: 100,
    maxSnapshots: 10,
    ttlMs: 60_000,
    now: Date.now(),
  });
}

function act(observation: any, params: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return PAGE_ACT_V2({
    snapshotId: observation.snapshotId,
    sessionId: 'session-a',
    documentId: observation.documentId,
    routeEpoch: observation.routeEpoch,
    ttlMs: 60_000,
    ...extra,
    params,
  });
}

describe('WP2b browser_act: occlusion through the extension overlays', () => {
  beforeEach(() => { delete (globalThis as any).__browserControllerObservationV2; });
  afterEach(() => { delete (globalThis as any).__browserControllerObservationV2; });

  it('a real page element stacked over the target fails with ELEMENT_COVERED, even above the lock shield', async () => {
    const document = new FakeDocument();
    const button = document.add('button', 'Continue');
    const shield = document.add('div', '', { id: '__bc-lock-shield' });
    const banner = document.add('div', 'Promo banner', { role: 'dialog' });
    document.stack = [shield, banner, button];

    const result = await act(observe(document, 's_cover'), { action: 'click', ref: 'e1' });

    expect(result).toMatchObject({
      success: false,
      error: 'ELEMENT_COVERED',
      blockingElement: { role: 'dialog', name: 'Promo banner', tag: 'div' },
    });
    expect(button.events).toEqual([]);
  });

  it('the agent cursor overlay is skipped like the lock shield', async () => {
    const document = new FakeDocument();
    const button = document.add('button', 'Continue');
    const cursor = document.add('div', '', { id: '__bc-agent-cursor' });
    document.stack = [cursor, button];

    expect(await act(observe(document, 's_cursor'), { action: 'click', ref: 'e1' })).toMatchObject({ success: true });
    expect(button.events).toEqual(CLICK_EVENTS);
  });

  it('a covered hover is refused the same way', async () => {
    const document = new FakeDocument();
    const button = document.add('button', 'Continue');
    const overlay = document.add('div', 'Menu', { role: 'menu' });
    document.stack = [overlay, button];

    expect(await act(observe(document, 's_cover_hover'), { action: 'hover', ref: 'e1' })).toMatchObject({
      success: false,
      error: 'ELEMENT_COVERED',
    });
  });
});

describe('WP2b browser_act: pointer input and Enter', () => {
  beforeEach(() => { delete (globalThis as any).__browserControllerObservationV2; });
  afterEach(() => { delete (globalThis as any).__browserControllerObservationV2; });

  it('a synthetic click arrives as pointer events in mouse order, at the target centre', async () => {
    const document = new FakeDocument();
    const button = document.add('button', 'Continue');
    document.hit = button;

    await act(observe(document, 's_pointer'), { action: 'click', ref: 'e1' });

    expect(button.events).toEqual(CLICK_EVENTS);
    const init = (type: string) => button.log.find((entry) => entry.type === type)!.init;
    // Rect left 10, top 20, 120×32: the centre is (70, 36).
    expect(init('pointerdown')).toMatchObject({ clientX: 70, clientY: 36, buttons: 1, pointerType: 'mouse', pointerId: 1 });
    expect(init('pointerup')).toMatchObject({ clientX: 70, clientY: 36, buttons: 0 });
    expect(init('click')).toMatchObject({ clientX: 70, clientY: 36, detail: 1 });
  });

  it('Enter in a text field submits its form through the submit button (requestSubmit), never form.submit()', async () => {
    const document = new FakeDocument();
    const form = new FakeForm();
    const name = document.add('input', '', { type: 'text', placeholder: 'Name' });
    const send = document.add('button', 'Send');
    name.form = form;
    send.form = form;
    form.elements.push(name, send);

    const result = await act(observe(document, 's_enter'), { action: 'keypress', ref: 'e1', key: 'Enter' });

    expect(result).toMatchObject({ success: true, ok: true });
    expect(form.requestCalls).toEqual([send]);
    expect(form.submitted).toBe(1);
    expect(form.submitCalled).toBe(false);
    expect(send.events).not.toContain('click'); // requestSubmit, not a synthetic click on the button
  });

  it('Enter in the lone text field of a form submits it without a submit button', async () => {
    const document = new FakeDocument();
    const form = new FakeForm();
    const search = document.add('input', '', { type: 'search', placeholder: 'Find' });
    search.form = form;
    form.elements.push(search);

    await act(observe(document, 's_lone'), { action: 'keypress', ref: 'e1', key: 'Enter' });

    expect(form.requestCalls).toEqual([null]);
    expect(form.submitted).toBe(1);
  });

  it('Enter with several fields and no submit control does not submit, as in a browser', async () => {
    const document = new FakeDocument();
    const form = new FakeForm();
    const first = document.add('input', '', { type: 'text', placeholder: 'First' });
    const second = document.add('input', '', { type: 'email', placeholder: 'Email' });
    first.form = form;
    second.form = form;
    form.elements.push(first, second);

    expect(await act(observe(document, 's_several'), { action: 'keypress', ref: 'e1', key: 'Enter' })).toMatchObject({ success: true });
    expect(form.requestCalls).toEqual([]);
  });

  it('a canceled keydown produces no keypress and no implicit submission', async () => {
    const document = new FakeDocument();
    const form = new FakeForm();
    const name = document.add('input', '', { type: 'text', placeholder: 'Name' });
    const send = document.add('button', 'Send');
    name.form = form;
    send.form = form;
    form.elements.push(name, send);
    name.handlers.keydown = (event) => event.preventDefault();

    await act(observe(document, 's_cancel'), { action: 'keypress', ref: 'e1', key: 'Enter' });

    expect(form.requestCalls).toEqual([]);
    expect(name.events).not.toContain('keypress');
  });

  it('Enter in a textarea (newline) does not submit the form', async () => {
    const document = new FakeDocument();
    const form = new FakeForm();
    const notes = document.add('textarea', '');
    const send = document.add('button', 'Send');
    notes.form = form;
    send.form = form;
    form.elements.push(notes, send);

    await act(observe(document, 's_textarea'), { action: 'keypress', ref: 'e1', key: 'Enter' });

    expect(form.requestCalls).toEqual([]);
  });
});

describe('WP2b browser_act: navigation and observation expiry', () => {
  beforeEach(() => { delete (globalThis as any).__browserControllerObservationV2; });
  afterEach(() => { delete (globalThis as any).__browserControllerObservationV2; });

  it('reports a navigation the click starts, once its URL has changed', async () => {
    const document = new FakeDocument();
    const link = document.add('a', 'Next', { href: '/next' });
    document.hit = link;
    link.handlers.click = () => {
      setTimeout(() => { (globalThis as any).location.href = 'https://example.test/next'; }, 10);
    };

    const result = await act(observe(document, 's_nav'), { action: 'click', ref: 'e1' });

    expect(result).toMatchObject({
      success: true,
      navigationDetected: true,
      documentChanged: true,
      url: 'https://example.test/next',
    });
  });

  it('reports a navigation that starts during the action (beforeunload) before the URL changes, and cleans up', async () => {
    const listeners = new Map<string, Set<(event: unknown) => void>>();
    const target = globalThis as any;
    const savedAdd = target.addEventListener;
    const savedRemove = target.removeEventListener;
    target.addEventListener = (type: string, listener: (event: unknown) => void) => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(listener);
    };
    target.removeEventListener = (type: string, listener: (event: unknown) => void) => { listeners.get(type)?.delete(listener); };
    try {
      const document = new FakeDocument();
      const button = document.add('button', 'Go');
      document.hit = button;
      button.handlers.click = () => {
        setTimeout(() => {
          for (const listener of [...(listeners.get('beforeunload') ?? [])]) listener(new FakeEvent('beforeunload'));
        }, 10);
      };

      const result = await act(observe(document, 's_unload'), { action: 'click', ref: 'e1' });

      expect(result).toMatchObject({ success: true, navigationDetected: true, url: 'https://example.test/form' });
      expect(listeners.get('beforeunload')?.size ?? 0).toBe(0);
      expect(listeners.get('pagehide')?.size ?? 0).toBe(0);
    } finally {
      target.addEventListener = savedAdd;
      target.removeEventListener = savedRemove;
    }
  });

  it('a click that starts no navigation reports navigationDetected false', async () => {
    const document = new FakeDocument();
    document.hit = document.add('button', 'Continue');
    expect(await act(observe(document, 's_stay'), { action: 'click', ref: 'e1' })).toMatchObject({
      success: true,
      navigationDetected: false,
      documentChanged: false,
    });
  });

  it('an observation past its TTL fails with OBSERVATION_EXPIRED and says to observe again', async () => {
    const document = new FakeDocument();
    document.add('button', 'Continue');
    const observation = observe(document, 's_ttl');

    expect(await act(observation, { action: 'click', ref: 'e1' }, { ttlMs: -1 })).toMatchObject({
      success: false,
      error: 'OBSERVATION_EXPIRED',
      message: 'The observation expired after 0 s; call browser_observe again.',
    });
  });
});

describe('WP2b browser_observe: state, actionable widgets, no document observer', () => {
  beforeEach(() => { delete (globalThis as any).__browserControllerObservationV2; });
  afterEach(() => { delete (globalThis as any).__browserControllerObservationV2; });

  it('reports checked only for checkable controls (and aria-checked roles)', () => {
    const document = new FakeDocument();
    document.add('input', '', { type: 'text', placeholder: 'Name' });
    const box = document.add('input', '', { type: 'checkbox', 'aria-label': 'Agree' });
    box.checked = true;
    const toggle = document.add('div', 'Notify', { role: 'switch', 'aria-checked': 'true' });
    toggle.tabIndex = 0;

    const [text, checkbox, switchView] = observe(document, 's_checked').elements;

    expect(text.state).not.toHaveProperty('checked');
    expect(checkbox.state).toMatchObject({ checked: true });
    expect(switchView.state).toMatchObject({ checked: true });
  });

  it('marks ARIA widgets and focusable elements with a click affordance as clickable', () => {
    const document = new FakeDocument();
    const onclickWidget = document.add('div', 'Pick one', { tabindex: '0', onclick: 'pick()' });
    onclickWidget.tabIndex = 0;
    const pointerWidget = document.add('div', 'Expand', { tabindex: '0' });
    pointerWidget.tabIndex = 0;
    pointerWidget.style.cursor = 'pointer';
    const plainFocusable = document.add('div', 'Region', { tabindex: '0' });
    plainFocusable.tabIndex = 0;
    document.add('div', 'Bold', { role: 'menuitemcheckbox' });

    const actions = Object.fromEntries(observe(document, 's_widgets').elements.map((item: any) => [item.name, item.allowedActions]));

    expect(actions['Pick one']).toEqual(['click', 'focus', 'hover']);
    expect(actions.Expand).toEqual(['click', 'focus', 'hover']);
    // Focusable with no click affordance: focus and hover only, no invented click.
    expect(actions.Region).toEqual(['focus', 'hover']);
    expect(actions.Bold).toEqual(['click', 'focus', 'hover']);
  });

  it('the ARIA widget roles already count as clickable, so they stay observable and clickable', () => {
    const document = new FakeDocument();
    for (const role of ['button', 'tab', 'switch', 'checkbox', 'option', 'menuitem']) {
      document.add('div', role, { role });
    }
    const actions = observe(document, 's_roles').elements.map((item: any) => [item.role, item.allowedActions]);
    expect(actions).toEqual([
      ['button', ['click', 'focus', 'hover']],
      ['tab', ['click', 'focus', 'hover']],
      ['switch', ['click', 'focus', 'hover']],
      ['checkbox', ['click', 'focus', 'hover']],
      ['option', ['click', 'focus', 'hover']],
      ['menuitem', ['click', 'focus', 'hover']],
    ]);
  });

  it('a contenteditable region is actionable for typing', () => {
    const document = new FakeDocument();
    const editor = document.add('div', 'Notes');
    editor.isContentEditable = true;

    expect(observe(document, 's_editable').elements[0]).toMatchObject({
      allowedActions: ['focus', 'type', 'keypress', 'hover'],
    });
  });

  it('observation installs no document-wide MutationObserver', () => {
    let constructed = 0;
    (globalThis as any).MutationObserver = class {
      constructor() { constructed += 1; }
      observe() {}
    };
    try {
      const document = new FakeDocument();
      document.add('button', 'Go');
      observe(document, 's_no_observer');
      expect(constructed).toBe(0);
    } finally {
      (globalThis as any).MutationObserver = originalGlobals.MutationObserver;
    }
  });
});

afterEach(() => {
  (globalThis as any).document = originalGlobals.document;
  (globalThis as any).location = originalGlobals.location;
  (globalThis as any).innerWidth = originalGlobals.innerWidth;
  (globalThis as any).innerHeight = originalGlobals.innerHeight;
  (globalThis as any).scrollBy = originalGlobals.scrollBy;
  (globalThis as any).requestAnimationFrame = originalGlobals.requestAnimationFrame;
});
