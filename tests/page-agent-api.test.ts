import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  PAGE_ACT_V2,
  PAGE_OBSERVE_V2,
  PAGE_V2_INSTALL,
} from '../extension/lib/observation-v2.js';

class FakeEvent {
  type: string;
  constructor(type: string) { this.type = type; }
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
  events: string[] = [];
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
  shadowRoot: FakeRoot | null = null;
  contentDocument: FakeDocument | null = null;
  options: FakeElement[] = [];
  labels: FakeElement[] = [];
  rect = { left: 10, top: 20, width: 120, height: 32 };
  focused = false;
  scrolledBy: unknown = null;
  scrolledIntoView = false;
  onScrollIntoView: (() => void) | null = null;

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

  getAttribute(name: string) { return this.attrs.get(name) ?? null; }
  hasAttribute(name: string) { return this.attrs.has(name); }
  setAttribute(name: string, value: string) { this.attrs.set(name, value); }
  getBoundingClientRect() { return { ...this.rect, right: this.rect.left + this.rect.width, bottom: this.rect.top + this.rect.height }; }
  getRootNode() { return this.root; }
  dispatchEvent(event: FakeEvent) { this.events.push(event.type); return true; }
  focus() { this.focused = true; this.ownerDocument.activeElement = this; }
  scrollIntoView() {
    this.scrolledIntoView = true;
    this.onScrollIntoView?.();
  }
  scrollBy(options: unknown) { this.scrolledBy = options; }
}

class FakeRoot {
  elements: FakeElement[] = [];
  host: FakeElement | null;
  constructor(host: FakeElement | null = null) { this.host = host; }
  querySelectorAll() { return this.elements; }
  getElementById(id: string) { return this.elements.find((element) => element.id === id) || null; }
}

class FakeDocument extends FakeRoot {
  title = 'Example';
  readyState = 'complete';
  body = { innerText: 'Continue Destination', textContent: 'Continue Destination' };
  documentElement = { clientWidth: 1000, clientHeight: 700 };
  activeElement: FakeElement | null = null;
  defaultView: any;
  hit: FakeElement | null = null;

  constructor() {
    super(null);
    this.defaultView = {
      innerWidth: 1000,
      innerHeight: 700,
      getComputedStyle: (element: FakeElement) => element.style,
      requestAnimationFrame: (callback: Function) => callback(),
      Event: FakeEvent,
      MouseEvent: FakeEvent,
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
  elementFromPoint() { return this.hit; }
  execCommand(_command: string, _ui: boolean, value: string) {
    if (this.activeElement) this.activeElement.textContent += value;
    return true;
  }
}

const originalGlobals = {
  document: globalThis.document,
  location: globalThis.location,
  MutationObserver: globalThis.MutationObserver,
  innerWidth: (globalThis as any).innerWidth,
  innerHeight: (globalThis as any).innerHeight,
  scrollX: (globalThis as any).scrollX,
  scrollY: (globalThis as any).scrollY,
  scrollBy: (globalThis as any).scrollBy,
  requestAnimationFrame: globalThis.requestAnimationFrame,
};

function install(document: FakeDocument) {
  (globalThis as any).document = document;
  (globalThis as any).location = { href: 'https://example.test/form' };
  (globalThis as any).MutationObserver = class { observe() {} };
  (globalThis as any).innerWidth = 1000;
  (globalThis as any).innerHeight = 700;
  (globalThis as any).scrollX = 0;
  (globalThis as any).scrollY = 0;
  (globalThis as any).scrollBy = () => {};
  (globalThis as any).requestAnimationFrame = (callback: Function) => callback();
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

function act(observation: any, params: Record<string, unknown>) {
  return PAGE_ACT_V2({
    snapshotId: observation.snapshotId,
    sessionId: 'session-a',
    documentId: observation.documentId,
    routeEpoch: observation.routeEpoch,
    ttlMs: 60_000,
    params,
  });
}

describe('page-side Observation Engine V2', () => {
  beforeEach(() => { delete (globalThis as any).__browserControllerObservationV2; });
  afterEach(() => { delete (globalThis as any).__browserControllerObservationV2; });

  it('discovers compact interactive semantics, state, geometry, and allowed actions', () => {
    const document = new FakeDocument();
    const button = document.add('button', 'Continue');
    const textbox = document.add('input', '', { type: 'text', placeholder: 'Destination' });
    textbox.value = 'London';
    document.hit = button;

    const result = observe(document);

    expect(result.elements).toEqual([
      expect.objectContaining({
        ref: 'e1', role: 'button', name: 'Continue', state: { disabled: false, checked: false, selected: false },
        bbox: [10, 20, 120, 32], visible: true, interactable: true,
        allowedActions: ['click', 'focus', 'hover'],
      }),
      expect.objectContaining({
        ref: 'e2', role: 'textbox', name: 'Destination', value: 'London',
        allowedActions: ['focus', 'type', 'keypress', 'hover'],
      }),
    ]);
    expect(result.metrics).toMatchObject({ protocolCalls: 1 });
    expect(result.metrics.payloadBytes).toBeLessThan(10_000);
    expect(JSON.stringify(result)).not.toContain('outerHTML');
    expect(JSON.stringify(result)).not.toContain('className');
  });

  it('keeps disabled controls observable but advertises no invalid action', () => {
    const document = new FakeDocument();
    const button = document.add('button', 'Continue');
    button.disabled = true;
    expect(observe(document).elements[0]).toMatchObject({
      state: { disabled: true },
      interactable: false,
      allowedActions: [],
    });
  });

  it('excludes controls hidden by a composed ancestor or containing iframe', () => {
    const shadowDocument = new FakeDocument();
    const host = shadowDocument.add('div');
    host.style.opacity = '0';
    const shadow = new FakeRoot(host);
    const shadowButton = new FakeElement(shadowDocument, 'button', 'Invisible action');
    shadowButton.root = shadow;
    shadow.elements.push(shadowButton);
    host.shadowRoot = shadow;
    expect(observe(shadowDocument, 's_hidden_shadow').elements).toEqual([]);

    const frameDocument = new FakeDocument();
    const frame = frameDocument.add('iframe');
    frame.style.display = 'none';
    const childDocument = new FakeDocument();
    childDocument.add('button', 'Invisible frame action');
    frame.contentDocument = childDocument;
    expect(observe(frameDocument, 's_hidden_frame').elements).toEqual([]);
  });

  it('traverses open shadow roots and same-origin iframes with top-viewport geometry', () => {
    const document = new FakeDocument();
    const host = document.add('div');
    const shadow = new FakeRoot(host);
    const shadowButton = new FakeElement(document, 'button', 'Shadow action');
    shadowButton.root = shadow;
    shadow.elements.push(shadowButton);
    host.shadowRoot = shadow;

    const frame = document.add('iframe');
    frame.rect = { left: 100, top: 80, width: 500, height: 400 };
    const childDocument = new FakeDocument();
    const frameButton = childDocument.add('button', 'Frame action');
    frameButton.rect = { left: 15, top: 25, width: 90, height: 30 };
    frame.contentDocument = childDocument;

    const result = observe(document);
    const shadowView = result.elements.find((element: any) => element.name === 'Shadow action');
    const frameView = result.elements.find((element: any) => element.name === 'Frame action');
    expect(shadowView).toBeTruthy();
    expect(frameView.bbox).toEqual([115, 105, 90, 30]);
  });

  it('resolves aria-labelledby inside the element shadow root', () => {
    const document = new FakeDocument();
    const host = document.add('div');
    const shadow = new FakeRoot(host);
    const label = new FakeElement(document, 'span', 'Shadow label', { id: 'shadow-label' });
    const button = new FakeElement(document, 'button', '', { 'aria-labelledby': 'shadow-label' });
    label.root = shadow;
    button.root = shadow;
    shadow.elements.push(label, button);
    host.shadowRoot = shadow;

    const result = observe(document, 's_shadow_label');
    expect(result.elements.find((element: any) => element.role === 'button')).toMatchObject({ name: 'Shadow label' });
  });

  it('keeps document version stable within a document and changes identity on replacement', () => {
    const firstDocument = new FakeDocument();
    firstDocument.add('button', 'One');
    const first = observe(firstDocument, 's_1');
    const second = PAGE_OBSERVE_V2({
      snapshotId: 's_2', sessionId: 'session-a', mode: 'compact', maxElements: 10,
      maxSnapshots: 10, ttlMs: 60_000, now: Date.now(),
    });
    expect(second.documentVersion).toBe(first.documentVersion);

    const nextDocument = new FakeDocument();
    nextDocument.add('button', 'Two');
    const replacement = observe(nextDocument, 's_3');
    expect(replacement.documentId).not.toBe(first.documentId);
  });

  it('refuses to run without the installed runtime and recovers once installed', async () => {
    const runtime = (globalThis as any).__browserControllerV2Runtime;
    delete (globalThis as any).__browserControllerV2Runtime;
    const document = new FakeDocument();
    document.add('button', 'Continue');
    try {
      install(document);
      delete (globalThis as any).__browserControllerV2Runtime;
      expect(PAGE_OBSERVE_V2({
        snapshotId: 's_no_runtime', sessionId: 'session-a', mode: 'compact',
        maxElements: 10, maxSnapshots: 10, ttlMs: 60_000, now: Date.now(),
      })).toMatchObject({ success: false, error: 'RUNTIME_NOT_INSTALLED' });
      expect(await PAGE_ACT_V2({
        snapshotId: 's_no_runtime', sessionId: 'session-a', documentId: 'd_x',
        routeEpoch: 1, ttlMs: 60_000, params: { action: 'click', ref: 'e1' },
      })).toMatchObject({ success: false, error: 'RUNTIME_NOT_INSTALLED' });
      expect(PAGE_V2_INSTALL()).toBe(true);
      expect(PAGE_OBSERVE_V2({
        snapshotId: 's_no_runtime2', sessionId: 'session-a', mode: 'compact',
        maxElements: 10, maxSnapshots: 10, ttlMs: 60_000, now: Date.now(),
      })).toMatchObject({ success: true, elements: [expect.objectContaining({ ref: 'e1' })] });
      expect(PAGE_V2_INSTALL()).toBe(false);
    } finally {
      (globalThis as any).__browserControllerV2Runtime = runtime;
    }
  });
});

describe('page-side Safe Action Engine', () => {
  it('returns TARGET_NOT_FOUND for a ref outside the named observation', async () => {
    const document = new FakeDocument();
    document.add('button', 'Continue');
    expect(await act(observe(document, 's_unknown_ref'), { action: 'click', ref: 'e999' })).toMatchObject({
      success: false,
      error: 'TARGET_NOT_FOUND',
      ref: 'e999',
    });
  });

  it('executes click only when native hit testing reaches the target', async () => {
    const document = new FakeDocument();
    const button = document.add('button', 'Continue', { id: 'continue' });
    document.hit = button;
    const observation = observe(document);

    const result = await act(observation, { action: 'click', ref: 'e1' });
    expect(result).toMatchObject({ success: true, ok: true, action: 'click', ref: 'e1' });
    expect(button.events).toEqual(['mouseover', 'mousedown', 'mouseup', 'click']);
  });

  it('returns blocker metadata for an overlay', async () => {
    const document = new FakeDocument();
    document.add('button', 'Continue');
    const overlay = document.add('div', 'Cookie preferences', { role: 'dialog' });
    document.hit = overlay;
    const result = await act(observe(document), { action: 'click', ref: 'e1' });
    expect(result).toMatchObject({
      success: false,
      error: 'TARGET_OCCLUDED',
      blockingElement: { role: 'dialog', name: 'Cookie preferences', tag: 'div' },
    });
    expect(await act(observe(document, 's_hover_overlay'), { action: 'hover', ref: 'e1' })).toMatchObject({
      success: false,
      error: 'TARGET_OCCLUDED',
    });
  });

  it('accepts descendant and open-shadow host hit results', async () => {
    const document = new FakeDocument();
    const button = document.add('button', 'Continue');
    const icon = new FakeElement(document, 'span');
    icon.parentElement = button;
    document.hit = icon;
    expect(await act(observe(document, 's_desc'), { action: 'click', ref: 'e1' })).toMatchObject({ ok: true });

    delete (globalThis as any).__browserControllerObservationV2;
    const shadowHost = new FakeElement(document, 'div');
    const shadowRoot = new FakeRoot(shadowHost);
    button.root = shadowRoot;
    shadowRoot.elements.push(button);
    document.elements = [shadowHost];
    shadowHost.shadowRoot = shadowRoot;
    document.hit = shadowHost;
    const shadowResult = await act(observe(document, 's_shadow'), { action: 'click', ref: 'e1' });
    expect(shadowResult, JSON.stringify(shadowResult)).toMatchObject({ ok: true });
  });

  it('detects disabled, hidden, changed, removed, and SPA-invalidated targets', async () => {
    const disabledDocument = new FakeDocument();
    const disabled = disabledDocument.add('button', 'Disabled');
    disabled.disabled = true;
    const disabledObservation = observe(disabledDocument, 's_disabled');
    expect(await act(disabledObservation, { action: 'click', ref: 'e1' })).toMatchObject({ error: 'TARGET_DISABLED' });

    const hiddenDocument = new FakeDocument();
    const hidden = hiddenDocument.add('button', 'Hidden later');
    hiddenDocument.hit = hidden;
    const hiddenObservation = observe(hiddenDocument, 's_hidden');
    hidden.style.display = 'none';
    expect(await act(hiddenObservation, { action: 'click', ref: 'e1' })).toMatchObject({ error: 'TARGET_NOT_VISIBLE' });

    const changedDocument = new FakeDocument();
    const changed = changedDocument.add('button', 'Continue');
    changedDocument.hit = changed;
    const changedObservation = observe(changedDocument, 's_changed');
    changed.innerText = changed.textContent = 'Delete';
    expect(await act(changedObservation, { action: 'click', ref: 'e1' })).toMatchObject({ error: 'STALE_STATE' });

    const removedDocument = new FakeDocument();
    const removed = removedDocument.add('button', 'Continue');
    const removedObservation = observe(removedDocument, 's_removed');
    removed.isConnected = false;
    removedDocument.elements = [];
    expect(await act(removedObservation, { action: 'click', ref: 'e1' })).toMatchObject({ error: 'STALE_STATE' });

    const spaDocument = new FakeDocument();
    spaDocument.add('button', 'Continue');
    const spaObservation = observe(spaDocument, 's_spa');
    (globalThis as any).location.href = 'https://example.test/other';
    expect(await act(spaObservation, { action: 'click', ref: 'e1' })).toMatchObject({ error: 'DOCUMENT_CHANGED' });
  });

  it('rejects non-finite live geometry and revalidates state after scrolling', async () => {
    const invalidDocument = new FakeDocument();
    const invalid = invalidDocument.add('button', 'Continue');
    const invalidObservation = observe(invalidDocument, 's_invalid_geometry');
    invalid.rect.width = Number.POSITIVE_INFINITY;
    expect(await act(invalidObservation, { action: 'focus', ref: 'e1' })).toMatchObject({ error: 'TARGET_NOT_VISIBLE' });

    const scrollDocument = new FakeDocument();
    const input = scrollDocument.add('input', '', { type: 'text', placeholder: 'Name' });
    input.rect.top = 900;
    input.onScrollIntoView = () => {
      input.rect.top = 100;
      input.disabled = true;
    };
    const scrollObservation = observe(scrollDocument, 's_scroll_revalidate');
    expect(await act(scrollObservation, { action: 'type', ref: 'e1', text: 'Ada' })).toMatchObject({ error: 'TARGET_DISABLED' });
    expect(input.events).not.toContain('input');
  });

  it('scrolls an offscreen iframe ancestor before acting in its document', async () => {
    const document = new FakeDocument();
    const frame = document.add('iframe');
    frame.rect = { left: 10, top: 900, width: 500, height: 400 };
    frame.onScrollIntoView = () => { frame.rect.top = 100; };
    const childDocument = new FakeDocument();
    childDocument.add('button', 'Frame action');
    frame.contentDocument = childDocument;

    const observation = observe(document, 's_frame_scroll');
    const frameTarget = observation.elements.find((element: any) => element.name === 'Frame action');
    expect(await act(observation, { action: 'focus', ref: frameTarget.ref })).toMatchObject({ ok: true });
    expect(frame.scrolledIntoView).toBe(true);
  });

  it('recovers one uniquely identified replacement but refuses an ambiguous virtualized target', async () => {
    const document = new FakeDocument();
    const oldButton = document.add('button', 'Continue', { id: 'continue' });
    const observation = observe(document, 's_recover');
    oldButton.isConnected = false;
    const replacement = new FakeElement(document, 'button', 'Continue', { id: 'continue' });
    document.elements = [replacement];
    document.hit = replacement;
    expect(await act(observation, { action: 'click', ref: 'e1' })).toMatchObject({ ok: true, recovered: true });

    delete (globalThis as any).__browserControllerObservationV2;
    const ambiguousDocument = new FakeDocument();
    const old = ambiguousDocument.add('button', 'Continue', { 'data-testid': 'next' });
    const ambiguousObservation = observe(ambiguousDocument, 's_ambiguous');
    old.isConnected = false;
    ambiguousDocument.elements = [
      new FakeElement(ambiguousDocument, 'button', 'Continue', { 'data-testid': 'next' }),
      new FakeElement(ambiguousDocument, 'button', 'Continue', { 'data-testid': 'next' }),
    ];
    expect(await act(ambiguousObservation, { action: 'click', ref: 'e1' })).toMatchObject({ error: 'STALE_STATE' });
  });

  it('revalidates relocated geometry and supports type, select, focus, hover, keypress, and scroll', async () => {
    const scenarios = [
      { tag: 'input', attrs: { type: 'text', placeholder: 'Name' }, action: { action: 'type', ref: 'e1', text: 'Ada', clear: true }, event: 'input' },
      { tag: 'input', attrs: { type: 'text', placeholder: 'Name' }, action: { action: 'keypress', ref: 'e1', key: 'Enter' }, event: 'keydown' },
      { tag: 'button', attrs: {}, action: { action: 'focus', ref: 'e1' }, focus: true },
      { tag: 'button', attrs: {}, action: { action: 'hover', ref: 'e1' }, event: 'mouseover' },
      { tag: 'div', attrs: { role: 'region' }, scrollable: true, action: { action: 'scroll', ref: 'e1', deltaY: 200 }, scroll: true },
    ];
    for (const scenario of scenarios) {
      const document = new FakeDocument();
      const element = document.add(scenario.tag, scenario.tag === 'button' ? 'Action' : '', scenario.attrs);
      if (scenario.scrollable) element.scrollHeight = 400;
      const observation = observe(document, `s_${scenario.action.action}`);
      element.rect = { left: 70, top: 90, width: 140, height: 35 };
      document.hit = element;
      const result = await act(observation, scenario.action);
      expect(result, scenario.action.action).toMatchObject({ ok: true });
      if (scenario.event) expect(element.events).toContain(scenario.event);
      if (scenario.focus) expect(element.focused).toBe(true);
      if (scenario.scroll) expect(element.scrolledBy).toBeTruthy();
    }

    const selectDocument = new FakeDocument();
    const select = selectDocument.add('select', 'Destination');
    const option = new FakeElement(selectDocument, 'option', 'London');
    option.value = 'lon';
    select.options = [option];
    const selectObservation = observe(selectDocument, 's_select');
    expect(await act(selectObservation, { action: 'select', ref: 'e1', label: 'London' })).toMatchObject({ ok: true });
    expect(select.value).toBe('lon');
  });

  it('returns ACTION_NOT_ALLOWED with recovery context', async () => {
    const document = new FakeDocument();
    document.add('input', '', { type: 'text', placeholder: 'Name' });
    const result = await act(observe(document), { action: 'click', ref: 'e1' });
    expect(result).toMatchObject({
      error: 'ACTION_NOT_ALLOWED',
      requestedAction: 'click',
      allowedActions: ['focus', 'type', 'keypress', 'hover'],
    });
  });

  it('prepares a top-document file input for the existing CDP upload path', async () => {
    const document = new FakeDocument();
    document.add('input', '', { type: 'file' });
    const result = await act(observe(document, 's_upload'), {
      action: 'upload', ref: 'e1', filePath: '/tmp/resume.pdf',
    });
    expect(result).toMatchObject({ ok: true, preparedUpload: true, action: 'upload', ref: 'e1' });
    expect(result.selector).toMatch(/^\[data-bc-v2-upload=/);
  });

  it('does not advertise upload where the CDP handoff cannot reach the file input', () => {
    const document = new FakeDocument();
    const host = document.add('div');
    const shadow = new FakeRoot(host);
    const shadowInput = new FakeElement(document, 'input', '', { type: 'file' });
    shadowInput.root = shadow;
    shadow.elements.push(shadowInput);
    host.shadowRoot = shadow;

    const frame = document.add('iframe');
    const childDocument = new FakeDocument();
    childDocument.add('input', '', { type: 'file' });
    frame.contentDocument = childDocument;

    expect(observe(document, 's_nested_upload').elements).toEqual([]);
  });
});

afterEach(() => {
  (globalThis as any).document = originalGlobals.document;
  (globalThis as any).location = originalGlobals.location;
  (globalThis as any).MutationObserver = originalGlobals.MutationObserver;
  (globalThis as any).innerWidth = originalGlobals.innerWidth;
  (globalThis as any).innerHeight = originalGlobals.innerHeight;
  (globalThis as any).scrollX = originalGlobals.scrollX;
  (globalThis as any).scrollY = originalGlobals.scrollY;
  (globalThis as any).scrollBy = originalGlobals.scrollBy;
  (globalThis as any).requestAnimationFrame = originalGlobals.requestAnimationFrame;
});
