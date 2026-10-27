/**
 * siteContext (specs/003-website-agent-memory R-05, R-07; contracts/site-context.schema.json).
 * When the daemon sets observe:true on a browser_navigate or browser_snapshot request, the
 * extension reports where the tab landed and whether the page was read in an anonymous context.
 * Only names are compared (cookie, localStorage and sessionStorage keys); values are never read.
 * Any step that fails or is unavailable gives anonymous:null, which the daemon treats as unverified.
 */
import { withTimeout } from './page-exec.js';
import { wedgedTabs } from './state.js';
import { getOpenDialog } from './cdp-session.js';

/**
 * Cookie and web-storage key names that do not by themselves indicate a signed-in user. Keep equal
 * to anonymityNames in contracts/fact-allowlist.json (tests/extension-site-context.test.ts).
 */
export const ANONYMITY_NAMES = Object.freeze({
  exact: Object.freeze([
    'CookieConsent', 'OptanonConsent', 'OptanonAlertBoxClosed', 'euconsent-v2', 'cookieyes-consent', 'cookielawinfo-checkbox-necessary',
    '_ga', '_gid', '_gat', '_gcl_au', '_fbp',
  ]),
  patterns: Object.freeze(['^_ga_[A-Z0-9]{6,12}$', '^_gat_[A-Za-z0-9]+$']),
});

const ANONYMITY_PATTERNS = ANONYMITY_NAMES.patterns.map((source) => new RegExp(source));

const MAX_URL_CHARS = 2048;
/**
 * Time budgets. The observation runs inside the navigate or snapshot call, so it must stay well
 * below the bridge timeout: the URL read before the handler plus everything after it fit in
 * OBSERVE_BUDGET_MS. Past a budget the answer is anonymous:null ('unavailable'), never an error.
 */
export const URL_BEFORE_BUDGET_MS = 200;
export const SITE_CONTEXT_BUDGET_MS = 1_300;
export const OBSERVE_BUDGET_MS = URL_BEFORE_BUDGET_MS + SITE_CONTEXT_BUDGET_MS;
const PROBE_TIMEOUT_MS = 900;

/**
 * Second-level labels that, under a two-letter country code, form a public suffix (co.uk, com.au,
 * gov.eg). No public suffix list ships with the extension, so this covers the common cases only;
 * a missed suffix can only make pages read as less anonymous, never more.
 */
const SECOND_LEVEL_SUFFIX_LABELS = new Set(['co', 'com', 'net', 'org', 'gov', 'edu', 'ac', 'or', 'ne', 'go', 'gob', 'mil', 'nic', 'me', 'ltd', 'plc', 'sch', 'info', 'biz']);

function looksLikePublicSuffix(domain) {
  const labels = domain.split('.');
  if (labels.length < 2) return true;
  return labels.length === 2 && /^[a-z]{2}$/.test(labels[1]) && SECOND_LEVEL_SUFFIX_LABELS.has(labels[0]);
}

/** Whether `name` is an allowlisted anonymity name. Exact or a full-match pattern; case-sensitive, no normalization. */
export function isAnonymityName(name) {
  if (typeof name !== 'string') return false;
  return ANONYMITY_NAMES.exact.includes(name) || ANONYMITY_PATTERNS.some((pattern) => pattern.test(name));
}

/**
 * The page-side read. It runs in the tab's top frame and must be self-contained: no closures, no
 * imports. It returns structure and key NAMES only, never a value, an input name or a label.
 */
export async function probeSitePage() {
  try {
    const root = document.documentElement;
    const rawLang = String(root?.lang || '').toLowerCase().split('-')[0];
    const rawDir = String(root?.dir || '').toLowerCase();
    let passwordField = false;
    for (const input of document.querySelectorAll('input[type=password]')) {
      const style = getComputedStyle(input);
      if (input.getClientRects().length > 0 && style.visibility !== 'hidden' && style.display !== 'none') {
        passwordField = true;
        break;
      }
    }
    const names = (storage) => {
      const out = [];
      for (let i = 0; i < storage.length; i += 1) out.push(storage.key(i));
      return out;
    };
    let local = null;
    let session = null;
    try {
      local = names(localStorage);
      session = names(sessionStorage);
    } catch {
      local = null; // storage blocked: unknown, not empty
    }
    let databases = null;
    try {
      if (typeof indexedDB?.databases === 'function') databases = (await indexedDB.databases()).length;
    } catch {
      databases = null;
    }
    return {
      topLevel: window.top === window,
      lang: rawLang,
      dir: rawDir,
      passwordField,
      local,
      session,
      databases,
    };
  } catch (error) {
    return { __bcScriptError: error?.message || String(error) };
  }
}

/** The tab's URL right now, or null when the tab is gone. */
export async function captureTabUrl(tabId) {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  return typeof tab?.url === 'string' ? tab.url : null;
}

/** captureTabUrl within URL_BEFORE_BUDGET_MS; null (unknown) past it. */
export function captureTabUrlBounded(tabId) {
  return withTimeout(captureTabUrl(tabId), URL_BEFORE_BUDGET_MS, () => new Error('url read timed out')).catch(() => null);
}

/**
 * Run probeSitePage in the tab's top frame. Unlike safeExec, a slow page never marks the tab
 * wedged: the observation must not change how later calls treat the tab. Any failure is null.
 */
async function runProbe(tabId) {
  if (wedgedTabs.has(tabId) || getOpenDialog(tabId)) return null;
  try {
    const results = await withTimeout(
      chrome.scripting.executeScript({ target: { tabId }, func: probeSitePage }),
      PROBE_TIMEOUT_MS,
      () => new Error('probe timed out'),
    );
    const res = results?.[0]?.result;
    if (!res || typeof res !== 'object' || typeof res.__bcScriptError === 'string') return null;
    return res;
  } catch {
    return null;
  }
}

/**
 * Shape of the URL: whether it is a plain http(s) address, and whether it carries userinfo, a query
 * or a fragment. `safeUrl` is the URL with userinfo removed and within the contract's length.
 */
function inspectUrl(raw) {
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return { http: false, tainted: false, safeUrl: '' };
  }
  const tainted = !!(parsed.username || parsed.password || parsed.search || parsed.hash);
  parsed.username = '';
  parsed.password = '';
  return { http: parsed.protocol === 'http:' || parsed.protocol === 'https:', tainted, safeUrl: parsed.href.slice(0, MAX_URL_CHARS) };
}

/** Cookie names for `url` in the tab's own cookie store (HttpOnly included). Values are dropped here. */
async function cookieNames(tabId, url) {
  if (typeof chrome.cookies?.getAll !== 'function') return { permission: false, names: [] };
  let storeId;
  if (typeof chrome.cookies.getAllCookieStores === 'function') {
    const stores = await chrome.cookies.getAllCookieStores();
    storeId = stores.find((store) => Array.isArray(store.tabIds) && store.tabIds.includes(tabId))?.id;
    if (storeId === undefined) throw new Error('no cookie store for the tab');
  }
  const scope = storeId === undefined ? {} : { storeId };
  // getAll({url}) only sees cookies that would be sent to this exact URL; a login cookie scoped to another path
  // or to a sibling subdomain is missed. Ask by domain too (host, and its parent for 3+ label hosts unless the
  // parent looks like a public suffix such as co.uk), names only.
  // Over-inclusion can only make a page less anonymous, never more.
  const queries = [{ url, ...scope }];
  try {
    const host = new URL(url).hostname;
    if (host && !/^[\d.]+$/.test(host) && !host.includes(':')) {
      queries.push({ domain: host, ...scope });
      const parent = host.split('.').slice(1).join('.');
      if (host.split('.').length >= 3 && !looksLikePublicSuffix(parent)) queries.push({ domain: parent, ...scope });
    }
  } catch { /* url was already parsed by the caller */ }
  const cookies = (await Promise.all(queries.map((query) => chrome.cookies.getAll(query)))).flat();
  return { permission: true, names: cookies.map((cookie) => cookie.name) };
}

function primaryLanguage(raw) {
  return typeof raw === 'string' && /^[a-z]{2,8}$/.test(raw) ? raw : null;
}

/**
 * Build the siteContext block for a tab after a handler ran.
 * `urlBefore` is the tab URL taken before the handler (null if the tab did not exist yet).
 * `navigated` is true for browser_navigate: the URL is expected to change across the handler, so
 * only the handler-end URL is compared with the URL after the page read.
 * Answers within `budgetMs`; past it the block is anonymous:null ('unavailable'). Never throws.
 */
export async function buildSiteContext(tabId, { urlBefore = null, navigated = false, budgetMs = SITE_CONTEXT_BUDGET_MS } = {}) {
  let timer;
  const late = new Promise((resolve) => { timer = setTimeout(() => resolve(unavailableContext(null)), budgetMs); });
  try {
    return await Promise.race([readSiteContext(tabId, urlBefore, navigated), late]);
  } finally {
    clearTimeout(timer);
  }
}

function unavailableContext(tab) {
  return {
    url: '',
    incognito: tab?.incognito === true,
    topLevel: false,
    stable: false,
    anonymous: null,
    anonymityReason: 'unavailable',
  };
}

async function readSiteContext(tabId, urlBefore, navigated) {
  let tab = null;
  try {
    tab = await chrome.tabs.get(tabId);
    const afterHandler = typeof tab?.url === 'string' ? tab.url : '';
    const incognito = tab?.incognito === true;
    if (incognito) {
      // A private tab is never probed: the verdict is known without reading the page.
      return {
        url: inspectUrl(afterHandler).safeUrl,
        incognito: true,
        topLevel: false,
        stable: navigated || urlBefore === afterHandler,
        lang: null,
        dir: null,
        passwordField: false,
        anonymous: false,
        anonymityReason: 'incognito',
      };
    }
    const probe = await runProbe(tabId);
    const afterRead = await captureTabUrl(tabId);
    const stable = afterRead === afterHandler && (navigated || urlBefore === afterHandler);
    const shape = inspectUrl(afterHandler);

    const context = {
      url: shape.safeUrl,
      incognito,
      topLevel: probe?.topLevel === true,
      stable,
      lang: primaryLanguage(probe?.lang),
      dir: probe?.dir === 'ltr' || probe?.dir === 'rtl' ? probe.dir : null,
      passwordField: probe?.passwordField === true,
    };
    const verdict = (anonymous, anonymityReason) => ({ ...context, anonymous, anonymityReason });

    if (!stable) return verdict(null, 'unstable');
    if (!shape.http) return verdict(null, 'unavailable');
    if (shape.tainted) return verdict(false, 'query');
    if (!probe || probe.local === null || probe.session === null) return verdict(null, 'unavailable');
    if (![...probe.local, ...probe.session].every(isAnonymityName)) return verdict(false, 'storage');
    if (typeof chrome.cookies?.getAll !== 'function') return verdict(null, 'no_permission');
    let names;
    try {
      ({ names } = await cookieNames(tabId, shape.safeUrl));
    } catch {
      return verdict(null, 'unavailable');
    }
    if (!names.every(isAnonymityName)) return verdict(false, 'cookie');
    if (probe.databases === null) return verdict(null, 'unavailable');
    if (probe.databases > 0) return verdict(false, 'indexeddb');
    return verdict(true, 'ok');
  } catch {
    return unavailableContext(tab);
  }
}
