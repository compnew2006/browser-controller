import { beforeEach, describe, expect, it } from 'vitest';
import { installFakeFrame, installFakePage, type FakeDocument, type FakeElement } from './helpers/fake-dom.js';

// Browser Controller 3.0 wave 1 (V3-INPUT): click, type, fill, dialog on the one trusted path.
// The page functions run in this process against the fake page (real lib/page-dom.js);
// the debugger is a recorder. Every CDP call is kept, so "nothing was pressed" is checkable.

const cdp: Array<{ method: string; params: Record<string, any> }> = [];
let cdpOk = true;
let urlNow = 'https://example.test/page';
let cdpReply: (method: string, params: Record<string, any>) => unknown = () => ({});
/** A frozen page answers no script call either (the wedge probe then times out). */
let scriptFrozen = false;
const dialogListeners: Array<(src: { tabId: number }, method: string, params?: unknown) => void> = [];

(globalThis as any).chrome = {
  tabs: {
    get: async (id: number) => ({ id, url: urlNow, windowId: 1 }),
    query: async () => [],
    onRemoved: { addListener: () => {} },
  },
  scripting: {
    executeScript: async (o: { func: (...a: any[]) => unknown; args?: unknown[] }) => {
      if (scriptFrozen) return new Promise(() => {});
      return [{ result: await o.func(...(o.args ?? [])) }];
    },
  },
  storage: {
    session: { get: async () => ({}), set: async () => {} },
    local: { get: async () => ({ agentCursor: false }), set: async () => {} },
  },
  debugger: {
    attach: async () => { if (!cdpOk) throw new Error('Another debugger is attached to the tab'); },
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
const { handleClick, handleType } = await import('../extension/handlers/interaction.js');
const { handleFill, handleDialog } = await import('../extension/handlers/interaction-advanced.js');
const { detachCdp, clearOpenDialog, takeFileChooser, CHOOSER_GRACE_MS } = await import('../extension/lib/cdp-session.js');
const { fallbackByTab, wedgedTabs } = await import('../extension/lib/state.js');

let doc: FakeDocument;
const inputs = () => cdp.filter((c) => c.method === 'Input.dispatchMouseEvent' || c.method === 'Input.dispatchKeyEvent' || c.method === 'Input.insertText');
const pressed = () => cdp.filter((c) => c.method === 'Input.dispatchMouseEvent' && c.params.type === 'mousePressed');
const keysDown = () => cdp.filter((c) => c.method === 'Input.dispatchKeyEvent' && c.params.type !== 'keyUp');

/** Topmost-first hit stack at every point (the fake page's elementsFromPoint). */
function stackAt(...topmostFirst: FakeElement[]) {
  (doc as any).elementsFromPoint = () => topmostFirst;
}
/**
 * A browser's answer to the input: a press focuses the element under the point,
 * and inserted text goes to whatever has focus. Tests that need another answer set cdpReply.
 */
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
/** Typing follows focus (see browserReply). The field argument documents which field the test types into. */
function typesInto(_field: FakeElement) {
  cdpReply = browserReply;
}

beforeEach(async () => {
  cdp.length = 0;
  cdpOk = true;
  urlNow = 'https://example.test/page';
  cdpReply = browserReply;
  await detachCdp(1);
  clearOpenDialog(1); // a dialog a failed test left open must not leak into the next one
  doc = installFakePage();
  (globalThis as any).innerWidth = 1000;
  (globalThis as any).innerHeight = 700;
  fallbackByTab.clear();
  PAGE_DOM_INSTALL(PAGE_DOM_VERSION);
});

describe('no debugger: refuse, never fall back to synthetic events', () => {
  it('click fails with DEBUGGER_UNAVAILABLE and the page sees no click', async () => {
    cdpOk = false;
    const btn = doc.el('button', { id: 'go' }, 'Go');
    doc.body.append(btn);
    await expect(handleClick({ tabId: 1, target: '#go' })).rejects.toThrow(/^DEBUGGER_UNAVAILABLE: /);
    expect(btn.events).not.toContain('click');
    expect(inputs()).toEqual([]);
  });

  it('type fails with DEBUGGER_UNAVAILABLE and the field keeps its value', async () => {
    cdpOk = false;
    const field = doc.el('input', { id: 'q' });
    field.value = 'before';
    doc.body.append(field);
    await expect(handleType({ tabId: 1, target: '#q', text: 'x' })).rejects.toThrow(/^DEBUGGER_UNAVAILABLE: /);
    expect(field.value).toBe('before');
  });
});

describe('browser_click', () => {
  it('a real mouse click at the centre of the target, and the result line says what was clicked', async () => {
    const btn = doc.el('button', { id: 'go' }, 'Go');
    doc.body.append(btn);
    stackAt(btn);
    const res = await handleClick({ tabId: 1, target: '#go' });
    expect(res).toMatchObject({ success: true, input: 'cdp', at: { x: 60, y: 20 } });
    expect(res.text).toBe('clicked #go');
    expect(inputs().filter((c) => c.method === 'Input.dispatchMouseEvent').map((c) => c.params.type)).toEqual(['mouseMoved', 'mousePressed', 'mouseReleased']);
  });

  it('a covered target is ELEMENT_COVERED and nothing is pressed', async () => {
    const btn = doc.el('button', { id: 'buy' }, 'Buy');
    const cover = doc.el('div', { class: 'promo' });
    doc.body.append(btn, cover);
    stackAt(cover, btn);
    const res = await handleClick({ tabId: 1, target: '#buy' });
    expect(res).toMatchObject({ success: false, error: expect.stringMatching(/^ELEMENT_COVERED: /) });
    expect(pressed()).toEqual([]);
    expect(btn.events).not.toContain('click');
  });

  it('a hidden or disabled target is refused the same way', async () => {
    const hidden = doc.el('button', { id: 'h' }, 'Hidden');
    hidden.hidden = true;
    const off = doc.el('button', { id: 'off', 'aria-disabled': 'true' }, 'Off');
    doc.body.append(hidden, off);
    stackAt(off);
    expect(await handleClick({ tabId: 1, target: '#h' })).toMatchObject({ success: false, error: expect.stringMatching(/^ELEMENT_HIDDEN: /) });
    expect(await handleClick({ tabId: 1, target: '#off' })).toMatchObject({ success: false, error: expect.stringMatching(/^ELEMENT_DISABLED: /) });
    expect(pressed()).toEqual([]);
  });

  it('a point target clicks that point as it is, without the actionability check', async () => {
    const btn = doc.el('button', { id: 'buy' }, 'Buy');
    const cover = doc.el('div', { class: 'promo' });
    doc.body.append(btn, cover);
    stackAt(cover, btn);
    const res = await handleClick({ tabId: 1, target: '30,40' });
    expect(res).toMatchObject({ success: true, at: { x: 30, y: 40 } });
    expect(pressed()[0].params).toMatchObject({ x: 30, y: 40 });
  });

  it('count 2 presses twice (clickCount 1 then 2); count 4 is refused', async () => {
    const btn = doc.el('button', { id: 'go' }, 'Go');
    doc.body.append(btn);
    stackAt(btn);
    await handleClick({ tabId: 1, target: '#go', count: 2 });
    expect(pressed().map((c) => c.params.clickCount)).toEqual([1, 2]);
    await expect(handleClick({ tabId: 1, target: '#go', count: 4 })).rejects.toThrow(/^INVALID_ARGUMENT: count/);
  });

  it('modifiers go out as CDP modifier bits (Control = 2, Shift = 8)', async () => {
    const btn = doc.el('button', { id: 'go' }, 'Go');
    doc.body.append(btn);
    stackAt(btn);
    await handleClick({ tabId: 1, target: '#go', modifiers: ['Control', 'Shift'] });
    expect(pressed()[0].params.modifiers).toBe(10);
  });

  it('hover moves the mouse to the target and presses nothing', async () => {
    const menu = doc.el('button', { id: 'menu' }, 'Menu');
    doc.body.append(menu);
    const res = await handleClick({ tabId: 1, target: '#menu', hover: true });
    expect(res).toMatchObject({ success: true, input: 'cdp' });
    expect(res.text).toBe('hovered #menu');
    expect(inputs().map((c) => c.params.type)).toEqual(['mouseMoved']);
  });

  it('dragTo presses at the target, moves in 10 steps to the drop point, and releases there', async () => {
    const src = doc.el('div', { id: 'src' }, 'Card');
    const dst = doc.el('div', { id: 'dst' }, 'Column');
    (dst as any).getBoundingClientRect = () => ({ x: 200, y: 200, left: 200, top: 200, width: 100, height: 40, right: 300, bottom: 240 });
    doc.body.append(src, dst);
    (doc as any).elementsFromPoint = (x: number, y: number) => [src, dst].filter((el) => {
      const r = el.getBoundingClientRect();
      return x >= r.left && x <= r.left + r.width && y >= r.top && y <= r.top + r.height;
    });
    const res = await handleClick({ tabId: 1, target: '#src', dragTo: '#dst' });
    expect(res).toMatchObject({ success: true, from: { x: 60, y: 20 }, to: { x: 250, y: 220 } });
    expect(res.text).toBe('dragged #src → #dst');
    const types = inputs().map((c) => c.params.type);
    const press = types.indexOf('mousePressed');
    const release = types.indexOf('mouseReleased');
    expect(types.slice(press + 1, release).filter((t) => t === 'mouseMoved')).toHaveLength(10);
    expect(cdp.filter((c) => c.params.type === 'mouseReleased')[0].params).toMatchObject({ x: 250, y: 220 });
  });

  it('dragTo keeps the tab drawing frames for the whole drag: a screencast from before the press to after the release', async () => {
    const src = doc.el('div', { id: 'src' }, 'Card');
    const dst = doc.el('div', { id: 'dst' }, 'Column');
    (dst as any).getBoundingClientRect = () => ({ x: 200, y: 200, left: 200, top: 200, width: 100, height: 40, right: 300, bottom: 240 });
    doc.body.append(src, dst);
    (doc as any).elementsFromPoint = (x: number, y: number) => [src, dst].filter((el) => {
      const r = el.getBoundingClientRect();
      return x >= r.left && x <= r.left + r.width && y >= r.top && y <= r.top + r.height;
    });
    await handleClick({ tabId: 1, target: '#src', dragTo: '#dst' });
    const order = cdp.map((c) => (c.method === 'Input.dispatchMouseEvent' ? c.params.type : c.method));
    const start = order.indexOf('Page.startScreencast');
    expect(start).toBeGreaterThanOrEqual(0);
    expect(start).toBeLessThan(order.indexOf('mousePressed'));
    expect(order.indexOf('Page.stopScreencast')).toBeGreaterThan(order.indexOf('mouseReleased'));
  });

  it('dragTo clears the text selection before the press (a press on selected text starts Chrome\'s own text drag)', async () => {
    const src = doc.el('div', { id: 'src' }, 'Card');
    const dst = doc.el('div', { id: 'dst' }, 'Column');
    (dst as any).getBoundingClientRect = () => ({ x: 200, y: 200, left: 200, top: 200, width: 100, height: 40, right: 300, bottom: 240 });
    doc.body.append(src, dst);
    (doc as any).elementsFromPoint = (x: number, y: number) => [src, dst].filter((el) => {
      const r = el.getBoundingClientRect();
      return x >= r.left && x <= r.left + r.width && y >= r.top && y <= r.top + r.height;
    });
    let cleared = 0;
    let pressedAfterClear = false;
    (globalThis as any).getSelection = () => ({ removeAllRanges: () => { cleared++; } });
    const before = cdpReply;
    cdpReply = (method, params) => {
      if (method === 'Input.dispatchMouseEvent' && params.type === 'mousePressed') pressedAfterClear = cleared > 0;
      return before(method, params);
    };
    try {
      await handleClick({ tabId: 1, target: '#src', dragTo: '#dst' });
    } finally {
      delete (globalThis as any).getSelection;
    }
    expect(cleared).toBe(1);
    expect(pressedAfterClear).toBe(true);
  });

  /** Source and drop target 190 px apart, as in the drag tests above. */
  function dragPair() {
    const src = doc.el('div', { id: 'src', draggable: 'true' }, 'Card');
    const dst = doc.el('div', { id: 'dst' }, 'Column');
    (dst as any).getBoundingClientRect = () => ({ x: 200, y: 200, left: 200, top: 200, width: 100, height: 40, right: 300, bottom: 240 });
    doc.body.append(src, dst);
    (doc as any).elementsFromPoint = (x: number, y: number) => [src, dst].filter((el) => {
      const r = el.getBoundingClientRect();
      return x >= r.left && x <= r.left + r.width && y >= r.top && y <= r.top + r.height;
    });
  }

  it('dragTo plays an HTML5 drag as drag events once Chrome hands it over: dragenter, dragover, then drop, no mouse release', async () => {
    dragPair();
    const data = { items: [{ mimeType: 'text/plain', data: 'card-1' }], dragOperationsMask: 1 };
    let down = false;
    let handed = false;
    const before = cdpReply;
    cdpReply = (method, params) => {
      if (method === 'Input.dispatchMouseEvent' && params.type === 'mousePressed') down = true;
      // The first move with the button down starts the page's drag: Chrome hands it over.
      if (method === 'Input.dispatchMouseEvent' && params.type === 'mouseMoved' && down && !handed) {
        handed = true;
        for (const fn of dialogListeners) fn({ tabId: 1 }, 'Input.dragIntercepted', { data });
      }
      return before(method, params);
    };
    const res = await handleClick({ tabId: 1, target: '#src', dragTo: '#dst' });
    expect(res).toMatchObject({ success: true, html5: true });
    expect(res.text).toMatch(/^dragged #src → #dst\nhtml5: /);
    const steps = cdp.filter((c) => c.method === 'Input.dispatchMouseEvent' || c.method === 'Input.dispatchDragEvent')
      .map((c) => (c.method === 'Input.dispatchDragEvent' ? `drag:${c.params.type}` : c.params.type));
    expect(steps.filter((t) => t === 'mouseMoved')).toHaveLength(2); // to the press point, and the first step
    expect(steps.slice(steps.indexOf('drag:dragEnter'))).toEqual(['drag:dragEnter', ...Array(9).fill('drag:dragOver'), 'drag:drop']);
    expect(steps).not.toContain('mouseReleased');
    const drop = cdp.find((c) => c.method === 'Input.dispatchDragEvent' && c.params.type === 'drop')!;
    expect(drop.params).toMatchObject({ x: 250, y: 220, data });
  });

  it('dragTo switches drag interception on before the press and off after the drag', async () => {
    dragPair();
    await handleClick({ tabId: 1, target: '#src', dragTo: '#dst' });
    const order = cdp.map((c) => (c.method === 'Input.dispatchMouseEvent' ? c.params.type : c.method === 'Input.setInterceptDrags' ? `intercept:${c.params.enabled}` : c.method));
    expect(order.indexOf('intercept:true')).toBeLessThan(order.indexOf('mousePressed'));
    expect(order.indexOf('intercept:false')).toBeGreaterThan(order.indexOf('mouseReleased'));
  });

  it('a drop target that cannot share the viewport with the source is TARGET_OFFSCREEN, nothing pressed', async () => {
    const src = doc.el('div', { id: 'src' }, 'Card');
    const dst = doc.el('div', { id: 'dst' }, 'Far');
    (dst as any).getBoundingClientRect = () => ({ x: 10, y: 2000, left: 10, top: 2000, width: 100, height: 40, right: 110, bottom: 2040 });
    doc.body.append(src, dst);
    const res = await handleClick({ tabId: 1, target: '#src', dragTo: '#dst' });
    expect(res).toMatchObject({ success: false, error: expect.stringMatching(/^TARGET_OFFSCREEN: /) });
    expect(pressed()).toEqual([]);
  });

  it('a navigation within the settle window is reported as navigated: <url>', async () => {
    const link = doc.el('a', { id: 'next', href: '/next' }, 'Next');
    doc.body.append(link);
    stackAt(link);
    cdpReply = (method, params) => {
      if (method === 'Input.dispatchMouseEvent' && params.type === 'mouseReleased') urlNow = 'https://example.test/next';
      return {};
    };
    const res = await handleClick({ tabId: 1, target: '#next' });
    expect(res.text).toBe('clicked #next\nnavigated: https://example.test/next');
    expect(res.navigated).toBe('https://example.test/next');
  });

  it('a click whose response is an attachment reports the download, even when the response comes after the settle window', async () => {
    const hooks: Record<string, Array<(d: any) => void>> = {};
    const event = (name: string) => ({
      addListener: (fn: (d: any) => void) => { hooks[name] = [...(hooks[name] ?? []), fn]; },
      removeListener: (fn: (d: any) => void) => { hooks[name] = (hooks[name] ?? []).filter((f) => f !== fn); },
    });
    (globalThis as any).chrome.webRequest = { onBeforeRequest: event('start'), onHeadersReceived: event('headers'), onErrorOccurred: event('error') };
    try {
      const link = doc.el('a', { id: 'file', href: '/download/x.pdf' }, 'x.pdf');
      doc.body.append(link);
      stackAt(link);
      cdpReply = (method, params) => {
        if (method === 'Input.dispatchMouseEvent' && params.type === 'mouseReleased') {
          for (const fn of hooks.start ?? []) fn({ tabId: 1 });
          setTimeout(() => {
            const headers = [{ name: 'Content-Disposition', value: 'attachment; filename="x.pdf"' }];
            for (const fn of hooks.headers ?? []) fn({ tabId: 1, statusCode: 200, url: 'https://example.test/download/x.pdf', responseHeaders: headers });
          }, 400);
        }
        return browserReply(method, params);
      };
      const res = await handleClick({ tabId: 1, target: '#file' });
      expect(res.text).toBe('clicked #file\ndownload: true (file x.pdf); Chrome saves it to the Downloads folder, the tab did not navigate');
      expect(res.download).toEqual({ url: 'https://example.test/download/x.pdf', filename: 'x.pdf' });
      expect([...(hooks.start ?? []), ...(hooks.headers ?? []), ...(hooks.error ?? [])]).toEqual([]);
    } finally {
      delete (globalThis as any).chrome.webRequest;
    }
  });

  it('a navigation whose response comes after the settle window is still reported as navigated', async () => {
    const hooks: Record<string, Array<(d: any) => void>> = {};
    const event = (name: string) => ({
      addListener: (fn: (d: any) => void) => { hooks[name] = [...(hooks[name] ?? []), fn]; },
      removeListener: (fn: (d: any) => void) => { hooks[name] = (hooks[name] ?? []).filter((f) => f !== fn); },
    });
    (globalThis as any).chrome.webRequest = { onBeforeRequest: event('start'), onHeadersReceived: event('headers'), onErrorOccurred: event('error') };
    try {
      const link = doc.el('a', { id: 'slow', href: '/slow' }, 'Slow');
      doc.body.append(link);
      stackAt(link);
      cdpReply = (method, params) => {
        if (method === 'Input.dispatchMouseEvent' && params.type === 'mouseReleased') {
          for (const fn of hooks.start ?? []) fn({ tabId: 1 });
          setTimeout(() => {
            urlNow = 'https://example.test/slow';
            for (const fn of hooks.headers ?? []) fn({ tabId: 1, statusCode: 200, url: 'https://example.test/slow', responseHeaders: [] });
          }, 400);
        }
        return browserReply(method, params);
      };
      const res = await handleClick({ tabId: 1, target: '#slow' });
      expect(res.text).toBe('clicked #slow\nnavigated: https://example.test/slow');
      expect(res.navigated).toBe('https://example.test/slow');
      expect(res.download).toBeUndefined();
    } finally {
      delete (globalThis as any).chrome.webRequest;
    }
  });

  it('a JS dialog the click opened is reported as dialog: <type> "<message>" and never awaited', async () => {
    const btn = doc.el('button', { id: 'del' }, 'Delete');
    doc.body.append(btn);
    stackAt(btn);
    cdpReply = (method, params) => {
      if (method === 'Input.dispatchMouseEvent' && params.type === 'mouseReleased') {
        for (const fn of dialogListeners) fn({ tabId: 1 }, 'Page.javascriptDialogOpening', { type: 'confirm', message: 'Delete this item?', url: urlNow, frameId: 'f1', defaultPrompt: '' });
      }
      return {};
    };
    const res = await handleClick({ tabId: 1, target: '#del' });
    expect(res.text).toBe('clicked #del\ndialog: confirm "Delete this item?"');
    await handleDialog({ tabId: 1, accept: false });
  });
});

describe('browser_type', () => {
  it('text into a target: a trusted click focuses it, one insertText, then the result shows the value', async () => {
    const field = doc.el('input', { id: 'q' });
    doc.body.append(field);
    stackAt(field);
    typesInto(field);
    const res = await handleType({ tabId: 1, target: '#q', text: 'abc' });
    expect(res).toMatchObject({ success: true, typed: 3, value: 'abc' });
    expect(res.text).toBe('typed 3 chars into #q\nvalue: "abc"');
    expect(pressed()).toHaveLength(1);
    expect(cdp.filter((c) => c.method === 'Input.insertText')).toEqual([{ method: 'Input.insertText', params: { text: 'abc' } }]);
  });

  it('a target that already has focus is not clicked again', async () => {
    const field = doc.el('input', { id: 'q' });
    doc.body.append(field);
    stackAt(field);
    doc.activeElement = field;
    typesInto(field);
    await handleType({ tabId: 1, target: '#q', text: 'x' });
    expect(pressed()).toEqual([]);
  });

  it('a password field is reported masked: value: ••••, the value never leaves the page', async () => {
    const pw = doc.el('input', { id: 'pw', type: 'password' });
    doc.body.append(pw);
    stackAt(pw);
    typesInto(pw);
    const res = await handleType({ tabId: 1, target: '#pw', text: 'hunter2' });
    expect(res.text).toContain('value: ••••');
    expect(res.text).not.toContain('hunter2');
    expect(res.value).toBe('••••');
  });

  it('without a target, text goes into the focused field; with none focused it is NO_FOCUS', async () => {
    const field = doc.el('input', { id: 'f' });
    doc.body.append(field);
    doc.activeElement = field;
    typesInto(field);
    expect(await handleType({ tabId: 1, text: 'hi' })).toMatchObject({ success: true, value: 'hi' });
    expect(pressed()).toEqual([]);
    doc.activeElement = doc.body;
    expect(await handleType({ tabId: 1, text: 'hi' })).toMatchObject({ success: false, error: expect.stringMatching(/^NO_FOCUS: /) });
  });

  it('clear without text selects and deletes with Backspace (no insertText)', async () => {
    const field = doc.el('input', { id: 'q' });
    doc.body.append(field);
    stackAt(field);
    doc.activeElement = field;
    const res = await handleType({ tabId: 1, target: '#q', clear: true });
    expect(res.text).toBe('cleared #q');
    expect(keysDown().map((c) => c.params.key)).toEqual(['Backspace']);
    expect(cdp.some((c) => c.method === 'Input.insertText')).toBe(false);
  });

  it('key takes one key or combo: Control+a sends the modifier, and the result names it', async () => {
    doc.activeElement = doc.el('input', { id: 'f' });
    const res = await handleType({ tabId: 1, key: 'Control+a' });
    expect(res.text).toBe('pressed Control+a');
    expect(keysDown().map((c) => c.params)).toMatchObject([{ key: 'Control', modifiers: 2 }, { key: 'a', modifiers: 2 }]);
  });

  it('submit presses Enter after the text', async () => {
    const field = doc.el('input', { id: 'q' });
    doc.body.append(field);
    stackAt(field);
    doc.activeElement = field;
    typesInto(field);
    const res = await handleType({ tabId: 1, target: '#q', text: 'go', submit: true });
    expect(res.text).toContain('submitted with Enter');
    expect(keysDown().map((c) => c.params.key)).toEqual(['Enter']);
  });

  it('an unknown key name is UNKNOWN_KEY, before anything is sent', async () => {
    await expect(handleType({ tabId: 1, key: 'Hello' })).rejects.toThrow(/^UNKNOWN_KEY: "Hello"/);
    expect(inputs()).toEqual([]);
  });

  it('nothing to do is INVALID_ARGUMENT', async () => {
    await expect(handleType({ tabId: 1, target: '#q' })).rejects.toThrow(/^INVALID_ARGUMENT: browser_type needs/);
  });
});

describe('browser_fill', () => {
  function field(id: string, value = ''): FakeElement {
    const el = doc.el('input', { id }, '');
    el.value = value;
    doc.body.append(el);
    return el;
  }

  it('a text field gets its string by a trusted focus click, select-all and one insertText', async () => {
    const name = field('name');
    stackAt(name);
    typesInto(name);
    const res = await handleFill({ tabId: 1, fields: [{ target: '#name', value: 'Ada' }] });
    expect(res).toMatchObject({ success: true, filled: 1 });
    expect(res.text).toBe('filled 1 fields');
    expect(name.value).toBe('Ada');
    expect(pressed()).toHaveLength(1);
  });

  it('a text field inside a same-origin iframe: the press lands at its top-level point and the text goes into the frame', async () => {
    const frame = doc.el('iframe', { id: 'pay' });
    doc.body.append(frame);
    const inner = installFakeFrame(frame);
    const card = inner.el('input', { id: 'card' }, '');
    inner.body.append(card);
    stackAt(card);
    // The browser presses on the field and types into the frame's focused element.
    cdpReply = (method, params) => {
      if (method === 'Input.dispatchMouseEvent' && params.type === 'mousePressed') card.focus();
      if (method === 'Input.insertText') card.value = `${card.value ?? ''}${params.text}`;
      return {};
    };
    const res = await handleFill({ tabId: 1, fields: [{ target: '#card', value: 'Ada' }] });
    expect(res).toMatchObject({ success: true, filled: 1 });
    expect(card.value).toBe('Ada');
    // The field's centre (60, 20) in its frame, plus the frame's offset (10, 10) = the top-level point.
    expect(pressed()).toHaveLength(1);
    expect(pressed()[0].params).toMatchObject({ x: 70, y: 30 });
  });

  it('an empty string clears the field with Backspace', async () => {
    const name = field('name', 'old');
    stackAt(name);
    doc.activeElement = name;
    await handleFill({ tabId: 1, fields: [{ target: '#name', value: '' }] });
    expect(keysDown().map((c) => c.params.key)).toEqual(['Backspace']);
  });

  it('a select picks by exact value, else by label (trimmed, case-insensitive), and fires input then change', async () => {
    const sel = doc.el('select', { id: 'c' });
    (sel as any).options = [{ value: 'r', textContent: ' Red ' }, { value: 'g', textContent: 'Green' }];
    (sel as any).selectedIndex = 0;
    (sel as any).dispatchEvent = (e: { type: string }) => { sel.events.push(e.type); return true; };
    doc.body.append(sel);
    const res = await handleFill({ tabId: 1, fields: [{ target: '#c', value: 'GREEN' }] });
    expect(res).toMatchObject({ success: true });
    expect((sel as any).selectedIndex).toBe(1);
    expect(sel.events).toEqual(['input', 'change']);
    await handleFill({ tabId: 1, fields: [{ target: '#c', value: 'r' }] });
    expect((sel as any).selectedIndex).toBe(0);
  });

  it('an option that matches nothing is OPTION_NOT_FOUND and lists up to five labels', async () => {
    const sel = doc.el('select', { id: 'c' });
    (sel as any).options = ['Red', 'Green', 'Blue', 'Amber', 'Teal', 'Plum'].map((label, i) => ({ value: `v${i}`, textContent: label }));
    doc.body.append(sel);
    const res = await handleFill({ tabId: 1, fields: [{ target: '#c', value: 'nope' }] });
    expect(res.success).toBe(false);
    expect(res.error).toContain('OPTION_NOT_FOUND: "nope" (options: Red, Green, Blue, Amber, Teal, …)');
    expect(res.error).not.toContain('Plum');
  });

  it('a checkbox is clicked only when its state differs from the value', async () => {
    const box = doc.el('input', { id: 'remember', type: 'checkbox' });
    doc.body.append(box);
    stackAt(box);
    box.checked = false;
    await handleFill({ tabId: 1, fields: [{ target: '#remember', value: false }] });
    expect(pressed()).toEqual([]);
    await handleFill({ tabId: 1, fields: [{ target: '#remember', value: true }] });
    expect(pressed()).toHaveLength(1);
  });

  it('a radio takes true only', async () => {
    const r = doc.el('input', { id: 'r', type: 'radio' });
    doc.body.append(r);
    const res = await handleFill({ tabId: 1, fields: [{ target: '#r', value: false }] });
    expect(res.error).toContain('INVALID_ARGUMENT: #r is a radio button');
  });

  it('a file input gets DOM.setFileInputFiles with the absolute paths, and the marker is removed', async () => {
    const file = doc.el('input', { id: 'up', type: 'file' });
    doc.body.append(file);
    cdpReply = (method) => (method === 'Runtime.evaluate' ? { result: { objectId: 'obj-1' } } : {});
    const res = await handleFill({ tabId: 1, fields: [{ target: '#up', value: ['/tmp/a.pdf'] }] });
    expect(res).toMatchObject({ success: true });
    expect(cdp.find((c) => c.method === 'DOM.setFileInputFiles')?.params).toEqual({ files: ['/tmp/a.pdf'], objectId: 'obj-1' });
    expect(file.attrs.has('data-bc-upload')).toBe(false);
  });

  it('a field that is not a form field is INVALID_ARGUMENT naming its tag', async () => {
    doc.body.append(doc.el('button', { id: 'b' }, 'Go'));
    const res = await handleFill({ tabId: 1, fields: [{ target: '#b', value: 'x' }] });
    expect(res.error).toContain('#b: INVALID_ARGUMENT: #b is a <button>, not a form field');
  });

  it('one failing field does not stop the others; the error lists only the failed one', async () => {
    const a = field('a');
    const c = field('c');
    // Second field lower on the page, so the two boxes do not cover each other.
    (c as any).getBoundingClientRect = () => ({ x: 10, y: 100, left: 10, top: 100, width: 100, height: 20, right: 110, bottom: 120 });
    (doc as any).elementsFromPoint = (x: number, y: number) => [a, c].filter((el) => {
      const r = el.getBoundingClientRect();
      return x >= r.left && x <= r.left + r.width && y >= r.top && y <= r.top + r.height;
    });
    typesInto(a);
    doc.activeElement = a;
    const res = await handleFill({ tabId: 1, fields: [{ target: '#a', value: 'one' }, { target: '#missing', value: 'x' }, { target: '#c', value: 'three' }] });
    expect(res.success).toBe(false);
    expect(res.error.split('\n')[0]).toBe('FILL_FAILED: 1 of 3 fields failed');
    expect(res.error.split('\n')[1]).toMatch(/^#missing: NOT_FOUND: /);
    expect(res.error).not.toContain('#a:');
    expect(a.value).toBe('one');
    expect(c.value).toBe('three');
  });
});

describe('browser_handle_dialog', () => {
  it('accept:true answers the open dialog and reports what it accepted', async () => {
    dialogListeners.forEach((fn) => fn({ tabId: 1 }, 'Page.javascriptDialogOpening', { type: 'prompt', message: 'Name?', url: urlNow, frameId: 'f1', defaultPrompt: '' }));
    const res = await handleDialog({ tabId: 1, accept: true, promptText: 'Ada' });
    expect(res.text).toBe('accepted prompt "Name?"');
    expect(cdp.find((c) => c.method === 'Page.handleJavaScriptDialog')?.params).toEqual({ accept: true, promptText: 'Ada' });
  });
});

// FIX-INPUT (wave 2): a dialog that an input opens settles the input, a renderer that never acks is
// wedged after the input budget, an aborted call sends nothing new, a dialog message is clipped, and
// fill reads a text value back before it reports the field filled.

/** Fires a JS dialog the way Chrome does, on the tab's session. */
function openDialog(type: string, message: string) {
  for (const fn of dialogListeners) fn({ tabId: 1 }, 'Page.javascriptDialogOpening', { type, message, url: urlNow, frameId: 'f1', defaultPrompt: '' });
}
/** A dispatch the renderer never acknowledges (it is inside a modal dialog). */
const never = () => new Promise<unknown>(() => {});

describe('an input that opens a JS dialog settles at once (the confirm() hang)', () => {
  it('a click whose release never acks because confirm() opened: clicked + dialog line, well before the tool timeout', async () => {
    const btn = doc.el('button', { id: 'del' }, 'Delete');
    doc.body.append(btn);
    stackAt(btn);
    cdpReply = (method, params) => {
      if (method === 'Input.dispatchMouseEvent' && params.type === 'mouseReleased') { openDialog('confirm', 'Delete this item?'); return never(); }
      return browserReply(method, params);
    };
    const t0 = Date.now();
    const res = await handleClick({ tabId: 1, target: '#del' });
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(res.text).toBe('clicked #del\ndialog: confirm "Delete this item?"');
    expect(res.dialog).toMatchObject({ type: 'confirm', message: 'Delete this item?' });
    await handleDialog({ tabId: 1, accept: true });
  });

  it('a dialog opened by the press: the release is never sent (nothing is pressed on a blocked page)', async () => {
    const btn = doc.el('button', { id: 'go' }, 'Go');
    doc.body.append(btn);
    stackAt(btn);
    cdpReply = (method, params) => {
      if (method === 'Input.dispatchMouseEvent' && params.type === 'mousePressed') { openDialog('alert', 'Heads up'); return never(); }
      return browserReply(method, params);
    };
    const res = await handleClick({ tabId: 1, target: '#go' });
    expect(res.text).toBe('clicked #go\ndialog: alert "Heads up"');
    expect(cdp.filter((c) => c.params.type === 'mouseReleased')).toEqual([]);
    await handleDialog({ tabId: 1, accept: true });
  });

  it('a dialog that is already open refuses the input before anything is sent: DIALOG_OPEN', async () => {
    const btn = doc.el('button', { id: 'go' }, 'Go');
    doc.body.append(btn);
    stackAt(btn);
    openDialog('confirm', 'Still open?');
    await expect(handleClick({ tabId: 1, target: '#go' })).rejects.toThrow(/^DIALOG_OPEN: a confirm "Still open\?" is open on tab 1/);
    expect(inputs()).toEqual([]);
    await handleDialog({ tabId: 1, accept: true });
  });

  it('Enter that submits into a confirm(): the key-down settles, no key-up is sent, the dialog is reported', async () => {
    const field = doc.el('input', { id: 'q' });
    doc.body.append(field);
    doc.activeElement = field;
    cdpReply = (method, params) => {
      if (method === 'Input.dispatchKeyEvent' && params.type === 'keyDown' && params.key === 'Enter') { openDialog('confirm', 'Submit?'); return never(); }
      return browserReply(method, params);
    };
    const res = await handleType({ tabId: 1, key: 'Enter' });
    expect(res.text).toBe('pressed Enter\ndialog: confirm "Submit?"');
    expect(cdp.filter((c) => c.method === 'Input.dispatchKeyEvent' && c.params.type === 'keyUp')).toEqual([]);
    await handleDialog({ tabId: 1, accept: true });
  });

  it('a dialog longer than 200 characters is clipped in the result line', async () => {
    const btn = doc.el('button', { id: 'del' }, 'Delete');
    doc.body.append(btn);
    stackAt(btn);
    const long = 'x'.repeat(300);
    cdpReply = (method, params) => {
      if (method === 'Input.dispatchMouseEvent' && params.type === 'mouseReleased') { openDialog('confirm', long); return never(); }
      return browserReply(method, params);
    };
    const res = await handleClick({ tabId: 1, target: '#del' });
    expect(res.text).toBe(`clicked #del\ndialog: confirm "${'x'.repeat(200)}…"`);
    expect(res.dialog.message).toBe(long);
    await handleDialog({ tabId: 1, accept: true });
  });

  it('fill: a checkbox click that opens a dialog stops the fill; the later fields are not filled', async () => {
    const box = doc.el('input', { id: 'remember', type: 'checkbox' });
    const name = doc.el('input', { id: 'name' }, '');
    doc.body.append(box, name);
    stackAt(box);
    cdpReply = (method, params) => {
      if (method === 'Input.dispatchMouseEvent' && params.type === 'mouseReleased') { openDialog('confirm', 'Forget me?'); return never(); }
      return browserReply(method, params);
    };
    const res = await handleFill({ tabId: 1, fields: [{ target: '#remember', value: true }, { target: '#name', value: 'Ada' }] });
    expect(res.success).toBe(false);
    expect(res.error.split('\n')[0]).toBe('FILL_FAILED: 2 of 2 fields failed');
    expect(res.error).toContain('#remember: DIALOG_OPEN: confirm "Forget me?" opened while filling');
    expect(res.error).toContain('#name: DIALOG_OPEN: not filled, a dialog is open');
    expect(cdp.some((c) => c.method === 'Input.insertText')).toBe(false);
    await handleDialog({ tabId: 1, accept: true });
  });
});

describe('an input the renderer never acks (input budget)', () => {
  it('a press that is never acked: TAB_WEDGED after the budget, the tab is marked wedged, nothing else is sent', async () => {
    const btn = doc.el('button', { id: 'go' }, 'Go');
    doc.body.append(btn);
    stackAt(btn);
    // The press is never acked, and the page is frozen from then on: its probe never answers either, so the mark stays.
    cdpReply = (method, params) => {
      if (method === 'Input.dispatchMouseEvent' && params.type === 'mousePressed') { scriptFrozen = true; return never(); }
      return browserReply(method, params);
    };
    try {
      await expect(handleClick({ tabId: 1, target: '#go' })).rejects.toThrow(/^TAB_WEDGED: tab 1 did not respond within 5\.0s/);
      expect(wedgedTabs.has(1)).toBe(true);
      expect(cdp.filter((c) => c.params.type === 'mouseReleased')).toEqual([]);
    } finally {
      scriptFrozen = false;
      wedgedTabs.delete(1);
    }
  }, 15_000);
});

describe('an aborted call (the bridge timed it out) sends no new input', () => {
  it('already aborted: TIMEOUT before the first dispatch, nothing pressed', async () => {
    const btn = doc.el('button', { id: 'go' }, 'Go');
    doc.body.append(btn);
    stackAt(btn);
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(handleClick({ tabId: 1, target: '#go' }, 'session', 'agent', ctrl.signal)).rejects.toThrow(/^TIMEOUT: /);
    expect(inputs()).toEqual([]);
  });

  it('aborted between the move and the press: the press is not sent', async () => {
    const btn = doc.el('button', { id: 'go' }, 'Go');
    doc.body.append(btn);
    stackAt(btn);
    const ctrl = new AbortController();
    cdpReply = (method, params) => {
      if (method === 'Input.dispatchMouseEvent' && params.type === 'mouseMoved') ctrl.abort();
      return {};
    };
    await expect(handleClick({ tabId: 1, target: '#go' }, 'session', 'agent', ctrl.signal)).rejects.toThrow(/^TIMEOUT: /);
    expect(pressed()).toEqual([]);
  });

  it('aborted after the press went out: the release still goes out, so no button is left down', async () => {
    const btn = doc.el('button', { id: 'go' }, 'Go');
    doc.body.append(btn);
    stackAt(btn);
    const ctrl = new AbortController();
    cdpReply = (method, params) => {
      if (method === 'Input.dispatchMouseEvent' && params.type === 'mousePressed') ctrl.abort();
      return {};
    };
    await handleClick({ tabId: 1, target: '#go' }, 'session', 'agent', ctrl.signal).catch(() => undefined);
    expect(cdp.filter((c) => c.params.type === 'mouseReleased')).toHaveLength(1);
  });

  it('type: aborted before the key-down sends no key; aborted between key-down and key-up still sends the key-up', async () => {
    doc.activeElement = doc.el('input', { id: 'f' });
    const before = new AbortController();
    before.abort();
    await expect(handleType({ tabId: 1, key: 'Tab' }, 'session', 'agent', before.signal)).rejects.toThrow(/^TIMEOUT: /);
    expect(keysDown()).toEqual([]);
    const during = new AbortController();
    cdpReply = (method, params) => {
      if (method === 'Input.dispatchKeyEvent' && params.type === 'rawKeyDown') during.abort();
      return {};
    };
    await handleType({ tabId: 1, key: 'Tab' }, 'session', 'agent', during.signal).catch(() => undefined);
    expect(cdp.filter((c) => c.method === 'Input.dispatchKeyEvent' && c.params.type === 'keyUp')).toHaveLength(1);
  });
});

describe('a drag that fails mid-way still releases the button', () => {
  it('a throw in the move steps: mouseReleased is still sent, the error reaches the caller', async () => {
    const src = doc.el('div', { id: 'src' }, 'Card');
    const dst = doc.el('div', { id: 'dst' }, 'Column');
    (dst as any).getBoundingClientRect = () => ({ x: 200, y: 200, left: 200, top: 200, width: 100, height: 40, right: 300, bottom: 240 });
    doc.body.append(src, dst);
    (doc as any).elementsFromPoint = (x: number, y: number) => [src, dst].filter((el) => {
      const r = el.getBoundingClientRect();
      return x >= r.left && x <= r.left + r.width && y >= r.top && y <= r.top + r.height;
    });
    let moves = 0;
    cdpReply = (method, params) => {
      if (method === 'Input.dispatchMouseEvent' && params.type === 'mouseMoved' && ++moves === 4) throw new Error('boom: renderer went away');
      return browserReply(method, params);
    };
    await expect(handleClick({ tabId: 1, target: '#src', dragTo: '#dst' })).rejects.toThrow('boom: renderer went away');
    expect(cdp.filter((c) => c.params.type === 'mousePressed')).toHaveLength(1);
    expect(cdp.filter((c) => c.params.type === 'mouseReleased')).toHaveLength(1);
  });
});

describe('browser_fill reads a text value back before it reports the field filled', () => {
  it('a field that takes no input is VALUE_NOT_SET and the call is FILL_FAILED', async () => {
    const name = doc.el('input', { id: 'name' }, '');
    doc.body.append(name);
    stackAt(name);
    cdpReply = (method, params) => (method === 'Input.insertText' ? {} : browserReply(method, params));
    const res = await handleFill({ tabId: 1, fields: [{ target: '#name', value: 'Ada' }] });
    expect(res.success).toBe(false);
    expect(res.error).toBe('FILL_FAILED: 1 of 1 fields failed\n#name: VALUE_NOT_SET: kept ""');
  });

  it('an empty password field that takes no input reads kept "", not ••••', async () => {
    const pin = doc.el('input', { id: 'code', type: 'password' }, '');
    pin.value = '';
    doc.body.append(pin);
    stackAt(pin);
    cdpReply = (method, params) => (method === 'Input.insertText' ? {} : browserReply(method, params));
    const res = await handleFill({ tabId: 1, fields: [{ target: '#code', value: '477086' }] });
    expect(res.error).toBe('FILL_FAILED: 1 of 1 fields failed\n#code: VALUE_NOT_SET: kept ""');
  });

  it('a read-only field is ELEMENT_READONLY and nothing is sent to it', async () => {
    const name = doc.el('input', { id: 'name' }, '');
    name.readOnly = true;
    doc.body.append(name);
    stackAt(name);
    const res = await handleFill({ tabId: 1, fields: [{ target: '#name', value: 'Ada' }] });
    expect(res.error).toBe('FILL_FAILED: 1 of 1 fields failed\n#name: ELEMENT_READONLY: input#name is read-only; nothing was typed.');
    expect(inputs()).toEqual([]);
  });

  it('a field that takes the text reads back the same value: filled', async () => {
    const name = doc.el('input', { id: 'name' }, '');
    doc.body.append(name);
    stackAt(name);
    typesInto(name);
    expect(await handleFill({ tabId: 1, fields: [{ target: '#name', value: 'Ada' }] })).toMatchObject({ success: true, filled: 1 });
  });
});

describe('browser_fill: a file input takes absolute paths only (a relative path would resolve in Chrome\'s own cwd)', () => {
  it('a relative path into a credential folder is refused before anything is sent (nothing reaches DOM.setFileInputFiles)', async () => {
    const up = doc.el('input', { id: 'up', type: 'file' });
    doc.body.append(up);
    cdpReply = (method) => (method === 'Runtime.evaluate' ? { result: { objectId: 'obj-1' } } : {});
    const res = await handleFill({ tabId: 1, fields: [{ target: '#up', value: ['Users/me/.ssh/id_rsa'] }] });
    expect(res.success).toBe(false);
    expect(res.error).toBe('FILL_FAILED: 1 of 1 fields failed\n#up: INVALID_ARGUMENT: #up is a file input: give absolute file paths (got a relative path)');
    // The attach's own viewport probe is a Runtime.evaluate too: only the upload marker lookup counts.
    expect(cdp.filter((c) => c.method === 'DOM.setFileInputFiles' || (c.method === 'Runtime.evaluate' && String(c.params.expression).includes('data-bc-upload')))).toEqual([]);
  });

  it('a relative path with an absolute one in the same list: the whole list is refused, the absolute one is not sent', async () => {
    const up = doc.el('input', { id: 'up', type: 'file' });
    doc.body.append(up);
    const res = await handleFill({ tabId: 1, fields: [{ target: '#up', value: ['/tmp/a.pdf', '../../.ssh/id_rsa'] }] });
    expect(res.error).toContain('#up: INVALID_ARGUMENT: #up is a file input: give absolute file paths (got a relative path)');
    expect(cdp.filter((c) => c.method === 'DOM.setFileInputFiles')).toEqual([]);
  });
});

describe('browser_fill: paths the server could not read are judged by the element kind', () => {
  it('a file input flagged missing: FILE_NOT_FOUND for the whole call, nothing is filled', async () => {
    const up = doc.el('input', { id: 'up', type: 'file' });
    const name = doc.el('input', { id: 'name' }, '');
    name.value = 'before';
    doc.body.append(up, name);
    cdpReply = (method) => (method === 'Runtime.evaluate' ? { result: { objectId: 'obj-1' } } : {});
    await expect(handleFill({ tabId: 1, fields: [{ target: '#name', value: 'Ada' }, { target: '#up', value: ['/tmp/a.pdf'], missingFiles: ['a.pdf'] }] }))
      .rejects.toThrow('FILE_NOT_FOUND: a.pdf does not exist or is not a readable file; nothing was filled.');
    expect(cdp.some((c) => c.method === 'DOM.setFileInputFiles' || c.method === 'Input.insertText' || c.method === 'Input.dispatchMouseEvent')).toBe(false);
    expect(name.value).toBe('before');
  });

  it('a select flagged missing for its path-like option values is still filled by value', async () => {
    const sel = doc.el('select', { id: 'lang' });
    (sel as any).options = [{ value: '/en', textContent: 'English' }, { value: '/fr', textContent: 'Français' }];
    (sel as any).selectedIndex = 0;
    doc.body.append(sel);
    const res = await handleFill({ tabId: 1, fields: [{ target: '#lang', value: '/fr', missingFiles: ['fr'] }] });
    expect(res).toMatchObject({ success: true, filled: 1 });
    expect((sel as any).selectedIndex).toBe(1);
  });
});

describe('a ref from an earlier document of the tab gets the earlier-page wording', () => {
  it('click on e3 when the tab already showed refs up to e5: REF_GONE "is from an earlier page", nothing pressed', async () => {
    // A new document whose counter starts above the refs the tab's earlier document showed (up to e5).
    delete (globalThis as any).__bcDom;
    delete (globalThis as any).__browserControllerRefState;
    PAGE_DOM_INSTALL(PAGE_DOM_VERSION, 5);
    try {
      const btn = doc.el('button', { id: 'go' }, 'Go');
      doc.body.append(btn);
      stackAt(btn);
      const res = await handleClick({ tabId: 1, target: 'e3' });
      expect(res).toMatchObject({ success: false, error: expect.stringMatching(/^REF_GONE: ref e3 is from an earlier page \(the page navigated or reloaded\)/) });
      expect(pressed()).toEqual([]);
    } finally {
      delete (globalThis as any).__bcDom;
      delete (globalThis as any).__browserControllerRefState;
      PAGE_DOM_INSTALL(PAGE_DOM_VERSION);
    }
  });
});

describe('a ref re-found by its snapshot descriptor is said so in the reply (note line, last)', () => {
  it('click: the reply ends with the note line naming the ref', async () => {
    const btn = doc.el('button', { id: 'save' }, 'Save');
    doc.body.append(btn);
    stackAt(btn);
    fallbackByTab.set(1, new Map([['e12', { text: 'Save', role: 'button', tag: 'BUTTON', nth: 0 }]]));
    const res = await handleClick({ tabId: 1, target: 'e12' });
    expect(res.success).toBe(true);
    expect(res.text).toBe('clicked e12\nnote: e12 was re-found after the page changed');
  });

  it('fill: a text field re-found by its descriptor gets one note line; a field found directly does not', async () => {
    const name = doc.el('input', { id: 'name', 'aria-label': 'Name' }, '');
    doc.body.append(name);
    stackAt(name);
    typesInto(name);
    fallbackByTab.set(1, new Map([['e4', { robustSelector: 'input#name', tag: 'INPUT', nth: 0 }]]));
    const res = await handleFill({ tabId: 1, fields: [{ target: 'e4', value: 'Ada' }] });
    expect(res).toMatchObject({ success: true, filled: 1 });
    expect(res.text).toBe('filled 1 fields\nnote: e4 was re-found after the page changed');
  });
});

describe('a file chooser that agent input opens is intercepted, not shown', () => {
  const chooserCalls = () => cdp.filter((c) => c.method === 'Page.setInterceptFileChooserDialog').map((c) => c.params);
  const graceOver = () => new Promise((r) => setTimeout(r, CHOOSER_GRACE_MS + 50));
  function uploadButton() {
    const btn = doc.el('button', { id: 'up' }, 'Upload');
    doc.body.append(btn);
    stackAt(btn);
  }

  it('interception goes on before the press, and off once the grace after the call is over', async () => {
    uploadButton();
    await handleClick({ tabId: 1, target: '#up' });
    const order = cdp.map((c) => (c.method === 'Input.dispatchMouseEvent' ? c.params.type : c.method === 'Page.setInterceptFileChooserDialog' ? `chooser:${c.params.enabled}` : c.method));
    expect(order.indexOf('chooser:true')).toBeLessThan(order.indexOf('mousePressed'));
    expect(chooserCalls()).toEqual([{ enabled: true, cancel: true }]);
    // The user's own click on an upload button shows the dialog again after the grace.
    await graceOver();
    expect(chooserCalls()).toEqual([{ enabled: true, cancel: true }, { enabled: false }]);
  });

  it('input calls back to back share one interception: on once, off once after the last', async () => {
    uploadButton();
    await handleClick({ tabId: 1, target: '#up' });
    await handleType({ tabId: 1, key: 'Enter' });
    expect(chooserCalls()).toEqual([{ enabled: true, cancel: true }]);
    await graceOver();
    expect(chooserCalls()).toEqual([{ enabled: true, cancel: true }, { enabled: false }]);
  });

  it('the chooser the click opened is kept for the result line, once', async () => {
    uploadButton();
    cdpReply = (method, params) => {
      if (method === 'Input.dispatchMouseEvent' && params.type === 'mouseReleased') {
        for (const fn of dialogListeners) fn({ tabId: 1 }, 'Page.fileChooserOpened', { frameId: 'f1', mode: 'selectSingle', backendNodeId: 7 });
      }
      return browserReply(method, params);
    };
    const res = await handleClick({ tabId: 1, target: '#up' });
    expect(res).toMatchObject({ success: true, text: 'clicked #up' });
    expect(takeFileChooser(1)).toEqual({ frameId: 'f1', mode: 'selectSingle', backendNodeId: 7 });
    expect(takeFileChooser(1)).toBeNull();
  });

  it('a Chrome that refuses the interception still gets the click, and nothing is switched off after it', async () => {
    uploadButton();
    cdpReply = (method, params) => {
      if (method === 'Page.setInterceptFileChooserDialog') throw new Error("'Page.setInterceptFileChooserDialog' wasn't found");
      return browserReply(method, params);
    };
    const res = await handleClick({ tabId: 1, target: '#up' });
    expect(res).toMatchObject({ success: true, text: 'clicked #up' });
    expect(pressed()).toHaveLength(1);
    await graceOver();
    expect(chooserCalls()).toEqual([{ enabled: true, cancel: true }]);
  });
});
