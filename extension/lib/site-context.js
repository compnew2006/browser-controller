/**
 * siteContext (specs/003-website-agent-memory R-05, R-07; contracts/site-context.schema.json).
 * When the daemon sets observe:true on a browser_navigate or browser_snapshot request, the
 * extension reports where the tab landed and whether the page was read in an anonymous context.
 * Only names are compared (cookie, localStorage and sessionStorage keys); values are never read.
 * Any step that fails or is unavailable gives anonymous:null, which the daemon treats as unverified.
 */
import { safeExec } from './page-exec.js';

/**
 * Cookie and web-storage key names that do not by themselves indicate a signed-in user. Keep equal
 * to anonymityNames in contracts/fact-allowlist.json (tests/extension-site-context.test.ts).
 */
export const ANONYMITY_NAMES = Object.freeze({
  exact: Object.freeze([
    'CookieConsent', 'OptanonConsent', 'OptanonAlertBoxClosed', 'euconsent-v2', 'cookieyes-consent', 'cookielawinfo-checkbox-necessary',
    '_ga', '_gid', '_gat', '_gcl_au', '_fbp',
  ]),
  prefix: Object.freeze(['_ga_', '_gat_']),
});

const MAX_URL_CHARS = 2048;
const PROBE_TIMEOUT_MS = 3_000;

/** Whether `name` is an allowlisted anonymity name. Exact or prefix; case-sensitive, no normalization. */
export function isAnonymityName(name) {
  if (typeof name !== 'string') return false;
  return ANONYMITY_NAMES.exact.includes(name) || ANONYMITY_NAMES.prefix.some((prefix) => name.startsWith(prefix));
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
  const cookies = await chrome.cookies.getAll(storeId === undefined ? { url } : { url, storeId });
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
 * Never throws.
 */
export async function buildSiteContext(tabId, { urlBefore = null, navigated = false } = {}) {
  let tab = null;
  try {
    tab = await chrome.tabs.get(tabId);
    const afterHandler = typeof tab?.url === 'string' ? tab.url : '';
    const incognito = tab?.incognito === true;
    const probe = await safeExec(tabId, probeSitePage, [], { timeoutMs: PROBE_TIMEOUT_MS });
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

    if (incognito) return verdict(false, 'incognito');
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
    return {
      url: '',
      incognito: tab?.incognito === true,
      topLevel: false,
      stable: false,
      anonymous: null,
      anonymityReason: 'unavailable',
    };
  }
}
