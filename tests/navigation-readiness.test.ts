import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * browser_navigate readiness. A load ends when the NEW document is interactive
 * or complete (or the tab reports complete), then a quiet-DOM wait runs instead
 * of a fixed 500 ms sleep: its clock runs in the extension, the page only says how
 * long ago its DOM last changed (page timers fire once a second in a background tab). Chrome is faked: each tab holds its
 * current document (readyState, origin, href), and the page scripts are answered
 * from it. The old document reads 'complete' until the new one commits, which is
 * what a probe must not mistake for the new page.
 */

type Fn = (...args: any[]) => void;
type Page = { readyState: string; origin: number; href: string };

const onUpdated = new Set<Fn>();
const headerListeners = new Set<Fn>();
const errorListeners = new Set<Fn>();
const tabs = new Map<number, { id: number; url: string; windowId: number; index: number; active: boolean }>();
/** The document each tab shows now, as a page script sees it. */
const pages = new Map<number, Page>();
/** Every run of the page's mutation clock, by the arguments it was given ('start' / 'read' / 'stop'). */
const quietCalls: unknown[][] = [];
/** Source of the page function the quiet wait runs. */
let quietSource = '';
/** What a 'read' of the mutation clock answers: ms since the DOM last changed. */
let quietIdle = () => 10_000;
/** Every in-page run the navigation makes: which one, and whether it asked to inject immediately. */
const pageRuns: Array<{ kind: 'probe' | 'quiet' | 'frames'; injectImmediately: boolean }> = [];
/** What each run of the frames probe answers, in order: same-origin frames still loading (0 once the list runs out). */
let framesLoading: number[] = [];
/** In-page runs that never answer (a busy page): the navigation must go on without them. */
const hung = { probe: false, quiet: false };
/** When set, the quiet-DOM wait cannot run on the page (it throws, as on a page that refuses script). */
let quietRefused = false;
let nextOrigin = 2;
let nextTabId = 100;
/** Plays the browser's reaction to a navigation or reload: loads, commits, reports. */
let reactTo: (tabId: number, url: string) => void = () => {};

const emitUpdated = (id: number, info: Record<string, unknown>) => {
  for (const fn of [...onUpdated]) fn(id, info, tabs.get(id));
};
const emitHeaders = (details: Record<string, unknown>) => { for (const fn of [...headerListeners]) fn(details); };
const emitError = (details: Record<string, unknown>) => { for (const fn of [...errorListeners]) fn(details); };

/** A new document commits in the tab: a new origin, and the tab shows its URL. */
const commit = (id: number, url: string, readyState: string) => {
  tabs.get(id)!.url = url;
  pages.set(id, { readyState, origin: nextOrigin++, href: url });
};
const setReady = (id: number, readyState: string) => { pages.get(id)!.readyState = readyState; };

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
    // A hash-only change shows at once (no document loads); any other load is reacted to later.
    // The reaction is captured now: a timer left over from one test must not run another test's reaction.
    update: async (id: number, props: Record<string, unknown>) => {
      const react = reactTo;
      const tab = tabs.get(id)!;
      if (typeof props.url === 'string') {
        if (props.url.split('#')[0] === tab.url.split('#')[0]) tab.url = props.url;
        else setTimeout(() => react(id, props.url as string), 0);
      }
      return { ...tab };
    },
    reload: async (id: number) => {
      const react = reactTo;
      setTimeout(() => react(id, tabs.get(id)!.url), 0);
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
    executeScript: async (o: { target: { tabId: number }; func: (...a: unknown[]) => unknown; args?: unknown[]; injectImmediately?: boolean }) => {
      // Chrome refuses script on its own pages: the function never runs there.
      const tab = tabs.get(o.target.tabId);
      if (tab && /^(chrome|about):/.test(tab.url)) throw new Error('Cannot access a chrome:// URL');
      const src = o.func.toString();
      if (src.includes('contentDocument')) {
        pageRuns.push({ kind: 'frames', injectImmediately: o.injectImmediately === true });
        return [{ result: framesLoading.length ? framesLoading.shift() : 0 }];
      }
      if (src.includes('MutationObserver')) {
        pageRuns.push({ kind: 'quiet', injectImmediately: o.injectImmediately === true });
        quietCalls.push([...(o.args ?? [])]);
        quietSource = src;
        if (quietRefused) throw new Error('Cannot access contents of the page.');
        if (hung.quiet) return new Promise(() => {});
        const op = o.args?.[0];
        return [{ result: op === 'stop' ? null : op === 'start' ? 0 : quietIdle() }];
      }
      if (src.includes('readyState')) {
        pageRuns.push({ kind: 'probe', injectImmediately: o.injectImmediately === true });
        if (hung.probe) return new Promise(() => {});
        const page = pages.get(o.target.tabId);
        return [{ result: page ? { ...page } : null }];
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

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const start = 'https://start.test/';
const headers = (statusCode: number, extra: Array<{ name: string; value: string }> = []) => ({ statusCode, responseHeaders: extra });

beforeEach(() => {
  onUpdated.clear();
  headerListeners.clear();
  errorListeners.clear();
  tabs.clear();
  tabs.set(1, { id: 1, url: start, windowId: 7, index: 0, active: true });
  pages.clear();
  // The document the tab shows before any navigation: complete, with its own origin.
  pages.set(1, { readyState: 'complete', origin: 1, href: start });
  quietCalls.length = 0;
  quietIdle = () => 10_000;
  pageRuns.length = 0;
  framesLoading = [];
  hung.probe = false;
  hung.quiet = false;
  wedgedTabs.clear();
  quietRefused = false;
  nextOrigin = 2;
  nextTabId = 100;
  reactTo = () => {};
});

describe('browser_navigate ends the load on the new document, not the old one', () => {
  it('ends on readyState interactive when the tab never reports complete', async () => {
    reactTo = (id, url) => {
      emitUpdated(id, { status: 'loading' }); // the navigation starts; the old document is still shown
      setTimeout(() => {
        commit(id, url, 'loading');
        setTimeout(() => setReady(id, 'interactive'), 150);
      }, 250);
    };
    const t0 = Date.now();
    const res = await handleNavigate({ url: 'https://example.com/app', tabId: 1, snapshot: false }, 's1') as any;
    expect(Date.now() - t0).toBeLessThan(3_000);
    expect(res).toMatchObject({ success: true, url: 'https://example.com/app', tabId: 1 });
    expect(res).not.toHaveProperty('loading');
  });

  it('does not end on the old document, which reads complete, before the new one commits', async () => {
    reactTo = (id, url) => {
      emitUpdated(id, { status: 'loading' });
      setTimeout(() => {
        commit(id, url, 'complete');
        emitUpdated(id, { status: 'complete' });
      }, 400);
    };
    const res = await handleNavigate({ url: 'https://example.com/late', tabId: 1, snapshot: false }, 's1') as any;
    expect(res).toMatchObject({ success: true, url: 'https://example.com/late' });
    expect(res).not.toHaveProperty('loading');
  });
});

describe('the quiet-DOM wait replaces the fixed 500 ms sleep', () => {
  const completeAtOnce = (id: number, url: string) => {
    emitUpdated(id, { status: 'loading' });
    commit(id, url, 'complete');
    emitUpdated(id, { status: 'complete' });
  };

  it('waits 200 ms of quiet, read once, and does not sleep a fixed 500 ms', async () => {
    reactTo = completeAtOnce;
    const t0 = Date.now();
    const res = await handleNavigate({ url: 'https://example.com/a', tabId: 1, snapshot: false }, 's1') as any;
    const ms = Date.now() - t0;
    expect(ms).toBeGreaterThanOrEqual(190);
    expect(ms).toBeLessThan(400);
    expect(res).toMatchObject({ success: true, url: 'https://example.com/a' });
    expect(quietCalls).toEqual([['start'], ['read'], ['stop']]);
  });

  it('keeps its clock in the extension: the page function sets no timer (a background tab runs them once a second)', async () => {
    reactTo = completeAtOnce;
    await handleNavigate({ url: 'https://example.com/clock', tabId: 1, snapshot: false }, 's1');
    expect(quietSource).toMatch(/MutationObserver/);
    expect(quietSource).not.toMatch(/setTimeout|setInterval|requestAnimationFrame/);
  });

  it('a page whose DOM keeps changing ends at the 1 s cap, and the navigation succeeds', async () => {
    quietIdle = () => 20; // a change 20 ms ago, every time it is asked
    reactTo = completeAtOnce;
    const t0 = Date.now();
    const res = await handleNavigate({ url: 'https://example.com/ticker', tabId: 1, snapshot: false }, 's1') as any;
    const ms = Date.now() - t0;
    expect(ms).toBeGreaterThanOrEqual(950);
    expect(ms).toBeLessThan(1_500);
    expect(res).toMatchObject({ success: true, url: 'https://example.com/ticker' });
    expect(quietCalls.at(-1)).toEqual(['stop']);
  });

  it('is skipped at once when the page cannot run script, and the navigation still succeeds', async () => {
    quietRefused = true;
    reactTo = completeAtOnce;
    const t0 = Date.now();
    const res = await handleNavigate({ url: 'https://example.com/b', tabId: 1, snapshot: false }, 's1') as any;
    expect(Date.now() - t0).toBeLessThan(400);
    expect(res).toMatchObject({ success: true, url: 'https://example.com/b' });
    expect(res).not.toHaveProperty('error');
    expect(quietCalls).toHaveLength(1);
  });

  it('is not run on a protected page, where the navigation still succeeds', async () => {
    reactTo = (id) => completeAtOnce(id, 'chrome://settings/');
    const res = await handleNavigate({ url: 'chrome://settings/', tabId: 1, snapshot: false }, 's1') as any;
    expect(res).toMatchObject({ success: true, url: 'chrome://settings/' });
    expect(quietCalls).toHaveLength(0);
  });

  it('follows a hash-only change, which loads no document', async () => {
    const res = await handleNavigate({ url: `${start}#chapter-2`, tabId: 1, snapshot: false }, 's1') as any;
    expect(res).toMatchObject({ success: true, url: `${start}#chapter-2` });
    expect(quietCalls.filter((c) => c[0] === 'start')).toHaveLength(1);
  });

  it('follows a reload in place', async () => {
    reactTo = completeAtOnce;
    const res = await handleNavigate({ url: 'reload', tabId: 1, snapshot: false }, 's1') as any;
    expect(res).toMatchObject({ success: true, url: start });
    expect(quietCalls).toEqual([['start'], ['read'], ['stop']]);
  });
});

describe('same-origin frames load before the page is reported (a frameset shows all its frames)', () => {
  const completeAtOnce = (id: number, url: string) => {
    emitUpdated(id, { status: 'loading' });
    commit(id, url, 'complete');
    emitUpdated(id, { status: 'complete' });
  };

  it('waits until no frame is loading, then runs the quiet-DOM wait', async () => {
    framesLoading = [2, 1, 0];
    reactTo = completeAtOnce;
    const res = await handleNavigate({ url: 'https://example.com/nested_frames', tabId: 1, snapshot: false }, 's1') as any;
    expect(res).toMatchObject({ success: true, url: 'https://example.com/nested_frames' });
    const kinds = pageRuns.map((r) => r.kind).filter((k) => k !== 'probe');
    expect(kinds).toEqual(['frames', 'frames', 'frames', 'quiet', 'quiet', 'quiet']);
    expect(pageRuns.filter((r) => r.kind === 'frames').every((r) => r.injectImmediately)).toBe(true);
  });

  it('a page without frames costs one probe', async () => {
    reactTo = completeAtOnce;
    await handleNavigate({ url: 'https://example.com/plain', tabId: 1, snapshot: false }, 's1');
    expect(pageRuns.filter((r) => r.kind === 'frames')).toHaveLength(1);
  });

  it('a frame that never finishes holds the navigation 3 s at most, and the navigation succeeds', async () => {
    framesLoading = new Array(500).fill(1);
    reactTo = completeAtOnce;
    const t0 = Date.now();
    const res = await handleNavigate({ url: 'https://example.com/stuck-frame', tabId: 1, snapshot: false }, 's1') as any;
    const ms = Date.now() - t0;
    expect(ms).toBeGreaterThanOrEqual(2_900);
    expect(ms).toBeLessThan(4_000);
    expect(res).toMatchObject({ success: true, url: 'https://example.com/stuck-frame' });
  }, 10_000);
});

describe('the in-page probes ask to run at once and never wedge the tab', () => {
  const completeAtOnce = (id: number, url: string) => {
    emitUpdated(id, { status: 'loading' });
    commit(id, url, 'complete');
    emitUpdated(id, { status: 'complete' });
  };

  it('the readiness probe and the quiet wait pass injectImmediately: true', async () => {
    reactTo = (id, url) => {
      emitUpdated(id, { status: 'loading' });
      setTimeout(() => {
        commit(id, url, 'loading');
        setTimeout(() => setReady(id, 'interactive'), 150);
      }, 250);
    };
    const res = await handleNavigate({ url: 'https://example.com/fast', tabId: 1, snapshot: false }, 's1') as any;
    expect(res).toMatchObject({ success: true, url: 'https://example.com/fast' });
    const probes = pageRuns.filter((r) => r.kind === 'probe');
    expect(probes.length).toBeGreaterThan(0);
    expect(probes.every((r) => r.injectImmediately)).toBe(true);
    const quiet = pageRuns.filter((r) => r.kind === 'quiet');
    expect(quiet).toHaveLength(3); // start, read, stop
    expect(quiet.every((r) => r.injectImmediately)).toBe(true);
  });

  it('a probe that does not answer in time leaves the tab unwedged, and the navigation succeeds', async () => {
    hung.probe = true;
    reactTo = completeAtOnce;
    const t0 = Date.now();
    const res = await handleNavigate({ url: 'https://example.com/slow-probe', tabId: 1, snapshot: false }, 's1') as any;
    // The sample before the load waits out its budget (1 s) and reads as no answer.
    expect(Date.now() - t0).toBeGreaterThanOrEqual(900);
    expect(res).toMatchObject({ success: true, url: 'https://example.com/slow-probe' });
    expect(wedgedTabs.has(1)).toBe(false);
  }, 10_000);

  it('a quiet-DOM wait that does not settle in time leaves the tab unwedged, and the navigation succeeds', async () => {
    hung.quiet = true;
    reactTo = completeAtOnce;
    const t0 = Date.now();
    const res = await handleNavigate({ url: 'https://example.com/busy', tabId: 1, snapshot: false }, 's1') as any;
    // The clock's first run gets the probe budget (1 s) and reads as no answer.
    expect(Date.now() - t0).toBeGreaterThanOrEqual(900);
    expect(res).toMatchObject({ success: true, url: 'https://example.com/busy' });
    expect(wedgedTabs.has(1)).toBe(false);
  }, 10_000);
});

describe('outcomes that end the wait early are unchanged', () => {
  it('a 204 returns at once with noContent, the tab keeps its page, and no quiet wait runs', async () => {
    reactTo = (id, url) => { emitHeaders({ tabId: id, url, ...headers(204) }); };
    const res = await handleNavigate({ url: 'https://example.com/ping', tabId: 1, snapshot: false }, 's1') as any;
    expect(res).toMatchObject({ success: true, noContent: true, status: 204, url: start });
    expect(quietCalls).toHaveLength(0);
  });

  it('a download returns at once with download: true and the file name, and no quiet wait runs', async () => {
    reactTo = (id, url) => {
      emitHeaders({ tabId: id, url, ...headers(200, [{ name: 'Content-Disposition', value: 'attachment; filename="report.pdf"' }]) });
      emitError({ tabId: id, url, type: 'main_frame', error: 'net::ERR_ABORTED' });
    };
    const res = await handleNavigate({ url: 'https://example.com/report.pdf', tabId: 1, snapshot: false }, 's1') as any;
    expect(res).toMatchObject({ success: true, download: true, filename: 'report.pdf', status: 200 });
    expect(quietCalls).toHaveLength(0);
  });

  it('a network failure fails with NAVIGATION_FAILED without waiting for the DOM', async () => {
    reactTo = (id, url) => { emitError({ tabId: id, url, type: 'main_frame', error: 'net::ERR_CONNECTION_REFUSED' }); };
    const res = await handleNavigate({ url: 'http://localhost:9', tabId: 1, snapshot: false }, 's1') as any;
    expect(res).toMatchObject({ success: false, error: 'NAVIGATION_FAILED: net::ERR_CONNECTION_REFUSED while loading http://localhost:9' });
    expect(quietCalls).toHaveLength(0);
  });
});

describe('the lock shield is no longer re-injected by navigation', () => {
  it('neither imports nor calls showLockShield or reshield, and keeps the ownership lock', () => {
    const src = fs.readFileSync(path.join(ROOT, 'extension/handlers/navigation.js'), 'utf8');
    expect(src).not.toMatch(/showLockShield|reshield/);
    expect(src).toContain('await lockTabUi(tab.id, sessionId,');
  });

  it('no longer takes a waitUntil mode: the load always waits for the DOM', () => {
    const src = fs.readFileSync(path.join(ROOT, 'extension/handlers/navigation.js'), 'utf8');
    expect(src).not.toMatch(/waitUntil|domcontentloaded/);
  });
});
