import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * WP5 console tests: the MAIN-world capture (console-main.js) and the isolated
 * relay (content.js) run against small fake window/document/console objects;
 * events.js is wired to a chrome mock. Uncaught errors, rejections, stacks, the
 * network request body, eviction and the navigation reset are checked end to end.
 */

const root = path.resolve(import.meta.dirname, '..');
const readSource = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8');

type Listener = (event: any) => void;
function fakeWindow() {
  const listeners = new Map<string, Listener[]>();
  return {
    win: {
      addEventListener: (type: string, fn: Listener) => { listeners.set(type, [...(listeners.get(type) ?? []), fn]); },
    } as any,
    fire: (type: string, event: any) => (listeners.get(type) ?? []).forEach((fn) => fn(event)),
    has: (type: string) => (listeners.get(type) ?? []).length > 0,
  };
}

class FakeCustomEvent {
  type: string;
  detail: string;
  constructor(type: string, init: { detail: string }) { this.type = type; this.detail = init.detail; }
}

/** console-main.js in a fake page: returns the page console and what it reported. */
function loadPageScript() {
  const reported: Array<Record<string, any>> = [];
  const originals: Record<string, any> = {
    log: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), assert: vi.fn(),
  };
  const pageConsole: Record<string, any> = { ...originals };
  const { win, fire } = fakeWindow();
  const doc = { dispatchEvent: (ev: FakeCustomEvent) => { reported.push(JSON.parse(ev.detail)); return true; }, addEventListener: () => {} };
  new Function('window', 'document', 'CustomEvent', 'console', readSource('extension/console-main.js'))(win, doc, FakeCustomEvent, pageConsole);
  return { console: pageConsole, originals, reported, fire };
}

describe('MAIN-world console capture (console-main.js)', () => {
  it('reports console.error with a short stack of the page code that logged it', () => {
    const page = loadPageScript();
    page.console.error('disk full');
    const [entry] = page.reported;
    expect(entry).toMatchObject({ level: 'error', text: 'disk full' });
    expect(entry).not.toHaveProperty('kind');
    const frames = entry.stack.split('\n');
    expect(frames.length).toBeGreaterThan(0);
    expect(frames.length).toBeLessThanOrEqual(5);
    expect(frames.every((line: string) => /^\s*at /.test(line))).toBe(true);
    expect(frames[0]).toContain('wp5-console.test');
    expect(entry.stack).not.toContain('at patched');
  });

  it('plain log calls carry no stack, and the page console still runs', () => {
    const page = loadPageScript();
    page.console.log('hi', { a: 1 });
    expect(page.reported).toEqual([{ level: 'log', text: 'hi {"a":1}' }]);
    expect(page.originals.log).toHaveBeenCalledWith('hi', { a: 1 });
  });

  it('an Error argument brings its own stack', () => {
    const page = loadPageScript();
    page.console.error(new Error('boom'));
    expect(page.reported[0]).toMatchObject({ level: 'error', text: 'Error: boom' });
    expect(page.reported[0].stack).toContain('wp5-console.test');
  });

  it('console.assert reports failed assertions only', () => {
    const page = loadPageScript();
    page.console.assert(true, 'fine');
    expect(page.reported).toEqual([]);
    page.console.assert(false, 'x', 1);
    expect(page.reported[0]).toMatchObject({ level: 'error', text: 'Assertion failed: x 1' });
    expect(page.reported[0].stack).toBeDefined();
  });

  it('uncaught errors arrive as errors with kind uncaught, location and a stack', () => {
    const page = loadPageScript();
    page.fire('error', { message: 'boom', filename: 'https://app.test/a.js', lineno: 3, colno: 9, error: new Error('boom') });
    expect(page.reported.at(-1)).toMatchObject({
      level: 'error', kind: 'uncaught', text: 'Uncaught boom at https://app.test/a.js:3:9',
    });
    expect(page.reported.at(-1)?.stack).toContain('wp5-console.test');
  });

  it('unhandled rejections arrive as errors with kind rejection, for Error and plain reasons', () => {
    const page = loadPageScript();
    page.fire('unhandledrejection', { reason: new TypeError('nope') });
    expect(page.reported.at(-1)).toMatchObject({ level: 'error', kind: 'rejection', text: 'Unhandled rejection: TypeError: nope' });
    page.fire('unhandledrejection', { reason: { code: 42 } });
    expect(page.reported.at(-1)).toMatchObject({ level: 'error', kind: 'rejection', text: 'Unhandled rejection: {"code":42}' });
    expect(page.reported.at(-1)).not.toHaveProperty('stack');
  });

  it('the benign ResizeObserver notice is not reported', () => {
    const page = loadPageScript();
    page.fire('error', { message: 'ResizeObserver loop completed with undelivered notifications.', filename: '', lineno: 0, colno: 0 });
    expect(page.reported).toEqual([]);
  });
});

describe('isolated relay (content.js)', () => {
  it('passes kind and stack from the MAIN world to the service worker, and no longer listens to page errors itself', () => {
    const sent: Array<Record<string, unknown>> = [];
    const docListeners = new Map<string, (event: { detail: string }) => void>();
    const { win, has } = fakeWindow();
    const doc = { addEventListener: (type: string, fn: (event: { detail: string }) => void) => docListeners.set(type, fn) };
    const chrome = { runtime: { sendMessage: (msg: Record<string, unknown>) => sent.push(msg) } };
    const quiet = { log() {}, info() {}, warn() {}, error() {}, debug() {} };
    new Function('window', 'document', 'chrome', 'console', readSource('extension/content.js'))(win, doc, chrome, quiet);
    // Not the top frame (the fake window has no `top`): no console reset is sent.
    expect(sent).toEqual([]);

    docListeners.get('__bc_console_entry')?.({ detail: JSON.stringify({ level: 'error', text: 'Uncaught boom', kind: 'uncaught', stack: '    at f (app.js:1:1)' }) });
    expect(sent.at(-1)).toEqual({ type: 'console', level: 'error', text: 'Uncaught boom', kind: 'uncaught', stack: '    at f (app.js:1:1)' });
    docListeners.get('__bc_console_entry')?.({ detail: JSON.stringify({ level: 'warn', text: 'plain' }) });
    expect(sent.at(-1)).toEqual({ type: 'console', level: 'warn', text: 'plain' });
    expect(has('error')).toBe(false);
    expect(has('unhandledrejection')).toBe(false);
  });
});

// --- events.js wiring -------------------------------------------------------

vi.mock('../extension/lib/connection.js', () => ({
  getOpenTabs: async () => [],
  buildStatusPayload: () => ({}),
  broadcastStatus: () => {},
  applyPort: () => ({ success: true }),
  applyToken: () => ({ success: true }),
  applyEnrollment: async () => ({ success: true }),
  sendJson: () => {},
  updateBadge: () => {},
  isWsConnected: () => true,
  setCurrentActivity: () => {},
}));

const registered = vi.hoisted(() => new Map<string, Array<{ fn: (...args: unknown[]) => unknown; extra?: unknown }>>());
const tabListeners = vi.hoisted(() => ({ onUpdated: [] as Array<(id: number, change: { status?: string }) => void> }));
const onAdd = (name: string) => ({
  addListener: (fn: (...args: unknown[]) => unknown, _filter?: unknown, extra?: unknown) => {
    registered.set(name, [...(registered.get(name) ?? []), { fn, extra }]);
  },
});
(globalThis as unknown as { chrome: unknown }).chrome = {
  runtime: { onMessage: onAdd('onMessage'), getManifest: () => ({ version: '9.9.9' }) },
  webRequest: {
    onBeforeRequest: onAdd('onBeforeRequest'), onSendHeaders: onAdd('onSendHeaders'),
    onCompleted: onAdd('onCompleted'), onErrorOccurred: onAdd('onErrorOccurred'),
  },
  tabs: {
    onRemoved: onAdd('onRemoved'),
    onUpdated: { addListener: (fn: (id: number, change: { status?: string }) => void) => tabListeners.onUpdated.push(fn) },
    get: async (id: number) => ({ id, url: 'https://x.test/', windowId: 1 }),
  },
  storage: { session: { get: async () => ({}), set: async () => {} } },
  scripting: { executeScript: async () => [{ result: null }] },
};

const { registerEventListeners } = await import('../extension/events.js');
const { handleIntercept } = await import('../extension/handlers/intercept.js');
const { consoleByTab, networkByTab } = await import('../extension/lib/state.js');
const { handleConsole } = await import('../extension/handlers/tabs.js');
const { interceptLedgerByTab } = await import('../extension/handlers/intercept.js');
const { capIssueRows, MAX_ISSUE_ROWS } = await import('../extension/lib/browser-log.js');

function emitMessage(msg: Record<string, unknown>, tabId: number, frameId = 0) {
  const fn = registered.get('onMessage')![0].fn as (m: unknown, s: unknown, r: unknown) => unknown;
  fn(msg, { tab: { id: tabId, url: 'https://x.test/page' }, frameId }, () => {});
}
const webRequest = (name: string, d: Record<string, unknown>) => (registered.get(name)![0].fn as (x: unknown) => void)(d);

describe('events wiring', () => {
  beforeEach(() => {
    consoleByTab.clear();
    networkByTab.clear();
    interceptLedgerByTab.clear();
    registerEventListeners();
  });

  it('console messages keep kind and stack, and browser_console returns them', async () => {
    emitMessage({ type: 'console', level: 'error', text: 'Unhandled rejection: Error: nope', kind: 'rejection', stack: '    at g (b.js:2:2)' }, 3);
    const res = await handleConsole({ tabId: 3 }) as { messages: Array<Record<string, unknown>> };
    expect(res.messages).toEqual([expect.objectContaining({ level: 'error', kind: 'rejection', stack: '    at g (b.js:2:2)', url: 'https://x.test/page' })]);
  });

  it('a new document in the tab resets its console, and keeps its network history', () => {
    emitMessage({ type: 'console', level: 'log', text: 'old page' }, 3);
    webRequest('onBeforeRequest', { requestId: 'n1', tabId: 3, url: 'https://x.test/a', method: 'GET', type: 'main_frame', timeStamp: 1 });
    webRequest('onCompleted', { requestId: 'n1', tabId: 3, url: 'https://x.test/a', method: 'GET', type: 'main_frame', statusCode: 200, timeStamp: 2 });
    // A loading status alone (it also fires for some same-document navigations) keeps the console.
    tabListeners.onUpdated[0](3, { status: 'loading' });
    expect(consoleByTab.get(3)).toHaveLength(1);
    // A subframe's new document does not reset the tab's console either.
    emitMessage({ type: 'console-reset' }, 3, 7);
    expect(consoleByTab.get(3)).toHaveLength(1);
    // content.js of a new top-level document resets it.
    emitMessage({ type: 'console-reset' }, 3, 0);
    expect(consoleByTab.has(3)).toBe(false);
    expect(networkByTab.get(3)).toHaveLength(1);
  });

  it('listens for request bodies (requestBody extraInfoSpec)', () => {
    expect(registered.get('onBeforeRequest')![0].extra).toEqual(['requestBody']);
  });

  it('a blocked request is ledgered too, not only completed ones', async () => {
    await handleIntercept({ action: 'set-rules', global: true, rules: [{ id: 'ads', match: 'https://ads\\.test/', action: 'block' }] });
    webRequest('onBeforeRequest', { requestId: 'ad1', tabId: 3, url: 'https://ads.test/x.js', method: 'GET', type: 'script', timeStamp: 1 });
    webRequest('onErrorOccurred', { requestId: 'ad1', tabId: 3, url: 'https://ads.test/x.js', method: 'GET', type: 'script', error: 'net::ERR_BLOCKED_BY_CLIENT', timeStamp: 2 });
    expect(networkByTab.get(3)?.[0]).toMatchObject({ error: 'net::ERR_BLOCKED_BY_CLIENT' });
    expect(networkByTab.get(3)?.[0]).not.toHaveProperty('intercept');
    expect(interceptLedgerByTab.get(3)).toEqual([expect.objectContaining({ error: 'net::ERR_BLOCKED_BY_CLIENT', intercept: expect.any(Object) })]);
  });
});

describe('browser_console Chrome Issues cap', () => {
  it('lists the most frequent issue kinds first and summarises the rest in one row', () => {
    const rows = Array.from({ length: MAX_ISSUE_ROWS + 3 }, (_, i) => ({ code: 'GenericIssue', type: `kind${i}`, count: i + 1 }));
    const capped = capIssueRows(rows);
    expect(capped).toHaveLength(MAX_ISSUE_ROWS + 1);
    expect(capped[0]).toMatchObject({ type: `kind${MAX_ISSUE_ROWS + 2}`, count: MAX_ISSUE_ROWS + 3 });
    expect(capped.at(-1)).toEqual({ code: 'Truncated', type: `3 more issue kinds not listed (row cap ${MAX_ISSUE_ROWS})` });
  });

  it('leaves a short list alone', () => {
    const rows = [{ code: 'A', count: 1 }, { code: 'B', count: 2 }];
    expect(capIssueRows(rows)).toEqual([{ code: 'B', count: 2 }, { code: 'A', count: 1 }]);
  });
});
