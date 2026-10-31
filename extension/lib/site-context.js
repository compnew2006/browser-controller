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
    '_ga', '_gid', '_gat', '_gcl_au', '_fbp', 'cookies_policy',
    'FCCDCF', 'FCNEC', 'GeoIP', 'NetworkProbeLimit', 'WMF-Last-Access', 'WMF-Last-Access-Global', 'WMF-Uniq', 'WMF-DP',
    'appLifetimeMetrics', 'userLifetimeMetrics', 'glean_session_last_active', '__cf_bm', '_cfuvid', 'cf_clearance',
    'AWSALB', 'AWSALBCORS', '_clck', '_clsk', 'CentralAuthAnon', 'ddg-promotions',
  ]),
  patterns: Object.freeze([
    '^_ga_[A-Z0-9]{6,12}$', '^_gat_[A-Za-z0-9]+$', '^[a-z0-9_]+wikimwuser-sessionId$',
    '^MediaWikiModuleStore:[A-Za-z0-9_]+$', '^CentralNoticeKV\\|[A-Za-z0-9_|-]+$', '^_GESPSK-[A-Za-z0-9_-]+$',
    '^_hjSessionUser_[0-9]+$', '^_hjSession_[0-9]+$', '^wmE-sessionTick[A-Za-z]+$',
  ]),
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
  // The probe as a whole is bounded by PROBE_TIMEOUT_MS in this module. The shape is measured inside that
  // budget, never beyond it: a slow page must lose the shape, not the anonymity verdict (R-09).
  const probeStartedAt = performance.now();
  const PROBE_DEADLINE_MS = 900;
  const PROBE_MARGIN_MS = 120;
  const SHAPE_BUDGET_MS = 250;
  /** The scan is bounded, so a page with thousands of forms cannot cost the probe its budget. */
  const MAX_FORMS_SCANNED = 50;
  const MAX_CONTROLS_SCANNED = 200;
  // The shape of the form inside the main landmark (specs/007-form-shape-facts). Counts and reviewed words
  // only: no label, no name, no value, no placeholder, no id, no selector. It is measured in the DOM,
  // because a control the snapshot never shows cannot be counted from the snapshot at all.
  const measureFormShape = () => {
    const budget = Math.min(SHAPE_BUDGET_MS, PROBE_DEADLINE_MS - PROBE_MARGIN_MS - (performance.now() - probeStartedAt));
    if (budget <= 0) return null;
    const deadline = performance.now() + budget;
    const styleOf = (element) => {
      try { return getComputedStyle(element); } catch { return null; }
    };
    const isFillable = (element) => {
      const tag = element.tagName;
      if (tag === 'INPUT') {
        const type = String(element.getAttribute('type') || 'text').toLowerCase();
        return !['hidden', 'submit', 'button', 'reset', 'image'].includes(type);
      }
      if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
      const editable = element.getAttribute('contenteditable');
      return editable === '' || editable === 'true';
    };
    const fieldType = (element) => {
      const tag = element.tagName;
      if (tag === 'TEXTAREA') return 'textarea';
      if (tag === 'SELECT') return 'select';
      if (tag !== 'INPUT') return 'other';
      const type = String(element.getAttribute('type') || 'text').toLowerCase();
      if (type === 'password') return 'password';
      if (type === 'email') return 'email';
      if (type === 'search') return 'search';
      if (type === 'tel') return 'tel';
      if (type === 'url') return 'url';
      if (type === 'number' || type === 'range') return 'number';
      if (type === 'date' || type === 'datetime-local' || type === 'month' || type === 'week' || type === 'time') return 'date';
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio';
      if (type === 'file') return 'file';
      if (type === 'text') return 'text';
      return 'other';
    };
    const isRequired = (element) => {
      try { if (element.hasAttribute && element.hasAttribute('required')) return true; } catch { /* no hasAttribute */ }
      try { return element.getAttribute('aria-required') === 'true'; } catch { return false; }
    };
    const visuallyHidden = (element) => {
      try { if (element.closest && element.closest('[aria-hidden="true"]')) return true; } catch { /* no closest */ }
      let node = element;
      while (node && node.nodeType === 1) {
        const style = styleOf(node);
        if (style) {
          if (style.display === 'none') return true;
          if (style.visibility === 'hidden' || style.visibility === 'collapse') return true;
          if (Number.parseFloat(String(style.opacity)) === 0) return true;
        }
        node = node.parentElement;
      }
      try { return element.getClientRects().length === 0; } catch { return false; }
    };
    const isLandmark = (element) => element.tagName === 'MAIN' || element.getAttribute('role') === 'main';
    // D-05: a form's landmark is its nearest landmark ancestor, so a form inside a nested landmark belongs
    // to that one. A form outside every landmark is not measured.
    const nearestLandmark = (element) => {
      let node = element.parentElement;
      while (node) {
        if (isLandmark(node)) return node;
        node = node.parentElement;
      }
      return null;
    };
    // D-07: the form with the most fillable fields wins; a tie goes to the form that comes first in the
    // document. The scan is bounded so that a huge page cannot cost the probe its budget (R-09).
    let fields = [];
    const forms = document.querySelectorAll('form');
    let scanned = 0;
    for (let index = 0; index < forms.length && scanned < MAX_FORMS_SCANNED; index += 1) {
      const form = forms[index];
      if (performance.now() > deadline) return null;
      if (!nearestLandmark(form)) continue;
      scanned += 1;
      const candidates = [];
      let examined = 0;
      for (const element of form.querySelectorAll('input, textarea, select, [contenteditable]')) {
        if (candidates.length >= MAX_CONTROLS_SCANNED || examined >= MAX_CONTROLS_SCANNED * 4) break;
        examined += 1;
        if (isFillable(element)) candidates.push(element);
        if ((examined & 31) === 0 && performance.now() > deadline) return null;
      }
      if (candidates.length > fields.length) fields = candidates;
    }
    if (fields.length === 0 || fields.length > 64) return null;
    let required = 0;
    let hidden = false;
    const counts = new Map();
    for (const element of fields) {
      if (performance.now() > deadline) return null;
      if (isRequired(element)) required += 1;
      if (visuallyHidden(element)) hidden = true;
      const type = fieldType(element);
      counts.set(type, (counts.get(type) || 0) + 1);
    }
    const ordered = [...counts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
    let types = ordered.map((entry) => entry[0]);
    if (types.length > 8) {
      const head = types.slice(0, 7);
      types = head.includes('other') ? head : [...head, 'other'];
    }
    return { fields: fields.length, required, types, hidden };
  };
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
    // The shape is measured last: a slow page must not cost the anonymity verdict.
    let formShape = null;
    try {
      formShape = measureFormShape();
    } catch {
      formShape = null; // a page that cannot be measured simply has no shape
    }
    return {
      topLevel: window.top === window,
      lang: rawLang,
      dir: rawDir,
      passwordField,
      local,
      session,
      databases,
      formShape,
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

/** True when a cookie set for `domain` would be sent to the host of `url` (RFC 6265 domain-match). */
function appliesToHost(domain, url) {
  let host;
  try { host = new URL(url).hostname.toLowerCase(); } catch { return true; }
  const scope = String(domain ?? '').toLowerCase().replace(/^\./, '');
  return scope === '' || host === scope || host.endsWith(`.${scope}`);
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
  // or to a sibling subdomain is missed. Ask by domain too — the host, and its parent for a host of three or more
  // labels — names only. Over-inclusion can only make a page less anonymous, so the parent is asked on any doubt:
  // guessing at a public suffix (ac.me is a registered domain, not a suffix) would hide a login cookie shared
  // across subdomains and let a signed-in page pass as anonymous. getAll({domain}) also returns every subdomain's
  // cookies (asking co.uk lists all *.co.uk sites), so only cookies whose domain matches this host are kept.
  const queries = [{ url, ...scope }];
  try {
    const host = new URL(url).hostname;
    if (host && !/^[\d.]+$/.test(host) && !host.includes(':')) {
      queries.push({ domain: host, ...scope });
      const labels = host.split('.');
      // Three labels leave a two-label parent; a two-label host has only a bare TLD above it, which holds nothing.
      if (labels.length >= 3) queries.push({ domain: labels.slice(1).join('.'), ...scope });
    }
  } catch { /* url was already parsed by the caller */ }
  const cookies = (await Promise.all(queries.map((query) => chrome.cookies.getAll(query)))).flat();
  return { permission: true, names: cookies.filter((cookie) => appliesToHost(cookie.domain, url)).map((cookie) => cookie.name) };
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
export async function buildSiteContext(tabId, { urlBefore = null, navigated = false, light = false, budgetMs = SITE_CONTEXT_BUDGET_MS } = {}) {
  let timer;
  const fallback = light ? lightContext(null, '', urlBefore, false) : unavailableContext(null);
  const late = new Promise((resolve) => { timer = setTimeout(() => resolve(fallback), budgetMs); });
  try {
    return await Promise.race([light ? readLightContext(tabId, urlBefore) : readSiteContext(tabId, urlBefore, navigated), late]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The light block for an observed click (specs/004-site-navigation-map R-06): tab-level URLs only. No page
 * script runs and no cookie or storage is read; anonymity is not probed. Query and fragment stay in the URLs
 * so the daemon can see they exist; userinfo is removed.
 */
function lightContext(tab, after, urlBefore, stable) {
  return {
    url: after ? inspectUrl(after).safeUrl : '',
    fromUrl: typeof urlBefore === 'string' && urlBefore ? inspectUrl(urlBefore).safeUrl : '',
    incognito: tab?.incognito === true,
    topLevel: true,
    stable,
    anonymous: null,
    anonymityReason: 'not_probed',
  };
}

async function readLightContext(tabId, urlBefore) {
  let tab = null;
  try {
    tab = await chrome.tabs.get(tabId);
    const afterHandler = typeof tab?.url === 'string' ? tab.url : '';
    const afterRead = await captureTabUrl(tabId);
    return lightContext(tab, afterHandler, urlBefore, afterHandler !== '' && afterRead === afterHandler);
  } catch {
    return lightContext(tab, '', urlBefore, false);
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
      // The measured form's shape, when the page has one inside its main landmark (007). Absent otherwise.
      ...(probe?.formShape ? { formShape: probe.formShape } : {}),
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
