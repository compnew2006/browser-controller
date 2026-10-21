import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installFakeFrame, installFakePage, type FakeDocument, type FakeElement } from './helpers/fake-dom.js';

/**
 * WP V3-READ (contract 3.0 tools 3, 4, 9, 10, 11): snapshot, text, scroll, wait, evaluate.
 * The CDP mock below runs evaluate sources for real (node's eval; a parse check is a function
 * expression that is never called, so it runs nothing), so the statement-body and throw cases are not faked.
 */

type Sent = { method: string; params: Record<string, any> };
const cdp: Sent[] = [];
const cdpState = {
  attachError: null as Error | null,
  onWheel: null as null | ((params: Record<string, any>) => void),
  objects: new Map<string, unknown>(),
  hang: false,
};

(globalThis as any).chrome = {
  tabs: {
    get: async (id: number) => ({ id, url: 'https://example.test/page', windowId: 1 }),
    query: async () => [],
    onRemoved: { addListener: () => {} },
  },
  windows: { get: async () => ({ width: 1280, height: 900 }) },
  // The page function runs in-process against the fake page.
  scripting: { executeScript: async (o: { func: (...a: any[]) => unknown; args?: unknown[] }) => [{ result: await o.func(...(o.args ?? [])) }] },
  storage: { session: { get: async () => ({}), set: async () => {} }, local: { get: async () => ({}), set: async () => {} } },
  debugger: {
    attach: async () => { if (cdpState.attachError) throw cdpState.attachError; },
    detach: async () => {},
    sendCommand: async (_t: unknown, method: string, params: Record<string, any> = {}) => {
      cdp.push({ method, params });
      if (method === 'Input.dispatchMouseEvent' && params.type === 'mouseWheel') cdpState.onWheel?.(params);
      if (method === 'Runtime.evaluate') {
        // A parse check is a function expression that is never called: evaluating it runs nothing.
        if (params.expression === 'innerWidth * innerHeight') return { result: { type: 'number', value: 1 } };
        if (cdpState.hang) return new Promise(() => {});
        try {
          const value = await (0, eval)(params.expression);
          if (value !== null && typeof value === 'object') {
            const objectId = `o${cdpState.objects.size + 1}`;
            cdpState.objects.set(objectId, value);
            return { result: { type: 'object', objectId } };
          }
          return { result: { type: typeof value, value: value === undefined ? undefined : value } };
        } catch (err) {
          return { result: {}, exceptionDetails: { exception: { description: `${(err as Error).name}: ${(err as Error).message}\n    at <anonymous>` } } };
        }
      }
      if (method === 'Runtime.callFunctionOn') return { result: { value: JSON.stringify(cdpState.objects.get(params.objectId)) } };
      return {};
    },
    onEvent: { addListener: () => {} },
    onDetach: { addListener: () => {} },
  },
  action: { setBadgeBackgroundColor: () => {}, setBadgeText: () => {} },
  runtime: { sendMessage: async () => {}, onMessage: { addListener: () => {} } },
  alarms: { create: () => {}, onAlarm: { addListener: () => {} } },
  webRequest: { onCompleted: { addListener: () => {} } },
};

const { PAGE_DOM_INSTALL, PAGE_DOM_VERSION } = await import('../extension/lib/page-dom.js');
const { handleSnapshot, handleGetPageText, handleWait, handleScroll } = await import('../extension/handlers/inspection.js');
const { handleEvaluate } = await import('../extension/handlers/evaluate.js');
const { fallbackByTab } = await import('../extension/lib/state.js');
const { detachCdp } = await import('../extension/lib/cdp-session.js');

let doc: FakeDocument;
const D = () => (globalThis as any).__bcDom;
const sentMethods = () => cdp.map((c) => c.method);

/** Computed style that knows display:none, opacity:0, overflow:auto and display:contents. */
function styled(el: FakeElement) {
  const style = el.attrs.get('style') || '';
  return {
    display: style.includes('display:contents') ? 'contents' : el.isHiddenInTree ? 'none' : 'block',
    visibility: style.includes('visibility:hidden') ? 'hidden' : 'visible',
    opacity: style.includes('opacity:0') ? '0' : '1',
    overflowY: style.includes('overflow:auto') ? 'auto' : 'visible',
    overflowX: style.includes('overflow:auto') ? 'auto' : 'visible',
    whiteSpace: 'normal',
  };
}

beforeEach(async () => {
  doc = installFakePage();
  fallbackByTab.clear();
  PAGE_DOM_INSTALL(PAGE_DOM_VERSION);
  (globalThis as any).innerWidth = 1000;
  (globalThis as any).innerHeight = 800;
  doc.defaultView.getComputedStyle = (el: FakeElement) => styled(el) as any;
  (globalThis as any).getComputedStyle = doc.defaultView.getComputedStyle;
  cdp.length = 0;
  cdpState.attachError = null;
  cdpState.onWheel = null;
  cdpState.objects.clear();
  cdpState.hang = false;
  await detachCdp(1);
});

afterEach(async () => {
  fallbackByTab.clear();
  await detachCdp(1); // clears the session's idle timer
});

describe('snapshot refs are stable per element', () => {
  it('an element keeps its e<n> ref across snapshots; a new element takes the next number', async () => {
    doc.body.append(doc.el('button', {}, 'Save'));
    const first = await handleSnapshot({ tabId: 1 });
    const save = first.refs.find((r: any) => r.name === 'Save').ref;
    expect(save).toMatch(/^e\d+$/);
    const again = await handleSnapshot({ tabId: 1 });
    expect(again.refs.find((r: any) => r.name === 'Save').ref).toBe(save);
    doc.body.append(doc.el('button', {}, 'Cancel'));
    const third = await handleSnapshot({ tabId: 1 });
    const cancel = third.refs.find((r: any) => r.name === 'Cancel').ref;
    expect(Number(cancel.slice(1))).toBe(Number(save.slice(1)) + 1);
  });

  it('a ref whose element left is REF_GONE (it was issued here); a ref never issued is REF_NOT_FOUND', async () => {
    const go = doc.el('button', {}, 'Go');
    doc.body.append(go);
    const ref = (await handleSnapshot({ tabId: 1 })).refs[0].ref;
    go.isConnected = false;
    doc.body.childNodes.length = 0;
    const gone = await handleSnapshot({ tabId: 1, target: ref });
    expect(gone.success).toBe(false);
    expect(gone.error).toMatch(new RegExp(`^REF_GONE: ref ${ref} is no longer on the page`));
    const never = await handleSnapshot({ tabId: 1, target: 'e999' });
    expect(never.error).toMatch(/^REF_NOT_FOUND: ref e999 is not on this page/);
  });

  it('the registry drops the refs of elements that left at the next snapshot', async () => {
    const go = doc.el('button', {}, 'Go');
    doc.body.append(go);
    const ref = (await handleSnapshot({ tabId: 1 })).refs[0].ref;
    expect(D().registry.has(ref)).toBe(true);
    go.isConnected = false;
    doc.body.childNodes.length = 0;
    await handleSnapshot({ tabId: 1 });
    expect(D().registry.has(ref)).toBe(false);
  });

  it('the default snapshot never touches the debugger', async () => {
    doc.body.append(doc.el('button', {}, 'Save'));
    await handleSnapshot({ tabId: 1 });
    expect(sentMethods()).toEqual([]);
  });
});

describe('snapshot lines', () => {
  it('prints role, quoted name, [ref] and only the flags that apply, indented by depth', async () => {
    const nav = doc.el('nav', { 'aria-label': 'Main' }, doc.el('a', { href: '/docs' }, 'Docs'));
    const cb = doc.el('input', { type: 'checkbox', 'aria-label': 'Remember me' });
    (cb as any).checked = true;
    const save = doc.el('button', {}, 'Save');
    save.disabled = true;
    const more = doc.el('button', { 'aria-expanded': 'false' }, 'More');
    const name = doc.el('input', { type: 'text', value: 'Ana' });
    const secret = doc.el('input', { type: 'password', value: 'hunter2', 'aria-label': 'Password' });
    const main = doc.el('main', {}, doc.el('h2', {}, 'Settings'));
    doc.body.append(nav, cb, save, more, name, secret, main);
    const res = await handleSnapshot({ tabId: 1 });
    const text: string = res.text;
    expect(text.split('\n')[0]).toBe('page: Fixture — https://example.test/page');
    expect(text).toMatch(/^navigation "Main" \[e\d+\]$/m);
    expect(text).toMatch(/^ {2}link "Docs" \[e\d+\]$/m);
    expect(text).toMatch(/^checkbox "Remember me" \[e\d+\] checked$/m);
    expect(text).toMatch(/^button "Save" \[e\d+\] disabled$/m);
    expect(text).toMatch(/^button "More" \[e\d+\] collapsed$/m);
    expect(text).toMatch(/^textbox \[e\d+\] value="Ana"$/m);
    expect(text).toMatch(/^textbox "Password" \[e\d+\] value="••••"$/m);
    expect(text).not.toContain('hunter2');
    expect(text).not.toContain('href');
    expect(text).toMatch(/^main \[e\d+\]$/m);
    expect(text).toMatch(/^ {2}heading "Settings" \[e\d+\] level=2$/m);
  });

  it('wrappers with no name collapse: their child is printed at their own depth', async () => {
    doc.body.append(doc.el('div', {}, doc.el('div', {}, doc.el('button', {}, 'Deep'))));
    const text: string = (await handleSnapshot({ tabId: 1 })).text;
    expect(text).toMatch(/^button "Deep" \[e\d+\]$/m);
    expect(text.split('\n').filter((l: string) => l.startsWith('generic'))).toEqual([]);
  });

  it('a cross-origin iframe is named and marked not readable, with no ref', async () => {
    doc.body.append(doc.el('iframe', { src: 'https://pay.other.example/embed' }));
    const text: string = (await handleSnapshot({ tabId: 1 })).text;
    expect(text).toContain('iframe "cross-origin https://pay.other.example" (not readable)');
  });

  it('the same-origin frame and the shadow DOM are walked', async () => {
    const frame = doc.el('iframe', {});
    doc.body.append(frame);
    installFakeFrame(frame).body.append(doc.el('button', {}, 'In frame'));
    const host = doc.el('site-menu');
    host.attachShadow().append(doc.el('button', {}, 'In shadow'));
    doc.body.append(host);
    const text: string = (await handleSnapshot({ tabId: 1 })).text;
    expect(text).toContain('button "In frame"');
    expect(text).toContain('button "In shadow"');
  });

  it('look-alike controls get their row text as context; a unique control does not', async () => {
    const rows = ['قطعه', 'درزن'].map((n, i) => doc.el('tr', {}, doc.el('td', {}, String(i + 1)), doc.el('td', {}, n), doc.el('td', {}, doc.el('button', { title: 'تعديل' }))));
    doc.body.append(doc.el('button', {}, 'اضافة'), doc.el('table', {}, doc.el('tbody', {}, ...rows)));
    const text: string = (await handleSnapshot({ tabId: 1 })).text;
    expect(text.match(/^button "اضافة" \[e\d+\]$/m)).not.toBeNull();
    const edits = text.split('\n').filter((l: string) => l.includes('"تعديل"'));
    expect(edits.map((l: string) => l.match(/context="([^"]*)"/)?.[1])).toEqual(['1 قطعه', '2 درزن']);
  });
});

describe('snapshot query, target and maxChars', () => {
  it('query keeps the whole-word matches with their ancestors and drops the rest', async () => {
    doc.body.append(
      doc.el('nav', { 'aria-label': 'Main' }, doc.el('a', { href: '/x' }, 'Pricing')),
      doc.el('main', {}, doc.el('p', {}, 'Other text'), doc.el('button', {}, 'Buy pricing plan')),
    );
    const text: string = (await handleSnapshot({ tabId: 1, query: 'pricing' })).text;
    expect(text).toMatch(/^navigation "Main" \[e\d+\]$/m);
    expect(text).toMatch(/^ {2}link "Pricing" \[e\d+\]$/m);
    expect(text).toMatch(/^ {2}button "Buy pricing plan" \[e\d+\]$/m);
    expect(text).not.toContain('Other text');
  });

  it('query falls back to substring matches when no whole word matches', async () => {
    doc.body.append(doc.el('button', {}, 'Pricing'));
    const text: string = (await handleSnapshot({ tabId: 1, query: 'prici' })).text;
    expect(text).toMatch(/^button "Pricing" \[e\d+\]$/m);
  });

  it('a query with no match says so in one line', async () => {
    doc.body.append(doc.el('button', {}, 'Save'));
    expect((await handleSnapshot({ tabId: 1, query: 'zzz' })).text).toMatch(/\n\(no element matches "zzz"\)$/);
  });

  it('a query of several words keeps an element only when every word is in its role, name or value', async () => {
    doc.body.append(doc.el('button', {}, 'Save'), doc.el('button', {}, 'Cancel'));
    const text: string = (await handleSnapshot({ tabId: 1, query: 'save button' })).text;
    expect(text).toMatch(/^button "Save" \[e\d+\]$/m);
    expect(text).not.toContain('Cancel');
    doc.body.append(doc.el('a', { href: '/pdf' }, 'Save as PDF'));
    const links: string = (await handleSnapshot({ tabId: 1, query: 'save link' })).text;
    expect(links).toMatch(/^link "Save as PDF" \[e\d+\]$/m);
    expect(links).not.toContain('button "Save"');
  });

  it('a word can match the value of a control: "ana textbox" finds the text box that holds Ana', async () => {
    doc.body.append(doc.el('input', { type: 'text', value: 'Ana' }), doc.el('button', {}, 'Send'));
    const text: string = (await handleSnapshot({ tabId: 1, query: 'ana textbox' })).text;
    expect(text).toMatch(/^textbox \[e\d+\] value="Ana"$/m);
    expect(text).not.toContain('Send');
  });

  it('a query whose words no element holds together says no element matches', async () => {
    doc.body.append(doc.el('button', {}, 'Save'));
    expect((await handleSnapshot({ tabId: 1, query: 'save zebra' })).text).toMatch(/\n\(no element matches "save zebra"\)$/);
  });

  it('when no element holds every word whole, the substring matches of every word are kept', async () => {
    doc.body.append(doc.el('p', {}, 'Other text'), doc.el('button', {}, 'Buy pricing plan'));
    const text: string = (await handleSnapshot({ tabId: 1, query: 'prici plan' })).text;
    expect(text).toMatch(/^button "Buy pricing plan" \[e\d+\]$/m);
    expect(text).not.toContain('Other text');
  });

  it('maxChars cuts in page order, says how much is left, and registers no ref past the cut', async () => {
    for (let i = 0; i < 200; i++) doc.body.append(doc.el('button', {}, `Button number ${i}`));
    const res = await handleSnapshot({ tabId: 1, maxChars: 1000 });
    expect(res.truncated).toBe(true);
    expect(res.text).toMatch(/\n… truncated \(\d+ more chars\): narrow with query or target$/);
    expect(res.text.length).toBeLessThan(1000 + 100);
    const printed = res.refs.map((r: any) => Number(r.ref.slice(1)));
    expect(res.refs[0].name).toBe('Button number 0');
    expect(D().registry.has(`e${Math.max(...printed) + 1}`)).toBe(false);
  });

  it('target is the subtree root: its own line, then what is inside it', async () => {
    doc.body.append(doc.el('button', {}, 'Outside'), doc.el('section', { id: 'panel' }, doc.el('button', {}, 'Inside')));
    const text: string = (await handleSnapshot({ tabId: 1, target: '#panel' })).text;
    expect(text).toContain('button "Inside"');
    expect(text).not.toContain('Outside');
  });
});

describe('text', () => {
  it('a target that matches only hidden elements is ELEMENT_HIDDEN, and its text stays out', async () => {
    const hidden = doc.el('div', { class: 'toast' }, 'Secret draft');
    hidden.hidden = true;
    doc.body.append(hidden);
    const res = await handleGetPageText({ tabId: 1, target: '.toast' });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/^ELEMENT_HIDDEN/);
    expect(JSON.stringify(res)).not.toContain('Secret draft');
  });

  it('one walker: same-origin frame text and shadow text are included', async () => {
    const frame = doc.el('iframe', {});
    const host = doc.el('support-table');
    host.attachShadow().append(doc.el('p', {}, 'WebGPU supported'));
    doc.body.append(doc.el('p', {}, 'Top text'), frame, host);
    installFakeFrame(frame).body.append(doc.el('p', {}, 'Inside frame'));
    const res = await handleGetPageText({ tabId: 1 });
    expect(res.text).toContain('Top text');
    expect(res.text).toContain('Inside frame');
    expect(res.text).toContain('WebGPU supported');
  });

  it('over maxChars: the cut text and a last line with the rest counted', async () => {
    doc.body.append(doc.el('p', {}, 'Intro paragraph of the page'));
    const res = await handleGetPageText({ tabId: 1, maxChars: 5 });
    expect(res.truncated).toBe(true);
    expect(res.text.startsWith('Intro')).toBe(true);
    expect(res.text).toMatch(/\n… truncated \(\d+ more chars\)$/);
  });

  it('target scopes the text to that element', async () => {
    doc.body.append(doc.el('h1', { id: 'title' }, 'Title'), doc.el('p', {}, 'Body'));
    const res = await handleGetPageText({ tabId: 1, target: '#title' });
    expect(res.text).toBe('Title');
  });

  it('a target re-found by its descriptor: the text says so on its last line', async () => {
    const like1 = doc.el('button', { class: 'like' }, 'Like');
    const like2 = doc.el('button', { class: 'like' }, 'Like');
    doc.body.append(like1, like2);
    fallbackByTab.set(1, new Map([['e7', { robustSelector: 'button.like', text: 'Like', role: 'button', tag: 'BUTTON', nth: 1 }]]));
    const res = await handleGetPageText({ tabId: 1, target: 'e7' });
    expect(res.success).toBe(true);
    expect(res.text.split('\n').at(-1)).toBe('note: e7 was re-found after the page changed');
  });
});

describe('wait', () => {
  it('target visible: resolves at once and says how long it took', async () => {
    doc.body.append(doc.el('button', { id: 'go' }, 'Go'));
    const res = await handleWait({ tabId: 1, target: '#go', timeout: 500 });
    expect(res).toMatchObject({ success: true });
    expect(res.text).toMatch(/^ok after \d+ ms$/);
  });

  it('target gone: a hidden or removed element counts as gone', async () => {
    const spinner = doc.el('div', { id: 'spin' }, 'Loading');
    doc.body.append(spinner);
    spinner.hidden = true;
    expect((await handleWait({ tabId: 1, target: '#spin', gone: true, timeout: 300 })).success).toBe(true);
    expect((await handleWait({ tabId: 1, target: '#nothere', gone: true, timeout: 300 })).success).toBe(true);
  });

  it('target text=... waits for visible text (a text condition is a target)', async () => {
    doc.body.append(doc.el('p', {}, 'Payment received'));
    expect((await handleWait({ tabId: 1, target: 'text=payment RECEIVED', timeout: 500 })).success).toBe(true);
    expect((await handleWait({ tabId: 1, target: 'text=refund', timeout: 300 })).success).toBe(false);
  });

  it('url: a substring of location.href, or a glob when it has a *', async () => {
    expect((await handleWait({ tabId: 1, url: 'example.test/page', timeout: 500 })).success).toBe(true);
    expect((await handleWait({ tabId: 1, url: 'https://example.test/*', timeout: 500 })).success).toBe(true);
    expect(await handleWait({ tabId: 1, url: '/checkout', timeout: 300 })).toEqual({
      success: false,
      error: 'TIMEOUT: url containing "/checkout" not met after 300 ms',
    });
  });

  it('a target inside a same-origin frame is found', async () => {
    const frame = doc.el('iframe', {});
    doc.body.append(frame);
    installFakeFrame(frame).body.append(doc.el('p', {}, 'Payment received'));
    expect((await handleWait({ tabId: 1, target: 'text=payment RECEIVED', timeout: 500 })).success).toBe(true);
  });

  it('a timeout that is not met says so with the condition', async () => {
    expect(await handleWait({ tabId: 1, target: '#nope', timeout: 300 })).toEqual({
      success: false,
      error: 'TIMEOUT: target #nope visible not met after 300 ms',
    });
  });

  it('a ref never issued here fails at once, in both modes (it is not "gone")', async () => {
    const started = Date.now();
    const gone = await handleWait({ tabId: 1, target: 'e999', gone: true, timeout: 5000 });
    const visible = await handleWait({ tabId: 1, target: 'e999', timeout: 5000 });
    expect(gone).toEqual({ success: false, error: expect.stringMatching(/^REF_NOT_FOUND: ref e999 is not on this page/) });
    expect(visible).toEqual({ success: false, error: expect.stringMatching(/^REF_NOT_FOUND: ref e999 is not on this page/) });
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('an issued ref whose element left: gone is met; visible keeps polling and the timeout says the ref is gone', async () => {
    const save = doc.el('button', {}, 'Save');
    doc.body.append(save);
    const ref = D().refFor(save) as string;
    save.isConnected = false;
    doc.body.childNodes.splice(doc.body.childNodes.indexOf(save), 1);
    expect(await handleWait({ tabId: 1, target: ref, gone: true, timeout: 300 })).toMatchObject({ success: true });
    expect(await handleWait({ tabId: 1, target: ref, timeout: 300 })).toEqual({
      success: false,
      error: `TIMEOUT: target ${ref} visible not met after 300 ms (ref ${ref} is no longer on the page)`,
    });
  });

  it('a ref re-found by its snapshot descriptor is met, and the reply says it was re-found', async () => {
    const like1 = doc.el('button', { class: 'like' }, 'Like');
    const like2 = doc.el('button', { class: 'like' }, 'Like');
    doc.body.append(like1, like2);
    fallbackByTab.set(1, new Map([['e7', { robustSelector: 'button.like', text: 'Like', role: 'button', tag: 'BUTTON', nth: 1 }]]));
    const res = await handleWait({ tabId: 1, target: 'e7', timeout: 500 });
    expect(res.success).toBe(true);
    expect(res.text.split('\n').at(-1)).toBe('note: e7 was re-found after the page changed');
  });

  it('a poll on a busy page gets only the time left: the wait returns at its timeout, not after the 8 s page budget', async () => {
    const chromeMock = (globalThis as any).chrome;
    const real = chromeMock.scripting.executeScript;
    chromeMock.scripting.executeScript = (o: { func: { name: string } & ((...a: any[]) => unknown) }) => (o.func.name === 'waitPage' ? new Promise(() => {}) : real(o));
    const started = Date.now();
    try {
      const res = await handleWait({ tabId: 1, target: '#go', timeout: 500 });
      expect(res).toEqual({ success: false, error: 'TIMEOUT: target #go visible not met after 500 ms' });
    } finally {
      chromeMock.scripting.executeScript = real;
    }
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('a wait the caller cancels stops at once with the cancellation as a TIMEOUT', async () => {
    const controller = new AbortController();
    controller.abort();
    expect(await handleWait({ tabId: 1, target: '#nope', timeout: 5000 }, 'session-1', 'agent', controller.signal)).toEqual({
      success: false,
      error: 'TIMEOUT: wait cancelled by the caller',
    });
  });

  it('a wait cancelled while it polls ends within the poll, not at its timeout', async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    const started = Date.now();
    const res = await handleWait({ tabId: 1, target: '#nope', timeout: 5000 }, 'session-1', 'agent', controller.signal);
    expect(res).toEqual({ success: false, error: 'TIMEOUT: wait cancelled by the caller' });
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('a plain target wait carries no re-found note', async () => {
    doc.body.append(doc.el('button', { id: 'go' }, 'Go'));
    expect((await handleWait({ tabId: 1, target: '#go', timeout: 500 })).text).toMatch(/^ok after \d+ ms$/);
  });

  it('exactly one of target, url or ms: anything else is INVALID_ARGUMENT', async () => {
    await expect(handleWait({ tabId: 1, target: '#a', ms: 10 } as any)).rejects.toThrow(/^INVALID_ARGUMENT/);
    await expect(handleWait({ tabId: 1 } as any)).rejects.toThrow(/^INVALID_ARGUMENT/);
    await expect(handleWait({ tabId: 1, target: '#a', gone: true, url: 'x' } as any)).rejects.toThrow(/^INVALID_ARGUMENT/);
  });

  it('ms is a plain delay that must fit in the timeout', async () => {
    expect((await handleWait({ tabId: 1, ms: 20 })).text).toMatch(/^ok after \d+ ms$/);
    await expect(handleWait({ tabId: 1, ms: 20000, timeout: 10 })).rejects.toThrow(/^INVALID_ARGUMENT: ms \(20000\) is longer than timeout \(10\)/);
  });

  it('a timeout above the limit is capped, and the reply says so on a line of its own', async () => {
    doc.body.append(doc.el('button', { id: 'go' }, 'Go'));
    const res = await handleWait({ tabId: 1, target: '#go', timeout: 120000 });
    expect(res.success).toBe(true);
    expect(res.text).toMatch(/\nnote: timeout capped at 50000 ms \(requested 120000\)$/);
  });
});

describe('scroll', () => {
  /** A 600px-tall scrolling feed under the viewport centre. */
  function feed() {
    const el = doc.el('div', { id: 'feed', style: 'overflow:auto' }, doc.el('p', {}, 'Item'));
    Object.assign(el, { clientHeight: 600, clientWidth: 400, scrollHeight: 5000, scrollWidth: 400, scrollTop: 0, scrollLeft: 0 });
    doc.body.append(el);
    (doc as any).elementFromPoint = () => el;
    return el as any;
  }

  it('target alone scrolls it into view with no debugger call', async () => {
    doc.body.append(doc.el('button', { id: 'far' }, 'Far'));
    const res = await handleScroll({ tabId: 1, target: '#far' });
    expect(res.success).toBe(true);
    expect(res.text).toMatch(/^y: \d+ atEnd: (true|false)$/);
    expect(cdp).toEqual([]);
  });

  it('target alone, re-found by its descriptor: the reply says so on its last line', async () => {
    const like1 = doc.el('button', { class: 'like' }, 'Like');
    const like2 = doc.el('button', { class: 'like' }, 'Like');
    doc.body.append(like1, like2);
    fallbackByTab.set(1, new Map([['e7', { robustSelector: 'button.like', text: 'Like', role: 'button', tag: 'BUTTON', nth: 1 }]]));
    const res = await handleScroll({ tabId: 1, target: 'e7' });
    expect(res.success).toBe(true);
    expect(res.text.split('\n').at(-1)).toBe('note: e7 was re-found after the page changed');
  });

  it('a wheel at a target re-found by its descriptor: the reply says so on its last line', async () => {
    const el = feed();
    cdpState.onWheel = (p) => { el.scrollTop += p.deltaY; };
    fallbackByTab.set(1, new Map([['e3', { robustSelector: '#feed', tag: 'DIV', nth: 0 }]]));
    const res = await handleScroll({ tabId: 1, target: 'e3', dy: 500 });
    expect(res.success).toBe(true);
    expect(res.text.split('\n').at(-1)).toBe('note: e3 was re-found after the page changed');
  });

  it('dy sends a real mouseWheel at the viewport centre and reports the container position', async () => {
    const el = feed();
    cdpState.onWheel = (p) => { el.scrollTop += p.deltaY; };
    const res = await handleScroll({ tabId: 1, dy: 500 });
    expect(cdp.find((c) => c.method === 'Input.dispatchMouseEvent')?.params).toMatchObject({ type: 'mouseWheel', x: 500, y: 400, deltaY: 500, deltaX: 0 });
    expect(res).toMatchObject({ success: true, moved: true, position: { x: 0, y: 500 } });
    expect(res.text).toBe('y: 500 atEnd: false');
  });

  it('the tab draws frames while the wheel settles (a background tab holds the wheel for its next frame)', async () => {
    const el = feed();
    cdpState.onWheel = (p) => { el.scrollTop += p.deltaY; };
    await handleScroll({ tabId: 1, dy: 500 });
    const order = cdp.map((c) => (c.method === 'Input.dispatchMouseEvent' ? c.params.type : c.method));
    expect(order.indexOf('Page.startScreencast')).toBeLessThan(order.indexOf('mouseWheel'));
    expect(order.indexOf('Page.stopScreencast')).toBeGreaterThan(order.indexOf('mouseWheel'));
  });

  it('a wheel the tab holds past the first reads still scrolls: no NOT_SCROLLABLE while the container has room', async () => {
    const el = feed();
    // A background tab holds the wheel until its next frame: the scroll shows up 700 ms later.
    cdpState.onWheel = (p) => { setTimeout(() => { el.scrollTop += p.deltaY; }, 700); };
    const res = await handleScroll({ tabId: 1, dy: 500 });
    expect(res).toMatchObject({ success: true, moved: true, position: { x: 0, y: 500 } });
  });

  it('dx adds the x position to the line', async () => {
    const el = feed();
    el.scrollWidth = 2000;
    cdpState.onWheel = (p) => { el.scrollLeft += p.deltaX; };
    const res = await handleScroll({ tabId: 1, dx: 120 });
    expect(res.text).toMatch(/^x: 120 y: 0 atEnd: /);
  });

  it('nothing moved: NOT_SCROLLABLE, not success', async () => {
    const el = feed();
    el.scrollTop = 4400; // already at the bottom
    const res = await handleScroll({ tabId: 1, dy: 500 });
    expect(res.success).toBe(false);
    expect(res.moved).toBe(false);
    expect(res.error).toMatch(/^NOT_SCROLLABLE: nothing moved/);
    expect(cdp.some((c) => c.method === 'Input.dispatchMouseEvent')).toBe(true);
  });

  it('no debugger: DEBUGGER_UNAVAILABLE and no synthetic scroll', async () => {
    const el = feed();
    cdpState.attachError = new Error('Another debugger is attached');
    await expect(handleScroll({ tabId: 1, dy: 500 })).rejects.toThrow(/^DEBUGGER_UNAVAILABLE/);
    expect(el.scrollTop).toBe(0);
  });

  it('a target with no dx/dy scrolls into view; a point target needs dy or dx', async () => {
    await expect(handleScroll({ tabId: 1 } as any)).rejects.toThrow(/^INVALID_ARGUMENT/);
    await expect(handleScroll({ tabId: 1, target: '10,20' })).rejects.toThrow(/^INVALID_ARGUMENT: a point target needs dx or dy/);
  });
});

describe('evaluate', () => {
  it('an expression: the value as compact JSON, strings unquoted, over CDP', async () => {
    expect(await handleEvaluate({ tabId: 1, expression: '2 + 3' })).toMatchObject({ success: true, text: '5', result: 5, via: 'cdp' });
    expect((await handleEvaluate({ tabId: 1, expression: '"hi there"' })).text).toBe('hi there');
    expect((await handleEvaluate({ tabId: 1, expression: '({ a: [1, "x"] })' })).text).toBe('{"a":[1,"x"]}');
  });

  it('a trailing semicolon does not turn an expression into a body', async () => {
    expect((await handleEvaluate({ tabId: 1, expression: 'document.title;' })).text).toBe('Fixture');
  });

  it('statements that return a value run as a function body', async () => {
    const res = await handleEvaluate({ tabId: 1, expression: 'const a = 2; return a * 3;' });
    expect(res).toMatchObject({ success: true, text: '6', result: 6, via: 'cdp' });
    // The parse checks come first (not awaited); the run is the one that awaits the value.
    const evaluated = cdp.find((c) => c.method === 'Runtime.evaluate' && c.params.awaitPromise === true && c.params.expression.includes('return a * 3'))!;
    expect(evaluated.params.expression.startsWith('(async () => {')).toBe(true);
  });

  it('statements with no return give undefined and a note on how to get a value', async () => {
    const res = await handleEvaluate({ tabId: 1, expression: 'const x = 2; x * 21' });
    expect(res.text).toBe('undefined\nnote: statements give a value only through `return` (e.g. `const x = 2; return x * 21`)');
    // An expression that gives undefined is a value of its own: no note.
    expect((await handleEvaluate({ tabId: 1, expression: 'void 0' })).text).toBe('undefined');
  });

  it('a throw is SCRIPT_ERROR with the message, on the first line only', async () => {
    expect(await handleEvaluate({ tabId: 1, expression: 'throw new Error("boom")' })).toEqual({
      success: false,
      error: 'SCRIPT_ERROR: Error: boom',
    });
  });

  it('a syntax error is SCRIPT_ERROR and nothing runs', async () => {
    const res = await handleEvaluate({ tabId: 1, expression: 'let = ;' });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/^SCRIPT_ERROR: SyntaxError/);
    // Only the viewport probe of the attach ran on the page, and no run (awaitPromise) was sent: the source did not run.
    expect(cdp.filter((c) => c.method === 'Runtime.evaluate' && c.params.expression !== 'innerWidth * innerHeight' && c.params.awaitPromise === true)).toEqual([]);
  });

  it('a value that never settles is TIMEOUT within the budget', async () => {
    cdpState.hang = true;
    const started = Date.now();
    const res = await handleEvaluate({ tabId: 1, expression: '1', timeout: 1000 });
    expect(Date.now() - started).toBeLessThan(4000);
    expect(res.error).toMatch(/^TIMEOUT: evaluate did not finish within 1000ms/);
  });

  it('over 20000 characters: the cut text and a truncation line', async () => {
    const res = await handleEvaluate({ tabId: 1, expression: '"x".repeat(25000)' });
    expect(res.text.split('\n')[0]).toHaveLength(20000);
    expect(res.text.split('\n')[1]).toBe('… truncated (5000 more chars)');
  });

  it('no debugger: the scripting path runs and says via: scripting', async () => {
    cdpState.attachError = new Error('Another debugger is attached');
    const res = await handleEvaluate({ tabId: 1, expression: 'document.title' });
    expect(res).toMatchObject({ success: true, via: 'scripting' });
    expect(res.text).toBe('via: scripting\nFixture');
  });
});
