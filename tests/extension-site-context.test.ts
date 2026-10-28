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
const execControl = vi.hoisted(() => ({ failNext: null as Error | null, hang: false }));
const navigateHandler = vi.hoisted(() => vi.fn());
const snapshotHandler = vi.hoisted(() => vi.fn());
const textHandler = vi.hoisted(() => vi.fn());
const clickHandler = vi.hoisted(() => vi.fn());
vi.mock('../extension/handlers/interaction.js', () => ({ handleClick: clickHandler, handleType: vi.fn() }));
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
// The probe is a self-contained page function: run it in this realm against stubbed globals.
const executeScript = vi.fn(async ({ func, args = [] }: { func: (...a: unknown[]) => unknown; args?: unknown[] }) => {
  if (execControl.hang) return new Promise<never>(() => {});
  if (execControl.failNext) {
    const error = execControl.failNext;
    execControl.failNext = null;
    throw error;
  }
  return [{ result: await func(...args) }];
});
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
const { wedgedTabs } = await import('../extension/lib/state.js');

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
  execControl.hang = false;
  execControl.failNext = null;
  executeScript.mockClear();
  wedgedTabs.clear();
  navigateHandler.mockReset();
  snapshotHandler.mockReset();
  textHandler.mockReset();
  clickHandler.mockReset();
  tabsGet.mockClear();
  setWorld();
});

afterEach(() => {
  vi.useRealTimers();
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

  it('accepts a signed-out Wikipedia page (allowlist v2 survey names)', async () => {
    setWorld({
      // The cookie store of a signed-out ar.wikipedia.org reader; the HttpOnly names are invisible to document.cookie.
      cookies: [
        { name: 'GeoIP' }, { name: 'NetworkProbeLimit' }, { name: 'arwikimwuser-sessionId' }, { name: 'WMF-Last-Access', httpOnly: true },
        { name: 'WMF-Last-Access-Global', httpOnly: true }, { name: 'WMF-Uniq', httpOnly: true }, { name: 'WMF-DP', httpOnly: true },
      ],
      local: [
        'CentralNoticeKV|global|buckets', 'MediaWikiModuleStore:arwiki', 'CentralAuthAnon',
        'wmE-sessionTickLastTickTime', 'wmE-sessionTickTickCount',
      ],
    });
    expect(await ctx()).toMatchObject({ anonymous: true, anonymityReason: 'ok' });
    expect(reads.values).toBe(0);
  });

  it('accepts DuckDuckGo after its promotion key is written', async () => {
    setWorld({ local: ['ddg-promotions'] });
    expect(await ctx()).toMatchObject({ anonymous: true, anonymityReason: 'ok' });
  });

  it('is false on a signed-in Wikipedia page even with the v2 names present', async () => {
    setWorld({
      cookies: [
        { name: 'GeoIP' }, { name: 'arwikimwuser-sessionId' }, { name: 'WMF-Uniq', httpOnly: true }, { name: 'WMF-DP', httpOnly: true },
        { name: 'centralauth_User' }, { name: 'centralauth_Session', httpOnly: true }, { name: 'arwikiSession', httpOnly: true }, { name: 'arwikiUserID' },
      ],
      local: ['MediaWikiModuleStore:arwiki'],
    });
    expect(await ctx()).toMatchObject({ anonymous: false, anonymityReason: 'cookie' });
  });

  it('keeps generic storage keys such as events and pings unverified', async () => {
    setWorld({ local: ['appLifetimeMetrics', 'userLifetimeMetrics', 'glean_session_last_active', 'events', 'pings'] });
    expect(await ctx()).toMatchObject({ anonymous: false, anonymityReason: 'storage' });
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

  it('asks a parent the public-suffix guess used to skip: ac.me is a registered domain', async () => {
    setWorld({ urls: ['https://app.ac.me/'], cookies: [] });
    cookiesGetAll.mockImplementation(async (query: { domain?: string }) => (query.domain === 'ac.me' ? [{ name: 'sid' }] : []));
    expect(await ctx()).toMatchObject({ anonymous: false, anonymityReason: 'cookie' });
    expect(cookiesGetAll).toHaveBeenCalledWith(expect.objectContaining({ domain: 'ac.me' }));
  });

  it('asks a real public suffix too; it answers empty and the page still reads anonymous', async () => {
    setWorld({ urls: ['https://shop.example.co.uk/'], cookies: [] });
    cookiesGetAll.mockImplementation(async () => []);
    expect(await ctx()).toMatchObject({ anonymous: true, anonymityReason: 'ok' });
    expect(cookiesGetAll).toHaveBeenCalledWith(expect.objectContaining({ domain: 'example.co.uk' }));
  });

  it('asks no parent for a two-label host: only a bare TLD sits above it', async () => {
    setWorld({ urls: ['https://example.com/'], cookies: [] });
    await ctx();
    expect(cookiesGetAll.mock.calls.every(([query]: [{ domain?: string }]) => query.domain !== 'com')).toBe(true);
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

describe('code-review fixes: the observation is bounded and side-effect free', () => {
  it('never marks the tab wedged when the probe runs past its budget (#2)', async () => {
    vi.useFakeTimers();
    execControl.hang = true;
    const pending = ctx();
    await vi.advanceTimersByTimeAsync(siteContext.SITE_CONTEXT_BUDGET_MS + 10);
    expect(await pending).toMatchObject({ anonymous: null, anonymityReason: 'unavailable' });
    expect(wedgedTabs.has(tabState.id)).toBe(false);
  });

  it('answers within its budget when a cookie read hangs (#3)', async () => {
    vi.useFakeTimers();
    cookiesGetAll.mockImplementation(() => new Promise(() => {}));
    let settled = false;
    const pending = ctx().then((out) => { settled = true; return out; });
    await vi.advanceTimersByTimeAsync(siteContext.SITE_CONTEXT_BUDGET_MS - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(2);
    expect(settled).toBe(true);
    expect(await pending).toMatchObject({ anonymous: null, anonymityReason: 'unavailable', stable: false });
  });

  it('keeps the whole navigate observation within the observe budget and leaves the result intact (#3)', async () => {
    vi.useFakeTimers();
    tabsGet.mockImplementationOnce(() => new Promise(() => {})); // the URL read before the handler hangs
    cookiesGetAll.mockImplementation(() => new Promise(() => {}));
    navigateHandler.mockResolvedValue({ success: true, url: 'https://example.com/', tabId: 7, text: 'url: https://example.com/' });
    let settled = false;
    const pending = dispatch('browser_navigate', { url: 'https://example.com/', tabId: 7 }, 's1', 'a', undefined, true)
      .then((out) => { settled = true; return out; });
    await vi.advanceTimersByTimeAsync(siteContext.OBSERVE_BUDGET_MS + 1);
    expect(settled).toBe(true);
    const out = await pending;
    expect(out).toMatchObject({ success: true, text: 'url: https://example.com/' });
    expect(out.siteContext).toMatchObject({ anonymous: null });
  });

  it('never probes a private tab (incognito verdict comes first)', async () => {
    setWorld({ incognito: true });
    expect(await ctx()).toMatchObject({ incognito: true, anonymous: false, anonymityReason: 'incognito' });
    expect(executeScript).not.toHaveBeenCalled();
    expect(cookiesGetAll).not.toHaveBeenCalled();
  });

  it('asks the parent even where it looks like a public suffix, and never a bare TLD (#6)', async () => {
    // Skipping a guessed suffix hid a cookie shared across subdomains, which let a signed-in page
    // read as anonymous. A scope Chrome forbids for domain cookies answers empty, so asking costs
    // a lookup and can only ever make the page read as less anonymous.
    for (const host of ['bbc.co.uk', 'shop.com.eg', 'site.gov.eg', 'x.com.au', 'app.ac.me']) {
      setWorld({ urls: [`https://${host}/`], cookies: [] });
      await ctx();
      const domains = cookiesGetAll.mock.calls.map(([query]: [{ domain?: string }]) => query.domain).filter(Boolean);
      expect(domains, host).toContain(host);
      expect(domains, host).toContain(host.split('.').slice(1).join('.'));
    }
    for (const host of ['example.com', 'site.dev']) {
      setWorld({ urls: [`https://${host}/`], cookies: [] });
      await ctx();
      const domains = cookiesGetAll.mock.calls.map(([query]: [{ domain?: string }]) => query.domain).filter(Boolean);
      expect(domains, host).toEqual([host]);
    }
    setWorld({ urls: ['https://www.bbc.co.uk/'], cookies: [] });
    await ctx();
    const domains = cookiesGetAll.mock.calls.map(([query]: [{ domain?: string }]) => query.domain).filter(Boolean);
    expect(domains).toContain('bbc.co.uk');
    expect(domains).not.toContain('co.uk');
  });

  it('keeps only cookies whose domain matches the host when asking a parent such as co.uk', async () => {
    const byDomain = (other: { name: string; domain: string }[]) => async (query: { domain?: string }) =>
      (query.domain === 'co.uk' ? other : []).map((c) => ({ ...c, httpOnly: true }));
    setWorld({ urls: ['https://bbc.co.uk/'] });
    cookiesGetAll.mockImplementation(byDomain([{ name: 'sid', domain: '.othersite.co.uk' }]));
    expect(await ctx()).toMatchObject({ anonymous: true });
    setWorld({ urls: ['https://bbc.co.uk/'] });
    cookiesGetAll.mockImplementation(byDomain([{ name: 'sid', domain: '.bbc.co.uk' }]));
    expect(await ctx()).toMatchObject({ anonymous: false, anonymityReason: 'cookie' });
    setWorld({ urls: ['https://app.ac.me/'] });
    cookiesGetAll.mockImplementation(async (query: { domain?: string }) =>
      (query.domain === 'ac.me' ? [{ name: 'session', domain: '.ac.me', httpOnly: true }] : []));
    expect(await ctx()).toMatchObject({ anonymous: false, anonymityReason: 'cookie' });
  });

  it('observes the replacement tab when navigate replaced a frozen one (#7)', async () => {
    tabsGet.mockImplementation(async (id: number) => {
      if (id === 5) throw new Error('No tab with id: 5');
      return { id, url: 'https://example.com/', incognito: false };
    });
    navigateHandler.mockResolvedValue({ success: true, url: 'https://example.com/', tabId: 7, replacedTabId: 5, text: 'url: https://example.com/' });
    const out = await dispatch('browser_navigate', { url: 'https://example.com/', tabId: 5 }, 's1', 'a', undefined, true);
    expect(out.siteContext).toMatchObject({ url: 'https://example.com/', stable: true, anonymous: true, anonymityReason: 'ok' });
    expect(executeScript).toHaveBeenCalledWith(expect.objectContaining({ target: { tabId: 7 } }));
    tabsGet.mockImplementation(async (id: number) => {
      const url = tabState.urls.length > 1 ? tabState.urls.shift()! : tabState.urls[0]!;
      return { id, url, incognito: tabState.incognito };
    });
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
    expect(protocol.EXTENSION_PROTOCOL_CAPABILITIES).toContain('site-map');
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

describe('light siteContext for an observed click (specs/004 R-06, T013)', () => {
  beforeEach(() => {
    // An earlier case pins tabs.get to the first URL; these cases need each read to take the next one.
    tabsGet.mockImplementation(async (id: number): Promise<Tab> => {
      const url = tabState.urls.length > 1 ? tabState.urls.shift()! : tabState.urls[0]!;
      return { id, url, incognito: tabState.incognito };
    });
  });

  it('reports url, fromUrl and stability with no page script and no cookie read', async () => {
    tabState.urls = ['https://example.com/', 'https://example.com/help?x=1', 'https://example.com/help?x=1'];
    clickHandler.mockResolvedValue({ success: true, tabId: 7, navigated: true });
    const out = await dispatch('browser_click', { tabId: 7, target: 'e3' }, 's1', 'a', undefined, true);
    expect(out.siteContext).toEqual({
      url: 'https://example.com/help?x=1',
      fromUrl: 'https://example.com/',
      incognito: false,
      topLevel: true,
      stable: true,
      anonymous: null,
      anonymityReason: 'not_probed',
    });
    expect(executeScript).not.toHaveBeenCalled();
    expect(cookiesGetAll).not.toHaveBeenCalled();
    expect(reads.values).toBe(0);
  });

  it('removes userinfo and reports a moving tab as unstable', async () => {
    tabState.urls = ['https://u:p@example.com/a', 'https://u:p@example.com/b', 'https://example.com/c'];
    clickHandler.mockResolvedValue({ success: true, tabId: 7 });
    const out = await dispatch('browser_click', { tabId: 7, target: 'e3' }, 's1', 'a', undefined, true);
    expect(out.siteContext).toMatchObject({ url: 'https://example.com/b', fromUrl: 'https://example.com/a', stable: false });
  });

  it('adds nothing without observe or to a failed click', async () => {
    clickHandler.mockResolvedValue({ success: true, tabId: 7 });
    expect((await dispatch('browser_click', { tabId: 7, target: 'e3' }, 's1', 'a')).siteContext).toBeUndefined();
    clickHandler.mockResolvedValue({ success: false, error: 'NOT_FOUND: no match' });
    expect((await dispatch('browser_click', { tabId: 7, target: 'e3' }, 's1', 'a', undefined, true)).siteContext).toBeUndefined();
  });

  it('keeps the full block for navigate and snapshot', async () => {
    snapshotHandler.mockResolvedValue({ success: true, text: 'x' });
    const snap = await dispatch('browser_snapshot', { tabId: 7 }, 's1', 'a', undefined, true);
    expect(snap.siteContext).toMatchObject({ anonymous: true, anonymityReason: 'ok' });
    expect(snap.siteContext.fromUrl).toBeUndefined();
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
