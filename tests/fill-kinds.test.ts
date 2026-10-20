import { beforeEach, describe, expect, it } from 'vitest';
import { installFakePage, type FakeDocument, type FakeElement } from './helpers/fake-dom.js';

// Browser Controller 3.0: browser_type key sequences, and browser_fill's picker inputs (date, time,
// color, range ...), ARIA checkbox / radio / switch widgets, and number values. The page functions
// run in this process against the fake page; the debugger is a recorder (as in v3-input.test.ts).

const cdp: Array<{ method: string; params: Record<string, any> }> = [];
let cdpReply: (method: string, params: Record<string, any>) => unknown = () => ({});
const dialogListeners: Array<(src: { tabId: number }, method: string, params?: unknown) => void> = [];

(globalThis as any).chrome = {
  tabs: {
    get: async (id: number) => ({ id, url: 'https://example.test/page', windowId: 1 }),
    query: async () => [],
    onRemoved: { addListener: () => {} },
  },
  scripting: {
    // Chrome runs a page function from its source text, not as a closure of this module: a module-level
    // name it uses is a ReferenceError in the page. The fake does the same, so such a name fails here too.
    executeScript: async (o: { func: (...a: any[]) => unknown; args?: unknown[] }) => {
      const pageFn = new Function(`return (${o.func.toString()});`)() as (...a: any[]) => unknown;
      return [{ result: await pageFn(...(o.args ?? [])) }];
    },
  },
  storage: {
    session: { get: async () => ({}), set: async () => {} },
    local: { get: async () => ({ agentCursor: false }), set: async () => {} },
  },
  debugger: {
    attach: async () => {},
    detach: async () => {},
    sendCommand: async (_t: unknown, method: string, params: Record<string, any> = {}) => {
      cdp.push({ method, params });
      return cdpReply(method, params) ?? {};
    },
    onEvent: { addListener: (fn: (typeof dialogListeners)[number]) => { dialogListeners.push(fn); } },
    onDetach: { addListener: () => {} },
  },
};

const { PAGE_DOM_INSTALL, PAGE_DOM_VERSION } = await import('../extension/lib/page-dom.js');
const { handleType } = await import('../extension/handlers/interaction.js');
const { handleFill } = await import('../extension/handlers/interaction-advanced.js');
const { detachCdp, clearOpenDialog } = await import('../extension/lib/cdp-session.js');
const { fallbackByTab } = await import('../extension/lib/state.js');

let doc: FakeDocument;
const inputs = () => cdp.filter((c) => c.method.startsWith('Input.'));
const pressed = () => cdp.filter((c) => c.method === 'Input.dispatchMouseEvent' && c.params.type === 'mousePressed');
const keyEvents = () => cdp.filter((c) => c.method === 'Input.dispatchKeyEvent');
const keyDowns = () => keyEvents().filter((c) => c.params.type !== 'keyUp');
const never = () => new Promise<unknown>(() => {});

/** Topmost-first hit stack at every point (the fake page's elementsFromPoint). */
function stackAt(...topmostFirst: FakeElement[]) {
  (doc as any).elementsFromPoint = () => topmostFirst;
}

/** A press focuses the element under the point; inserted text goes to whatever has focus. */
function browserReply(method: string, params: Record<string, any>): unknown {
  if (method === 'Input.dispatchMouseEvent' && params.type === 'mousePressed') {
    const hit = ((doc as any).elementsFromPoint?.(params.x, params.y) ?? [])[0];
    if (hit && typeof hit.focus === 'function') hit.focus();
  }
  if (method === 'Input.insertText') {
    const el = doc.activeElement as FakeElement | null;
    if (el) el.value = `${el.value ?? ''}${params.text}`;
  }
  return {};
}

/** Fires a JS dialog the way Chrome does, on the tab's session. */
function openDialog(type: string, message: string) {
  for (const fn of dialogListeners) fn({ tabId: 1 }, 'Page.javascriptDialogOpening', { type, message, url: 'https://example.test/page', frameId: 'f1', defaultPrompt: '' });
}

/**
 * The browser's own value rules for the picker types, as the fake stands in for them: an
 * invalid date or time reads back empty, a colour is lower-case #rrggbb (else black), a range
 * is clamped to 0..100 and rounded.
 */
const VALID_PICKER: Record<string, RegExp> = {
  date: /^\d{4}-\d{2}-\d{2}$/,
  time: /^\d{2}:\d{2}(:\d{2})?$/,
  'datetime-local': /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/,
  month: /^\d{4}-\d{2}$/,
  week: /^\d{4}-W\d{2}$/,
};
function sanitize(type: string, v: string): string {
  if (VALID_PICKER[type]) return VALID_PICKER[type].test(v) ? v : '';
  if (type === 'color') return /^#[0-9a-f]{6}$/i.test(v) ? v.toLowerCase() : '#000000';
  if (type === 'range') {
    const n = Number(v);
    return v.trim() === '' || Number.isNaN(n) ? '50' : String(Math.min(100, Math.max(0, Math.round(n))));
  }
  return v;
}
/**
 * HTMLInputElement.prototype.value, as the page's picker code reaches it. The fake's element is not
 * an HTMLInputElement, so the setter stores the sanitized value on the element itself.
 */
function installNativeValueSetter() {
  Object.defineProperty((globalThis as any).HTMLInputElement.prototype, 'value', {
    configurable: true,
    set(this: any, v: unknown) { this.value = sanitize(String(this.type), String(v)); },
  });
}

beforeEach(async () => {
  cdp.length = 0;
  cdpReply = browserReply;
  await detachCdp(1);
  clearOpenDialog(1); // a dialog a failed test left open must not leak into the next one
  doc = installFakePage();
  (globalThis as any).innerWidth = 1000;
  (globalThis as any).innerHeight = 700;
  fallbackByTab.clear();
  PAGE_DOM_INSTALL(PAGE_DOM_VERSION);
  installNativeValueSetter();
});

describe('browser_type key: a sequence of keys, each token checked before anything is sent', () => {
  it('"ArrowDown ArrowDown Enter" presses the keys in order, each one released before the next', async () => {
    doc.activeElement = doc.el('input', { id: 'q' });
    const res = await handleType({ tabId: 1, key: 'ArrowDown ArrowDown Enter' });
    expect(res).toMatchObject({ success: true, input: 'cdp' });
    expect(res.text).toBe('pressed ArrowDown ArrowDown Enter');
    expect(keyEvents().map((c) => `${c.params.type}:${c.params.key}`)).toEqual([
      'rawKeyDown:ArrowDown', 'keyUp:ArrowDown',
      'rawKeyDown:ArrowDown', 'keyUp:ArrowDown',
      'keyDown:Enter', 'keyUp:Enter',
    ]);
  });

  it('a combo is one token of the sequence: "Control+a Enter" selects all, then presses Enter', async () => {
    doc.activeElement = doc.el('input', { id: 'q' });
    const res = await handleType({ tabId: 1, key: 'Control+a Enter' });
    expect(res.text).toBe('pressed Control+a Enter');
    expect(keyDowns().map((c) => [c.params.key, c.params.modifiers])).toEqual([['a', 2], ['Enter', 0]]);
  });

  it('a value of only whitespace is one key: " " is the Space key', async () => {
    doc.activeElement = doc.el('input', { id: 'q' });
    const res = await handleType({ tabId: 1, key: ' ' });
    expect(res.text).toBe('pressed  ');
    expect(keyDowns()).toHaveLength(1);
    expect(keyDowns()[0].params).toMatchObject({ key: ' ', code: 'Space', text: ' ' });
  });

  it('an unknown token anywhere in the sequence is UNKNOWN_KEY, and no key is sent', async () => {
    doc.activeElement = doc.el('input', { id: 'q' });
    await expect(handleType({ tabId: 1, key: 'ArrowDown Hello Enter' })).rejects.toThrow(/^UNKNOWN_KEY: "Hello" is not a key name/);
    expect(cdp).toEqual([]);
  });

  it('a dialog that a press opens ends the sequence: the later keys are not pressed', async () => {
    doc.activeElement = doc.el('input', { id: 'q' });
    cdpReply = (method, params) => {
      if (method === 'Input.dispatchKeyEvent' && params.type === 'keyDown') { openDialog('confirm', 'Submit?'); return never(); }
      return browserReply(method, params);
    };
    const res = await handleType({ tabId: 1, key: 'Enter Escape Tab' });
    expect(res.text).toBe('pressed 1 of 3 keys\ndialog: confirm "Submit?"');
    expect(keyDowns().map((c) => c.params.key)).toEqual(['Enter']);
  });
});

describe('browser_fill: picker inputs are set as the picker sets them', () => {
  it.each([
    ['date', '2026-10-21'],
    ['time', '10:30'],
    ['datetime-local', '2026-10-21T10:30'],
    ['month', '2026-10'],
    ['week', '2026-W43'],
  ])('a %s input takes %s by the native setter, then input and change, and reads back filled', async (type, value) => {
    const el = doc.el('input', { id: 'p', type });
    doc.body.append(el);
    const res = await handleFill({ tabId: 1, fields: [{ target: '#p', value }] });
    expect(res).toMatchObject({ success: true, filled: 1 });
    expect(res.text).toBe('filled 1 fields');
    expect(el.value).toBe(value);
    expect(el.events).toEqual(['input', 'change']);
    // No keyboard or mouse path: a picker has none that a typed value could use.
    expect(inputs()).toEqual([]);
  });

  it('a color is read back case-insensitively: #FF8800 is filled', async () => {
    const el = doc.el('input', { id: 'c', type: 'color' });
    doc.body.append(el);
    expect(await handleFill({ tabId: 1, fields: [{ target: '#c', value: '#FF8800' }] })).toMatchObject({ success: true, filled: 1 });
    expect(el.value).toBe('#ff8800');
  });

  it('a range takes a number (converted to its string) and reads back as that number', async () => {
    const el = doc.el('input', { id: 'r', type: 'range' });
    doc.body.append(el);
    expect(await handleFill({ tabId: 1, fields: [{ target: '#r', value: 70 }] })).toMatchObject({ success: true, filled: 1 });
    expect(el.value).toBe('70');
  });

  it('a range the browser clamps reads back different: VALUE_NOT_SET names the kept value', async () => {
    const el = doc.el('input', { id: 'r', type: 'range' });
    doc.body.append(el);
    const res = await handleFill({ tabId: 1, fields: [{ target: '#r', value: 150 }] });
    expect(res.success).toBe(false);
    expect(res.error).toBe('FILL_FAILED: 1 of 1 fields failed\n#r: VALUE_NOT_SET: kept "100"');
  });

  it('a date the browser rejects reads back empty: VALUE_NOT_SET, kept ""', async () => {
    const el = doc.el('input', { id: 'd', type: 'date' });
    doc.body.append(el);
    const res = await handleFill({ tabId: 1, fields: [{ target: '#d', value: 'not-a-date' }] });
    expect(res.error).toContain('#d: VALUE_NOT_SET: kept ""');
    expect(el.value).toBe('');
  });

  it('a named colour is not a colour value: the browser keeps black, and that is VALUE_NOT_SET', async () => {
    const el = doc.el('input', { id: 'c', type: 'color' });
    doc.body.append(el);
    const res = await handleFill({ tabId: 1, fields: [{ target: '#c', value: 'red' }] });
    expect(res.error).toContain('#c: VALUE_NOT_SET: kept "#000000"');
  });

  it('an empty string clears a date', async () => {
    const el = doc.el('input', { id: 'd', type: 'date' });
    el.value = '2026-10-21';
    doc.body.append(el);
    expect(await handleFill({ tabId: 1, fields: [{ target: '#d', value: '' }] })).toMatchObject({ success: true, filled: 1 });
    expect(el.value).toBe('');
  });

  it('a boolean is INVALID_ARGUMENT for a picker, and the field is not touched', async () => {
    const el = doc.el('input', { id: 'd', type: 'date' });
    el.value = '2026-10-21';
    doc.body.append(el);
    const res = await handleFill({ tabId: 1, fields: [{ target: '#d', value: true }] });
    expect(res.error).toContain('#d: INVALID_ARGUMENT: #d takes a string');
    expect(el.value).toBe('2026-10-21');
    expect(el.events).toEqual([]);
  });

  it('a disabled picker is not set: VALUE_NOT_SET with the value it keeps, and no event fires', async () => {
    const el = doc.el('input', { id: 'd', type: 'date' });
    el.value = '2025-01-01';
    el.disabled = true;
    doc.body.append(el);
    const res = await handleFill({ tabId: 1, fields: [{ target: '#d', value: '2026-10-21' }] });
    expect(res.error).toContain('#d: VALUE_NOT_SET: kept "2025-01-01"');
    expect(el.value).toBe('2025-01-01');
    expect(el.events).toEqual([]);
  });

  it('a page that resets the picker when it changes keeps its value: VALUE_NOT_SET after the events', async () => {
    const el = doc.el('input', { id: 'd', type: 'date' });
    doc.body.append(el);
    (el as any).dispatchEvent = (e: { type: string }) => {
      el.events.push(e.type);
      if (e.type === 'change') el.value = '2000-01-01';
      return true;
    };
    const res = await handleFill({ tabId: 1, fields: [{ target: '#d', value: '2026-10-21' }] });
    expect(res.error).toContain('#d: VALUE_NOT_SET: kept "2000-01-01"');
  });
});

describe('browser_fill: ARIA checkbox, radio and switch widgets (not native inputs)', () => {
  function widget(role: string, checked: string, extra: Record<string, string> = {}): FakeElement {
    const el = doc.el('div', { id: 'w', role, 'aria-checked': checked, ...extra }, 'Widget');
    doc.body.append(el);
    stackAt(el);
    return el;
  }
  /** The page's own toggle: a press and release on the widget flips its aria-checked. */
  function toggleOnClick(el: FakeElement, next: string) {
    cdpReply = (method, params) => {
      if (method === 'Input.dispatchMouseEvent' && params.type === 'mouseReleased') el.setAttribute('aria-checked', next);
      return browserReply(method, params);
    };
  }

  it('an unchecked checkbox widget takes true by a trusted press, and reads back checked', async () => {
    const el = widget('checkbox', 'false');
    toggleOnClick(el, 'true');
    const res = await handleFill({ tabId: 1, fields: [{ target: '#w', value: true }] });
    expect(res).toMatchObject({ success: true, filled: 1 });
    expect(pressed()).toHaveLength(1);
    expect(pressed()[0].params).toMatchObject({ x: 60, y: 20 });
    expect(el.getAttribute('aria-checked')).toBe('true');
  });

  it('a widget already in the value state is not clicked (a click would undo it)', async () => {
    widget('checkbox', 'true');
    expect(await handleFill({ tabId: 1, fields: [{ target: '#w', value: true }] })).toMatchObject({ success: true });
    expect(pressed()).toEqual([]);
  });

  it('a switch is switched off by a trusted press', async () => {
    const el = widget('switch', 'true');
    toggleOnClick(el, 'false');
    expect(await handleFill({ tabId: 1, fields: [{ target: '#w', value: false }] })).toMatchObject({ success: true, filled: 1 });
    expect(el.getAttribute('aria-checked')).toBe('false');
    expect(pressed()).toHaveLength(1);
  });

  it('a click the page ignores leaves aria-checked as it was: VALUE_NOT_SET, not filled', async () => {
    widget('checkbox', 'false');
    cdpReply = () => ({}); // no toggle: the page does not react to the press
    const res = await handleFill({ tabId: 1, fields: [{ target: '#w', value: true }] });
    expect(res.success).toBe(false);
    expect(res.error).toBe('FILL_FAILED: 1 of 1 fields failed\n#w: VALUE_NOT_SET: kept aria-checked="false"');
    expect(pressed()).toHaveLength(1);
  });

  it('a radio widget can only be set to true, as a native radio is', async () => {
    widget('radio', 'true');
    const res = await handleFill({ tabId: 1, fields: [{ target: '#w', value: false }] });
    expect(res.error).toContain('#w: INVALID_ARGUMENT: #w is a radio button: it can only be set to true');
    expect(pressed()).toEqual([]);
  });

  it('a radio widget set to true is clicked and reads back checked', async () => {
    const el = widget('radio', 'false');
    toggleOnClick(el, 'true');
    expect(await handleFill({ tabId: 1, fields: [{ target: '#w', value: true }] })).toMatchObject({ success: true, filled: 1 });
  });

  it('a widget covered by another element is not clicked: ELEMENT_COVERED, nothing pressed', async () => {
    const el = widget('checkbox', 'false');
    const cover = doc.el('div', { class: 'promo' });
    doc.body.append(cover);
    stackAt(cover, el);
    const res = await handleFill({ tabId: 1, fields: [{ target: '#w', value: true }] });
    expect(res.error).toContain('#w: ELEMENT_COVERED: ');
    expect(pressed()).toEqual([]);
  });

  it('the value of a widget must be a boolean, as for a native checkbox', async () => {
    widget('checkbox', 'false');
    const res = await handleFill({ tabId: 1, fields: [{ target: '#w', value: 'true' }] });
    expect(res.error).toContain('#w: INVALID_ARGUMENT: #w takes true or false');
    expect(pressed()).toEqual([]);
  });
});

describe('browser_fill: text values', () => {
  it('a number value is typed as its string', async () => {
    const el = doc.el('input', { id: 'n' });
    doc.body.append(el);
    stackAt(el);
    expect(await handleFill({ tabId: 1, fields: [{ target: '#n', value: 42 }] })).toMatchObject({ success: true, filled: 1 });
    expect(el.value).toBe('42');
  });

  it('a textarea that reads CRLF back as LF is filled: the line breaks are compared as the value API keeps them', async () => {
    const ta = doc.el('textarea', { id: 'note' });
    doc.body.append(ta);
    stackAt(ta);
    cdpReply = (method, params) => {
      if (method === 'Input.insertText') { (doc.activeElement as FakeElement).value = String(params.text).replace(/\r\n?/g, '\n'); return {}; }
      return browserReply(method, params);
    };
    expect(await handleFill({ tabId: 1, fields: [{ target: '#note', value: 'a\r\nb' }] })).toMatchObject({ success: true, filled: 1 });
    expect(ta.value).toBe('a\nb');
  });

  it('a value longer than 100 characters is filled: the read back covers its first 100', async () => {
    const el = doc.el('input', { id: 'long' });
    doc.body.append(el);
    stackAt(el);
    const long = 'x'.repeat(150);
    expect(await handleFill({ tabId: 1, fields: [{ target: '#long', value: long }] })).toMatchObject({ success: true, filled: 1 });
    expect(el.value).toBe(long);
  });
});
