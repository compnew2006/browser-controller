import { describe, it, expect, beforeEach } from 'vitest';
import { normalizeNavigationUrl, classifyMainResponse } from '../extension/utils/navigation.js';

/**
 * browser_navigate: final URL, HTTP status, network failures, 204/download
 * outcomes and history steps (audit #11, #12). Chrome is faked with the
 * tab events and webRequest callbacks a real navigation fires; what Chrome does
 * for real (the actual redirect, the error page, the download) needs a browser.
 */

type Fn = (...args: any[]) => void;
const onUpdated = new Set<Fn>();
const headerListeners = new Set<Fn>();
const errorListeners = new Set<Fn>();
const tabs = new Map<number, { id: number; url: string; windowId: number; index: number; active: boolean }>();
/** Tabs whose page never answers a script (a frozen main thread). */
const frozenTabs = new Set<number>();
let nextTabId = 100;
/** When set, chrome.tabs.update rejects with it (the browser refuses the load). */
let updateError: Error | null = null;
const updates: Array<[number, Record<string, unknown>]> = [];
const historySteps: number[] = [];
/** The page's Navigation API view of its history (null = no Navigation API). */
let nav: { canGoBack: boolean; canGoForward: boolean } | null = null;
/** Plays the browser's reaction to a navigation or a history step. */
let reactTo: (tabId: number, url: string) => void = () => {};
let reactToHistory: (tabId: number, delta: number) => void = () => {};

const emitUpdated = (id: number, info: Record<string, unknown>) => {
  for (const fn of [...onUpdated]) fn(id, info, tabs.get(id));
};
const emitHeaders = (details: Record<string, unknown>) => { for (const fn of [...headerListeners]) fn(details); };
const emitError = (details: Record<string, unknown>) => { for (const fn of [...errorListeners]) fn(details); };

(globalThis as unknown as { chrome: unknown }).chrome = {
  tabs: {
    get: async (id: number) => {
      const t = tabs.get(id);
      if (!t) throw new Error(`No tab with id: ${id}`);
      return { ...t };
    },
    query: async () => [...tabs.values()].filter((t) => t.active).map((t) => ({ ...t })),
    create: async (props: { windowId?: number; index?: number; url?: string; active?: boolean }) => {
      const t = { id: nextTabId++, url: props.url ?? 'about:blank', windowId: props.windowId ?? 7, index: props.index ?? 0, active: !!props.active };
      tabs.set(t.id, t);
      return { ...t };
    },
    remove: async (id: number) => { tabs.delete(id); },
    update: async (id: number, props: Record<string, unknown>) => {
      updates.push([id, props]);
      if (updateError) throw updateError;
      if (typeof props.url === 'string') setTimeout(() => reactTo(id, props.url as string), 0);
      return { ...tabs.get(id) };
    },
    onUpdated: { addListener: (fn: Fn) => onUpdated.add(fn), removeListener: (fn: Fn) => onUpdated.delete(fn) },
    onRemoved: { addListener: () => {} },
  },
  webRequest: {
    onHeadersReceived: { addListener: (fn: Fn) => headerListeners.add(fn), removeListener: (fn: Fn) => headerListeners.delete(fn) },
    onErrorOccurred: { addListener: (fn: Fn) => errorListeners.add(fn), removeListener: (fn: Fn) => errorListeners.delete(fn) },
    onCompleted: { addListener: () => {} },
  },
  scripting: {
    executeScript: async (o: { target: { tabId: number }; func: (...a: unknown[]) => unknown; args?: unknown[] }) => {
      if (frozenTabs.has(o.target.tabId)) return new Promise(() => {});
      const src = o.func.toString();
      const args = o.args ?? [];
      if (src.includes('canGoBack')) {
        const d = Number(args[0]);
        return [{ result: nav === null ? null : d < 0 ? nav.canGoBack : nav.canGoForward }];
      }
      if (src.includes('history.go')) {
        historySteps.push(Number(args[0]));
        setTimeout(() => reactToHistory(o.target.tabId, Number(args[0])), 0);
        return [{ result: undefined }];
      }
      return [{ result: null }];
    },
  },
  storage: { session: { get: async () => ({}), set: async () => {} }, local: { get: async () => ({}), set: async () => {} } },
  runtime: { sendMessage: async () => {}, onMessage: { addListener: () => {} } },
  action: { setBadgeBackgroundColor: () => {}, setBadgeText: () => {} },
  debugger: { attach: async () => {}, detach: async () => {}, sendCommand: async () => ({}), onDetach: { addListener: () => {} } },
};

const { handleNavigate } = await import('../extension/handlers/navigation.js');
const { wedgedTabs } = await import('../extension/lib/state.js');

const start = 'https://start.test/';
const headers = (statusCode: number, extra: Array<{ name: string; value: string }> = []) => ({ statusCode, responseHeaders: extra });

beforeEach(() => {
  onUpdated.clear();
  headerListeners.clear();
  errorListeners.clear();
  updates.length = 0;
  historySteps.length = 0;
  nav = null;
  tabs.clear();
  tabs.set(1, { id: 1, url: start, windowId: 7, index: 0, active: true });
  frozenTabs.clear();
  wedgedTabs.clear();
  nextTabId = 100;
  updateError = null;
  reactTo = () => {};
  reactToHistory = () => {};
});

/** The error a rejected call carries (the router sends its message), or null when it resolved. */
const failureOf = (p: Promise<unknown>): Promise<any> => p.then(() => null, (err: any) => err);

describe('browser_navigate: failures after a frozen tab was replaced, and cancellation', () => {
  const freezeTab1 = () => {
    wedgedTabs.set(1, Date.now());
    frozenTabs.add(1);
  };

  it('a raw error from the load (the browser refuses it) is NAVIGATION_FAILED and names the replacement', async () => {
    freezeTab1();
    updateError = new Error('Tabs cannot be edited right now');
    const err = await failureOf(handleNavigate({ url: 'https://example.com/next', tabId: 1, snapshot: false }, 's1'));
    expect(err.message).toBe('NAVIGATION_FAILED: Tabs cannot be edited right now (tab 1 was frozen and has been replaced by tab 100)');
    expect(err.code).toBe('NAVIGATION_FAILED');
  });

  it('a coded error after the replacement keeps its code and names the replacement', async () => {
    freezeTab1();
    updateError = new Error('INVALID_ARGUMENT: that address is not allowed');
    const err = await failureOf(handleNavigate({ url: 'https://example.com/next', tabId: 1, snapshot: false }, 's1'));
    expect(err.message).toBe('INVALID_ARGUMENT: that address is not allowed (tab 1 was frozen and has been replaced by tab 100)');
    expect(err.code).toBe('INVALID_ARGUMENT');
  });

  it('a cancellation after the replacement is TIMEOUT and names the replacement', async () => {
    freezeTab1();
    const ctrl = new AbortController();
    const pending = failureOf(handleNavigate({ url: 'https://example.com/next', tabId: 1, snapshot: false }, 's1', undefined, ctrl.signal));
    setTimeout(() => ctrl.abort(), 50);
    const err = await pending;
    expect(err.message).toBe('TIMEOUT: navigate cancelled by the caller (tab 1 was frozen and has been replaced by tab 100)');
    expect(err.code).toBe('TIMEOUT');
  });

  it('a cancellation before any replacement is TIMEOUT: navigate cancelled by the caller (same wording as evaluate)', async () => {
    const ctrl = new AbortController();
    const pending = failureOf(handleNavigate({ url: 'https://example.com/slow', tabId: 1, snapshot: false }, 's1', undefined, ctrl.signal));
    setTimeout(() => ctrl.abort(), 50);
    const err = await pending;
    expect(err.message).toBe('TIMEOUT: navigate cancelled by the caller');
    expect(err.code).toBe('TIMEOUT');
  });
});

describe('normalizeNavigationUrl', () => {
  it('adds https to a bare host, http to a local dev server, and keeps explicit schemes', () => {
    expect(normalizeNavigationUrl('example.com')).toBe('https://example.com');
    expect(normalizeNavigationUrl('example.com/a?b=1')).toBe('https://example.com/a?b=1');
    expect(normalizeNavigationUrl('localhost:3000/app')).toBe('http://localhost:3000/app');
    expect(normalizeNavigationUrl('127.0.0.1:7225')).toBe('http://127.0.0.1:7225');
    expect(normalizeNavigationUrl('[::1]:8080')).toBe('http://[::1]:8080');
    expect(normalizeNavigationUrl('https://x.test/p')).toBe('https://x.test/p');
    expect(normalizeNavigationUrl('http://localhost:3000')).toBe('http://localhost:3000');
    expect(normalizeNavigationUrl('about:blank')).toBe('about:blank');
    expect(normalizeNavigationUrl('  example.com  ')).toBe('https://example.com');
    expect(normalizeNavigationUrl('')).toBe('');
  });
});

describe('classifyMainResponse', () => {
  it('reads a 204/205 as no content, a plain page as neither', () => {
    expect(classifyMainResponse(204)).toMatchObject({ noContent: true, download: false });
    expect(classifyMainResponse(205)).toMatchObject({ noContent: true });
    expect(classifyMainResponse(200, [{ name: 'Content-Type', value: 'text/html' }])).toMatchObject({ noContent: false, download: false });
  });

  it('reads an attachment, or a type browsers save, as a download with its file name', () => {
    expect(classifyMainResponse(200, [{ name: 'Content-Disposition', value: 'attachment; filename="report.pdf"' }]))
      .toMatchObject({ download: true, filename: 'report.pdf' });
    expect(classifyMainResponse(200, [{ name: 'content-disposition', value: "attachment; filename*=UTF-8''r%C3%A9sum%C3%A9.zip" }]))
      .toMatchObject({ download: true, filename: 'résumé.zip' });
    expect(classifyMainResponse(200, [{ name: 'Content-Type', value: 'application/zip' }])).toMatchObject({ download: true, filename: null });
  });

  it('never treats a redirect as a download', () => {
    expect(classifyMainResponse(302, [{ name: 'Content-Disposition', value: 'attachment' }])).toMatchObject({ download: false });
  });
});

describe('browser_navigate outcome', () => {
  it('a bare host loads as https and reports the final URL after redirects, with the requested one', async () => {
    reactTo = (id, url) => {
      emitHeaders({ tabId: id, url, statusCode: 301, responseHeaders: [{ name: 'Location', value: 'https://example.com/landing' }] });
      tabs.get(id)!.url = 'https://example.com/landing';
      emitHeaders({ tabId: id, url: 'https://example.com/landing', statusCode: 200, responseHeaders: [] });
      emitUpdated(id, { status: 'loading' });
      emitUpdated(id, { status: 'complete' });
    };
    const res = await handleNavigate({ url: 'example.com', tabId: 1, snapshot: false }, 's1');
    expect(updates[0]).toEqual([1, { url: 'https://example.com' }]);
    expect(res).toMatchObject({ success: true, url: 'https://example.com/landing', requestedUrl: 'https://example.com', status: 200, tabId: 1 });
  });

  it('a 404 is reported honestly: the page loaded, so it is not an error', async () => {
    reactTo = (id, url) => {
      tabs.get(id)!.url = url;
      emitHeaders({ tabId: id, url, statusCode: 404, responseHeaders: [] });
      emitUpdated(id, { status: 'loading' });
      emitUpdated(id, { status: 'complete' });
    };
    const res = await handleNavigate({ url: 'https://example.com/missing', tabId: 1, snapshot: false }, 's1');
    expect(res).toMatchObject({ success: true, status: 404, url: 'https://example.com/missing' });
    expect(res).not.toHaveProperty('requestedUrl');
  });

  it('a frozen tab is replaced: the call loads the replacement, and its text names the tab that replaced the frozen one', async () => {
    wedgedTabs.set(1, Date.now());
    frozenTabs.add(1);
    reactTo = (id, url) => {
      tabs.get(id)!.url = url;
      emitUpdated(id, { status: 'loading' });
      emitUpdated(id, { status: 'complete' });
    };
    const res = await handleNavigate({ url: 'https://example.com/next', tabId: 1, snapshot: false }, 's1') as any;
    expect(res).toMatchObject({ success: true, tabId: 100, replacedTabId: 1, url: 'https://example.com/next' });
    expect(res.text).toContain('note: tab 1 was frozen and has been replaced by tab 100');
    expect(tabs.has(1)).toBe(false);
  });

  it('a replaced frozen tab whose load then fails says so in the error too: the agent learns the new tab id', async () => {
    wedgedTabs.set(1, Date.now());
    frozenTabs.add(1);
    reactTo = (id, url) => {
      emitError({ tabId: id, url, type: 'main_frame', error: 'net::ERR_CONNECTION_REFUSED' });
    };
    const res = await handleNavigate({ url: 'https://example.com/down', tabId: 1, snapshot: false }, 's1') as any;
    expect(res).toMatchObject({ success: false, tabId: 100, replacedTabId: 1 });
    expect(res.error).toBe('NAVIGATION_FAILED: net::ERR_CONNECTION_REFUSED while loading https://example.com/down (tab 1 was frozen and has been replaced by tab 100)');
  });

  it('an abort during the hash-only settle leaves no unhandled rejection', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
    process.on('unhandledRejection', onUnhandled);
    try {
      const ctrl = new AbortController();
      const pending = handleNavigate({ url: `${start}#chapter-2`, tabId: 1, snapshot: false }, 's1', undefined, ctrl.signal);
      setTimeout(() => ctrl.abort(), 50);
      await pending;
      await new Promise((r) => setTimeout(r, 20));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('a network failure fails with NAVIGATION_FAILED and the net error, without waiting for a load', async () => {
    reactTo = (id, url) => {
      emitError({ tabId: id, url, type: 'main_frame', error: 'net::ERR_CONNECTION_REFUSED' });
    };
    const res = await handleNavigate({ url: 'http://localhost:9', tabId: 1, snapshot: false }, 's1');
    expect(res).toMatchObject({ success: false, error: 'NAVIGATION_FAILED: net::ERR_CONNECTION_REFUSED while loading http://localhost:9' });
  });

  it('a superseded navigation (ERR_ABORTED) is not a failure when the page then loads', async () => {
    reactTo = (id, url) => {
      emitError({ tabId: id, url, type: 'main_frame', error: 'net::ERR_ABORTED' });
      tabs.get(id)!.url = 'https://example.com/second';
      emitHeaders({ tabId: id, url: 'https://example.com/second', statusCode: 200, responseHeaders: [] });
      emitUpdated(id, { status: 'loading' });
      emitUpdated(id, { status: 'complete' });
    };
    const res = await handleNavigate({ url: 'https://example.com/first', tabId: 1, snapshot: false }, 's1');
    expect(res).toMatchObject({ success: true, url: 'https://example.com/second', status: 200 });
  });

  it('a 204 returns at once with noContent: the tab keeps its page and nothing is awaited', async () => {
    reactTo = (id, url) => {
      emitHeaders({ tabId: id, url, statusCode: 204, responseHeaders: [] });
    };
    const res = await handleNavigate({ url: 'https://example.com/ping', tabId: 1, snapshot: false }, 's1');
    expect(res).toMatchObject({ success: true, noContent: true, status: 204, url: start });
    expect(onUpdated.size).toBe(0);
  });

  it('a download returns at once with download: true and the file name', async () => {
    reactTo = (id, url) => {
      emitHeaders({ tabId: id, url, statusCode: 200, responseHeaders: [{ name: 'Content-Disposition', value: 'attachment; filename="report.pdf"' }] });
      emitError({ tabId: id, url, type: 'main_frame', error: 'net::ERR_ABORTED' });
    };
    const res = await handleNavigate({ url: 'https://example.com/report.pdf', tabId: 1, snapshot: false }, 's1');
    expect(res).toMatchObject({ success: true, download: true, filename: 'report.pdf', status: 200, url: 'https://example.com/report.pdf' });
    expect(res).not.toHaveProperty('success', false);
  });

  it('the final URL is reported without webRequest, and the status line is left out (not guessed)', async () => {
    const chromeRef = (globalThis as unknown as { chrome: { webRequest: unknown } }).chrome;
    const saved = chromeRef.webRequest;
    chromeRef.webRequest = {};
    reactTo = (id, url) => { tabs.get(id)!.url = url; emitUpdated(id, { status: 'loading' }); emitUpdated(id, { status: 'complete' }); };
    try {
      const res = await handleNavigate({ url: 'https://example.com/x', tabId: 1, snapshot: false }, 's1');
      expect(res).toMatchObject({ success: true, url: 'https://example.com/x' });
      expect(res).not.toHaveProperty('status');
      expect(String(res.text)).not.toMatch(/^status:/m);
    } finally {
      chromeRef.webRequest = saved;
    }
  });
});

describe('browser_navigate back / forward', () => {
  it('steps back through the page history and reports the page it landed on', async () => {
    nav = { canGoBack: true, canGoForward: false };
    tabs.get(1)!.url = 'https://b.test/';
    reactToHistory = (id) => {
      tabs.get(id)!.url = 'https://a.test/';
      emitUpdated(id, { status: 'loading' });
      emitUpdated(id, { status: 'complete' });
    };
    const res = await handleNavigate({ url: 'back', tabId: 1, snapshot: false }, 's1');
    expect(historySteps).toEqual([-1]);
    expect(res).toMatchObject({ success: true, url: 'https://a.test/', tabId: 1 });
  });

  it('fails NO_HISTORY_ENTRY when there is nowhere to go, without stepping', async () => {
    nav = { canGoBack: false, canGoForward: false };
    const res = await handleNavigate({ url: 'back', tabId: 1, snapshot: false }, 's1');
    expect(res).toMatchObject({ success: false, error: expect.stringMatching(/^NO_HISTORY_ENTRY/) });
    expect(historySteps).toEqual([]);
  });

  it('a same-document step (no load event) settles on its own and reports the new URL', async () => {
    nav = { canGoBack: false, canGoForward: true };
    tabs.get(1)!.url = 'https://a.test/#one';
    reactToHistory = (id) => { tabs.get(id)!.url = 'https://a.test/#two'; };
    const res = await handleNavigate({ url: 'forward', tabId: 1, snapshot: false }, 's1');
    expect(historySteps).toEqual([1]);
    expect(res).toMatchObject({ success: true, url: 'https://a.test/#two' });
  }, 10_000);
});
