import fs from 'node:fs';
import path from 'node:path';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

/**
 * T017: the extension's siteContext block (R-05, R-07, contracts/site-context.schema.json).
 * The page-side probe runs here against stubbed page globals; cookies, tabs and the router are
 * mocked at the chrome.* boundary. No real browser.
 */

vi.mock('../extension/lib/connection.js', () => ({
  sendJson: () => {},
  updateBadge: () => {},
  broadcastStatus: async () => {},
  isWsConnected: () => true,
  setCurrentActivity: () => {},
}));
vi.mock('../extension/lib/overlay.js', () => ({
  showLockShield: async () => {},
  hideLockShield: async () => {},
}));
const execControl = vi.hoisted(() => ({ failNext: null as Error | null }));
vi.mock('../extension/lib/page-exec.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../extension/lib/page-exec.js')>();
  // The probe is a self-contained page function: run it in this realm against stubbed globals.
  return {
    ...actual,
    safeExec: async (_tabId: number, func: (...a: unknown[]) => unknown, args: unknown[] = []) => {
      if (execControl.failNext) {
        const error = execControl.failNext;
        execControl.failNext = null;
        throw error;
      }
      return func(...args);
    },
  };
});
const navigateHandler = vi.hoisted(() => vi.fn());
const snapshotHandler = vi.hoisted(() => vi.fn());
const textHandler = vi.hoisted(() => vi.fn());
vi.mock('../extension/handlers/navigation.js', () => ({ handleNavigate: navigateHandler, getActiveTab: async () => ({}) }));
vi.mock('../extension/handlers/inspection.js', () => ({
  handleSnapshot: snapshotHandler,
  handleGetPageText: textHandler,
  handleWait: vi.fn(),
  handleScroll: vi.fn(),
}));

type Tab = { id: number; url: string; incognito: boolean };
const tabState = { urls: [] as string[], incognito: false, id: 7 };
const tabsGet = vi.fn(async (id: number): Promise<Tab> => {
  const url = tabState.urls.length > 1 ? tabState.urls.shift()! : tabState.urls[0]!;
  return { id, url, incognito: tabState.incognito };
});
const executeScript = vi.fn(async () => [{ result: null }]);
const chromeMock: Record<string, unknown> = {
  tabs: { get: tabsGet, query: async () => [], update: async () => ({}), remove: async () => ({}), create: async () => ({}) },
  scripting: { executeScript },
  webNavigation: { getFrame: async () => null, getAllFrames: async () => [] },
  action: { setBadgeBackgroundColor: () => {}, setBadgeText: () => {} },
  storage: {
    session: { get: async () => ({}), set: async () => {} },
    local: { get: async () => ({}), set: async () => {}, remove: async () => {} },
  },
  runtime: { sendMessage: async () => {}, onMessage: { addListener: () => {} } },
  alarms: { create: () => {}, onAlarm: { addListener: () => {} } },
  webRequest: { onCompleted: { addListener: () => {} } },
  debugger: { attach: async () => {}, detach: async () => {}, sendCommand: async () => ({}), onEvent: { addListener: () => {} } },
};
(globalThis as unknown as { chrome: unknown }).chrome = chromeMock;

const siteContext = await import('../extension/lib/site-context.js');
const { dispatch, dispatchedTools } = await import('../extension/dispatch/router.js');

const root = path.resolve(__dirname, '..');
const allowlist = JSON.parse(
  fs.readFileSync(path.join(root, 'specs/003-website-agent-memory/contracts/fact-allowlist.json'), 'utf8'),
) as { anonymityNames: { exact: string[]; patterns: string[] } };

type Cookie = { name: string; httpOnly?: boolean };
type World = {
  /** Tab URL on each read; the last value repeats. Default: one stable URL. */
  urls?: string[];
  incognito?: boolean;
  cookies?: Cookie[] | 'throws' | 'missing';
  stores?: Array<{ id: string; tabIds: number[] }> | 'missing';
  local?: string[];
  session?: string[];
  databases?: unknown[] | 'missing' | 'throws';
  password?: 'visible' | 'hidden' | 'none';
  lang?: string;
  dir?: string;
  top?: boolean;
};

const reads = { values: 0 };
const cookiesGetAll = vi.fn();

function storageOf(names: string[]) {
  return {
    get length() { return names.length; },
    key: (i: number) => names[i] ?? null,
    getItem: () => { reads.values += 1; return 'SECRET-VALUE'; },
  };
}

function setWorld(w: World = {}) {
  const url = w.urls?.[0] ?? 'https://example.com/';
  tabState.urls = w.urls ?? [url];
  tabState.incognito = w.incognito ?? false;

  const cookies = w.cookies ?? [];
  cookiesGetAll.mockReset();
  if (cookies === 'missing') {
    delete chromeMock.cookies;
  } else {
    cookiesGetAll.mockImplementation(async () => {
      if (cookies === 'throws') throw new Error('cookie store unavailable');
      return cookies.map((c) => ({
        name: c.name,
        httpOnly: !!c.httpOnly,
        get value() { reads.values += 1; return 'SECRET-VALUE'; },
      }));
    });
    const stores = w.stores ?? [{ id: '0', tabIds: [tabState.id] }];
    chromeMock.cookies = {
      getAll: cookiesGetAll,
      ...(stores === 'missing' ? {} : { getAllCookieStores: async () => stores }),
    };
  }

  const g = globalThis as Record<string, unknown>;
  const databases = w.databases ?? [];
  g.indexedDB = databases === 'missing'
    ? {}
    : { databases: async () => { if (databases === 'throws') throw new Error('idb blocked'); return databases; } };
  g.localStorage = storageOf(w.local ?? []);
  g.sessionStorage = storageOf(w.session ?? []);

  const passwordInput = {
    getClientRects: () => (w.password === 'visible' ? [{}] : []),
    get value() { reads.values += 1; return 'hunter2'; },
    get name() { reads.values += 1; return 'pw'; },
    get id() { reads.values += 1; return 'pw'; },
    getAttribute: () => { reads.values += 1; return 'x'; },
  };
  g.document = {
    documentElement: { lang: w.lang ?? 'ar', dir: w.dir ?? 'rtl' },
    querySelectorAll: () => (w.password && w.password !== 'none' ? [passwordInput] : []),
  };
  g.getComputedStyle = () => ({ visibility: w.password === 'hidden' ? 'hidden' : 'visible', display: 'block' });
  g.window = {};
  (g.window as Record<string, unknown>).top = w.top === false ? {} : g.window;
}

async function ctx(opts: { urlBefore?: string | null; navigated?: boolean } = {}) {
  const urlBefore = opts.urlBefore === undefined ? tabState.urls[0]! : opts.urlBefore;
  return siteContext.buildSiteContext(tabState.id, { urlBefore, navigated: opts.navigated ?? false });
}

beforeEach(() => {
  reads.values = 0;
  navigateHandler.mockReset();
  snapshotHandler.mockReset();
  textHandler.mockReset();
  tabsGet.mockClear();
  setWorld();
});

afterEach(() => {
  const g = globalThis as Record<string, unknown>;
  for (const key of ['indexedDB', 'localStorage', 'sessionStorage', 'document', 'getComputedStyle', 'window']) delete g[key];
});

describe('siteContext anonymity verdict (R-07)', () => {
  it('is true on a clean page and reports structure', async () => {
    const out = await ctx();
    expect(out).toEqual({
      url: 'https://example.com/',
      incognito: false,
      topLevel: true,
      stable: true,
      lang: 'ar',
      dir: 'rtl',
      passwordField: false,
      anonymous: true,
      anonymityReason: 'ok',
    });
  });

  it('accepts allowlisted cookie and storage names, exact or by prefix', async () => {
    setWorld({
      cookies: [{ name: 'CookieConsent' }, { name: 'OptanonConsent' }, { name: '_ga' }, { name: '_ga_ABC123' }, { name: '_gat_UA1' }],
      local: ['_ga', 'euconsent-v2'],
      session: ['_gid'],
    });
    expect(await ctx()).toMatchObject({ anonymous: true, anonymityReason: 'ok' });
  });

  it('is false when an HttpOnly cookie is not on the allowlist', async () => {
    setWorld({ cookies: [{ name: 'CookieConsent' }, { name: 'sid', httpOnly: true }] });
    expect(await ctx()).toMatchObject({ anonymous: false, anonymityReason: 'cookie' });
  });

  it('matches names exactly: a lookalike name is not allowlisted', async () => {
    for (const name of ['CookieConsentX', 'cookieconsent', '_gax', '_ga2', 'x_ga_', '_ga_', '_ga_session', '_gat_']) {
      setWorld({ cookies: [{ name }] });
      expect(await ctx(), name).toMatchObject({ anonymous: false, anonymityReason: 'cookie' });
    }
  });

  it('also asks by domain: a login cookie scoped to another path is not missed (review F-09)', async () => {
    setWorld({ cookies: [] });
    cookiesGetAll.mockImplementation(async (query: { url?: string; domain?: string }) => (query.domain === 'example.com' ? [{ name: 'sid', httpOnly: true }] : []));
    expect(await ctx()).toMatchObject({ anonymous: false, anonymityReason: 'cookie' });
    expect(cookiesGetAll).toHaveBeenCalledWith(expect.objectContaining({ url: 'https://example.com/' }));
    expect(cookiesGetAll).toHaveBeenCalledWith(expect.objectContaining({ domain: 'example.com' }));
  });

  it('asks the parent domain for a host with three or more labels, and never for an IP address', async () => {
    setWorld({ urls: ['https://www.example.com/'], cookies: [] });
    cookiesGetAll.mockImplementation(async (query: { domain?: string }) => (query.domain === 'example.com' ? [{ name: 'sid' }] : []));
    expect(await ctx()).toMatchObject({ anonymous: false, anonymityReason: 'cookie' });
    setWorld({ urls: ['http://127.0.0.1:8080/'], cookies: [] });
    await ctx();
    expect(cookiesGetAll.mock.calls.every(([query]: [{ domain?: string }]) => query.domain === undefined)).toBe(true);
  });

  it('is false for a localStorage or sessionStorage key off the allowlist', async () => {
    setWorld({ local: ['token'] });
    expect(await ctx()).toMatchObject({ anonymous: false, anonymityReason: 'storage' });
    setWorld({ session: ['_ga', 'auth'] });
    expect(await ctx()).toMatchObject({ anonymous: false, anonymityReason: 'storage' });
  });

  it('is false when indexedDB has any database, null when it cannot be listed', async () => {
    setWorld({ databases: [{ name: 'app', version: 1 }] });
    expect(await ctx()).toMatchObject({ anonymous: false, anonymityReason: 'indexeddb' });
    setWorld({ databases: 'missing' });
    expect(await ctx()).toMatchObject({ anonymous: null, anonymityReason: 'unavailable' });
    setWorld({ databases: 'throws' });
    expect(await ctx()).toMatchObject({ anonymous: null, anonymityReason: 'unavailable' });
  });

  it('is false for userinfo, query or fragment, and the reported url never keeps userinfo', async () => {
    for (const url of ['https://example.com/a?x=1', 'https://example.com/a#frag', 'https://user:pw@example.com/a']) {
      setWorld({ urls: [url] });
      const out = await ctx();
      expect(out, url).toMatchObject({ anonymous: false, anonymityReason: 'query', stable: true });
      expect(out.url).not.toContain('user');
      expect(out.url).not.toContain('pw@');
    }
  });

  it('keeps query and fragment in url so the daemon can see they exist', async () => {
    setWorld({ urls: ['https://example.com/a?x=1#f'] });
    expect((await ctx()).url).toBe('https://example.com/a?x=1#f');
  });

  it('is false in an incognito tab', async () => {
    setWorld({ incognito: true });
    expect(await ctx()).toMatchObject({ anonymous: false, anonymityReason: 'incognito', incognito: true });
  });

  it('is null (unstable) when the URL changed across the handler', async () => {
    setWorld({ urls: ['https://example.com/', 'https://example.com/'] });
    const out = await ctx({ urlBefore: 'https://example.com/other' });
    expect(out).toMatchObject({ stable: false, anonymous: null, anonymityReason: 'unstable' });
  });

  it('is null (unstable) when the URL changed during the page read', async () => {
    setWorld({ urls: ['https://example.com/', 'https://example.com/spa-route'] });
    const out = await ctx({ urlBefore: 'https://example.com/' });
    expect(out).toMatchObject({ stable: false, anonymous: null, anonymityReason: 'unstable' });
  });

  it('does not compare to the old URL after a navigation, only handler end against read end', async () => {
    setWorld({ urls: ['https://example.com/'] });
    const out = await ctx({ urlBefore: 'https://other.example/', navigated: true });
    expect(out).toMatchObject({ stable: true, anonymous: true, anonymityReason: 'ok' });
  });

  it('is null (no_permission) without the cookies permission', async () => {
    setWorld({ cookies: 'missing' });
    expect(await ctx()).toMatchObject({ anonymous: null, anonymityReason: 'no_permission' });
  });

  it('is null (unavailable) when the cookie store cannot be read or found', async () => {
    setWorld({ cookies: 'throws' });
    expect(await ctx()).toMatchObject({ anonymous: null, anonymityReason: 'unavailable' });
    setWorld({ stores: [{ id: '9', tabIds: [999] }] });
    expect(await ctx()).toMatchObject({ anonymous: null, anonymityReason: 'unavailable' });
  });

  it("reads cookies from the tab's own store, for the URL it reported", async () => {
    setWorld({ stores: [{ id: '1', tabIds: [7] }, { id: '0', tabIds: [3] }], urls: ['https://example.com/p'] });
    await ctx();
    expect(cookiesGetAll).toHaveBeenCalledWith({ url: 'https://example.com/p', storeId: '1' });
  });

  it('is null (unavailable) for a non-http(s) page', async () => {
    setWorld({ urls: ['about:blank'] });
    expect(await ctx()).toMatchObject({ anonymous: null, anonymityReason: 'unavailable' });
    setWorld({ urls: ['file:///tmp/x.html'] });
    expect(await ctx()).toMatchObject({ anonymous: null });
  });

  it('never reads a value and never puts one in the result', async () => {
    setWorld({ cookies: [{ name: 'CookieConsent' }], local: ['_ga'], session: ['_gid'], password: 'visible' });
    const out = await ctx();
    expect(reads.values).toBe(0);
    expect(JSON.stringify(out)).not.toMatch(/SECRET-VALUE|hunter2/);
  });

  it('answers unavailable instead of throwing when the page read fails', async () => {
    execControl.failNext = new Error('INVALID_ARGUMENT: protected page');
    const out = await ctx();
    expect(out).toMatchObject({ anonymous: null, anonymityReason: 'unavailable', topLevel: false });
  });
});

describe('siteContext page structure', () => {
  it('sets passwordField for a visible password input and reads nothing else of it', async () => {
    setWorld({ password: 'visible' });
    expect(await ctx()).toMatchObject({ passwordField: true });
    expect(reads.values).toBe(0);
  });

  it('ignores hidden password inputs', async () => {
    setWorld({ password: 'hidden' });
    expect(await ctx()).toMatchObject({ passwordField: false });
  });

  it('does not let a password field decide the anonymity verdict', async () => {
    setWorld({ password: 'visible' });
    expect(await ctx()).toMatchObject({ passwordField: true, anonymous: true });
  });

  it('relays topLevel false from the probe (the mock drives the flag; real frame detection is not exercised here)', async () => {
    setWorld({ top: false });
    expect(await ctx()).toMatchObject({ topLevel: false });
  });

  it('reduces lang to a primary subtag and drops values that do not fit the contract', async () => {
    setWorld({ lang: 'AR-EG' });
    expect(await ctx()).toMatchObject({ lang: 'ar' });
    setWorld({ lang: 'x' });
    expect((await ctx()).lang).toBeNull();
    setWorld({ lang: '' });
    expect((await ctx()).lang).toBeNull();
    setWorld({ lang: 'en', dir: 'auto' });
    expect(await ctx()).toMatchObject({ lang: 'en', dir: null });
    setWorld({ lang: 'en', dir: 'LTR' });
    expect(await ctx()).toMatchObject({ dir: 'ltr' });
  });

  it('keeps url within the contract length', async () => {
    setWorld({ urls: [`https://example.com/${'a'.repeat(3000)}`] });
    expect((await ctx()).url.length).toBeLessThanOrEqual(2048);
  });
});

describe('contract parity', () => {
  it('keeps the anonymity names equal to contracts/fact-allowlist.json', () => {
    expect([...siteContext.ANONYMITY_NAMES.exact].sort()).toEqual([...allowlist.anonymityNames.exact].sort());
    expect([...siteContext.ANONYMITY_NAMES.patterns].sort()).toEqual([...allowlist.anonymityNames.patterns].sort());
  });

  it('requests the cookies permission and advertises site-context', async () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'extension/manifest.json'), 'utf8')) as { permissions: string[] };
    expect(manifest.permissions).toContain('cookies');
    const protocol = await import('../extension/lib/protocol.js');
    expect(protocol.EXTENSION_PROTOCOL_CAPABILITIES).toContain('site-context');
  });
});

describe('router attaches siteContext only on observe:true', () => {
  const navResult = { success: true, url: 'https://example.com/', tabId: 7, text: 'url: https://example.com/' };
  const snapResult = { success: true, text: '- searchbox "Search"' };

  it('adds it to browser_navigate and browser_snapshot', async () => {
    navigateHandler.mockResolvedValue({ ...navResult });
    snapshotHandler.mockResolvedValue({ ...snapResult });
    const nav = await dispatch('browser_navigate', { url: 'https://example.com/' }, 's1', 'a', undefined, true);
    expect(nav.siteContext).toMatchObject({ url: 'https://example.com/', topLevel: true, stable: true, anonymous: true });
    const snap = await dispatch('browser_snapshot', { tabId: 7 }, 's1', 'a', undefined, true);
    expect(snap.siteContext).toMatchObject({ stable: true, anonymous: true });
  });

  it('adds nothing without observe, and nothing to other tools', async () => {
    navigateHandler.mockResolvedValue({ ...navResult });
    textHandler.mockResolvedValue({ success: true, text: 'hi' });
    expect((await dispatch('browser_navigate', { url: 'https://example.com/' }, 's1', 'a')).siteContext).toBeUndefined();
    expect((await dispatch('browser_navigate', { url: 'https://example.com/' }, 's1', 'a', undefined, false)).siteContext).toBeUndefined();
    expect((await dispatch('browser_text', { tabId: 7 }, 's1', 'a', undefined, true)).siteContext).toBeUndefined();
    expect(cookiesGetAll).not.toHaveBeenCalled();
  });

  it('adds nothing to a failed result', async () => {
    snapshotHandler.mockResolvedValue({ success: false, error: 'REF_GONE' });
    expect((await dispatch('browser_snapshot', { tabId: 7 }, 's1', 'a', undefined, true)).siteContext).toBeUndefined();
  });

  it('takes the tab URL before and after a snapshot: a change in between is unstable', async () => {
    tabState.urls = ['https://example.com/a', 'https://example.com/b', 'https://example.com/b'];
    snapshotHandler.mockResolvedValue({ ...snapResult });
    const snap = await dispatch('browser_snapshot', { tabId: 7 }, 's1', 'a', undefined, true);
    expect(snap.siteContext).toMatchObject({ stable: false, anonymous: null, anonymityReason: 'unstable' });
  });

  it('never fails the call when the observation fails', async () => {
    tabsGet.mockRejectedValue(new Error('No tab 7'));
    snapshotHandler.mockResolvedValue({ ...snapResult });
    const snap = await dispatch('browser_snapshot', { tabId: 7 }, 's1', 'a', undefined, true);
    expect(snap).toMatchObject({ success: true, text: snapResult.text });
    expect(snap.siteContext).toMatchObject({ anonymous: null, anonymityReason: 'unavailable', stable: false });
    tabsGet.mockImplementation(async (id: number) => ({ id, url: tabState.urls[0]!, incognito: false }));
  });
});

describe('browser_memory_internal_context (T037)', () => {
  it('returns the tab\'s siteContext without touching the page handlers', async () => {
    setWorld({ urls: ['https://example.com/'], password: 'visible' });
    const out = await dispatch('browser_memory_internal_context', { tabId: 7 }, 's1', 'a');
    expect(out).toMatchObject({
      success: true,
      siteContext: { url: 'https://example.com/', topLevel: true, stable: true, passwordField: true, anonymous: true, anonymityReason: 'ok' },
    });
    expect(navigateHandler).not.toHaveBeenCalled();
    expect(snapshotHandler).not.toHaveBeenCalled();
    expect(textHandler).not.toHaveBeenCalled();
    expect(reads.values).toBe(0);
  });

  it('reports an unstable tab as anonymous:null, as navigate and snapshot do', async () => {
    for (const url of ['https://example.com/a', 'https://example.com/b', 'https://example.com/b']) {
      tabsGet.mockResolvedValueOnce({ id: 7, url, incognito: false });
    }
    const out = await dispatch('browser_memory_internal_context', { tabId: 7 }, 's1', 'a');
    expect(out.siteContext).toMatchObject({ stable: false, anonymous: null, anonymityReason: 'unstable' });
  });

  it('fails for a missing tab or a bad tabId', async () => {
    tabsGet.mockRejectedValueOnce(new Error('No tab with id 7'));
    expect(await dispatch('browser_memory_internal_context', { tabId: 7 }, 's1', 'a')).toMatchObject({ success: false, error: expect.stringMatching(/^TAB_NOT_FOUND: /) });
    for (const params of [{}, { tabId: '7' }, { tabId: -1 }, { tabId: 1.5 }]) {
      expect(await dispatch('browser_memory_internal_context', params, 's1', 'a'), JSON.stringify(params)).toMatchObject({ success: false, error: expect.stringMatching(/^INVALID_ARGUMENT: /) });
    }
  });

  it('is an internal action: handled by dispatch, absent from the public tool list', () => {
    expect(dispatchedTools).not.toContain('browser_memory_internal_context');
  });
});
