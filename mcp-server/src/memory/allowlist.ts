/**
 * The reviewed fact allowlist as code. It mirrors
 * specs/003-website-agent-memory/contracts/fact-allowlist.json (owner gate 3,
 * approved 2026-10-27, widened at the owner's request 2026-10-28 as v2);
 * tests/memory-allowlist.test.ts fails if the two drift.
 * A stored string must equal an entry here after normalizeText(); anything
 * else is discarded, never truncated or rewritten.
 */

export const ALLOWLIST = {
  version: 2,
  factKinds: {
    'site.language': { source: 'siteContext.lang and siteContext.dir', values: 'lang: primaryLanguageTags; dir: ltr | rtl | null' },
    'ui.search': { source: 'snapshot line \'<role> "<name>"\' with role in searchRoles and name in phrases.search, or name starting with a searchPrefixes prefix (then the stored name is that prefix\'s canonical phrase, never the page\'s name)' },
    'ui.login': { source: 'siteContext.passwordField === true', values: 'path: page path if every segment is in pathSegments, else null' },
    'ui.control': { source: 'snapshot line \'<role> "<name>"\' with role in controlRoles and name in any phrases group except search' },
  },
  searchRoles: ['searchbox', 'textbox', 'combobox', 'search'],
  controlRoles: ['button', 'link', 'tab', 'menuitem'],
  searchPrefixes: [
    { prefix: 'search ', canonical: 'search' },
    { prefix: 'ابحث في ', canonical: 'ابحث' },
    { prefix: 'البحث في ', canonical: 'ابحث' },
    { prefix: 'بحث في ', canonical: 'ابحث' },
  ],
  phrases: {
    search: [
      'search', 'search site', 'بحث', 'ابحث', 'البحث', 'search the web', 'search this site', 'search docs',
      'ابحث في الموقع',
    ],
    account: [
      'sign in', 'log in', 'login', 'sign up', 'register', 'create account', 'log out', 'sign out',
      'forgot password', 'تسجيل الدخول', 'دخول', 'إنشاء حساب', 'تسجيل', 'تسجيل الخروج', 'خروج', 'نسيت كلمة المرور',
      'your account', 'my account', 'account', 'profile', 'حسابي', 'الحساب', 'الملف الشخصي',
    ],
    consent: [
      'accept', 'accept all', 'accept cookies', 'allow all', 'reject', 'reject all', 'decline', 'cookie settings',
      'manage cookies', 'manage preferences', 'قبول', 'قبول الكل', 'موافق', 'رفض', 'رفض الكل', 'إعدادات ملفات تعريف الارتباط',
      'accept additional cookies', 'reject additional cookies', 'view cookies', 'accept all cookies', 'reject all cookies', 'necessary cookies only', 'only necessary cookies', 'agree',
      'i agree', 'i accept', 'got it', 'ok', 'قبول جميع ملفات تعريف الارتباط', 'رفض جميع ملفات تعريف الارتباط', 'أوافق', 'حسنًا',
      'فهمت',
    ],
    navigation: [
      'menu', 'close', 'next', 'previous', 'back', 'home', 'help', 'contact us',
      'language', 'settings', 'القائمة', 'إغلاق', 'التالي', 'السابق', 'رجوع', 'الرئيسية',
      'مساعدة', 'اتصل بنا', 'اللغة', 'الإعدادات', 'skip to content', 'skip to main content', 'main menu', 'open menu',
      'show navigation menu', 'show search menu', 'more', 'more menu', 'sitemap', 'about', 'about us', 'faq',
      'terms', 'privacy', 'انتقل إلى المحتوى', 'تخطي إلى المحتوى', 'القائمة الرئيسية', 'القائمة الرئيسة', 'المزيد', 'من نحن',
      'الأسئلة الشائعة', 'الشروط', 'الخصوصية',
    ],
    commerce: [
      'cart', 'add to cart', 'checkout', 'buy now', 'السلة', 'أضف إلى السلة', 'الدفع', 'اشتر الآن',
      'wishlist', 'my orders', 'donate', 'قائمة الرغبات', 'طلباتي', 'تبرع',
    ],
    forms: [
      'submit', 'continue', 'send', 'save', 'إرسال', 'متابعة', 'حفظ',
    ],
  },
  pathSegments: [
    'login', 'log-in', 'signin', 'sign-in', 'logon', 'auth', 'account', 'accounts', 'session', 'sessions', 'sso', 'identity',
    'register', 'signup', 'sign-up', 'join', 'password', 'reset', 'search', 'help', 'support', 'contact', 'cart', 'checkout',
    'en', 'ar', 'fr', 'de', 'es', 'user', 'profile', 'settings', 'docs', 'documentation', 'about', 'faq',
    'terms', 'privacy', 'news', 'blog', 'wiki', 'home', 'it', 'pt', 'ru', 'zh', 'ja', 'tr',
    'fa', 'ur',
  ],
  anonymityNames: {
    exact: [
      'CookieConsent', 'OptanonConsent', 'OptanonAlertBoxClosed', 'euconsent-v2', 'cookieyes-consent', 'cookielawinfo-checkbox-necessary',
      '_ga', '_gid', '_gat', '_gcl_au', '_fbp', 'cookies_policy',
      'FCCDCF', 'FCNEC', 'GeoIP', 'NetworkProbeLimit', 'WMF-Last-Access', 'WMF-Last-Access-Global', 'WMF-Uniq', 'WMF-DP',
      'appLifetimeMetrics', 'userLifetimeMetrics', 'glean_session_last_active', '__cf_bm', '_cfuvid', 'cf_clearance',
      'AWSALB', 'AWSALBCORS', '_clck', '_clsk', 'CentralAuthAnon', 'ddg-promotions',
    ],
    patterns: [
      '^_ga_[A-Z0-9]{6,12}$', '^_gat_[A-Za-z0-9]+$', '^[a-z0-9_]+wikimwuser-sessionId$',
      '^MediaWikiModuleStore:[A-Za-z0-9_]+$', '^CentralNoticeKV\\|[A-Za-z0-9_|-]+$', '^_GESPSK-[A-Za-z0-9_-]+$',
      '^_hjSessionUser_[0-9]+$', '^_hjSession_[0-9]+$', '^wmE-sessionTick[A-Za-z]+$',
    ],
  },
} as const;

export type SearchRole = (typeof ALLOWLIST.searchRoles)[number];
export type ControlRole = (typeof ALLOWLIST.controlRoles)[number];
export type FactKind = keyof typeof ALLOWLIST.factKinds;

export type FactValue =
  | { lang: string; dir: 'ltr' | 'rtl' | null }
  | { role: SearchRole; name: string }
  | { path: string | null }
  | { role: ControlRole; name: string };

export interface CandidateFact {
  factId: string;
  kind: FactKind;
  value: FactValue;
}

/** NFKC, lower case, whitespace collapsed to one space, trimmed, trailing `.` `:` `…` removed. */
export function normalizeText(raw: string): string {
  return raw
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\s+/gu, ' ')
    .trim()
    .replace(/[.:…\s]+$/u, '');
}

const SEARCH_PHRASES: ReadonlySet<string> = new Set(ALLOWLIST.phrases.search.map(normalizeText));
const CONTROL_PHRASES: ReadonlySet<string> = new Set(
  [
    ...ALLOWLIST.phrases.account,
    ...ALLOWLIST.phrases.consent,
    ...ALLOWLIST.phrases.navigation,
    ...ALLOWLIST.phrases.commerce,
    ...ALLOWLIST.phrases.forms,
  ].map(normalizeText),
);
const PATH_SEGMENTS: ReadonlySet<string> = new Set(ALLOWLIST.pathSegments);
const ANONYMITY_EXACT: ReadonlySet<string> = new Set(ALLOWLIST.anonymityNames.exact);
const ANONYMITY_PATTERNS: readonly RegExp[] = ALLOWLIST.anonymityNames.patterns.map((source) => new RegExp(source, 'u'));

function matchIn(set: ReadonlySet<string>, text: unknown): string | null {
  if (typeof text !== 'string') return null;
  const normalized = normalizeText(text);
  return set.has(normalized) ? normalized : null;
}

/** The normalized search phrase, or null when `text` is not exactly one. */
export function matchSearchName(text: string): string | null {
  return matchIn(SEARCH_PHRASES, text);
}

/** The normalized control phrase (any group except search), or null. */
export function matchControlName(text: string): string | null {
  return matchIn(CONTROL_PHRASES, text);
}

/**
 * A URL path (no query, fragment or encoding) whose every segment is on the
 * list, lower-cased without a trailing slash; otherwise null. The root path
 * has no segment to verify, so it is null as well.
 */
export function matchPath(path: string): string | null {
  if (typeof path !== 'string' || !path.startsWith('/') || /[?#%\\:]/u.test(path)) return null;
  const parts = path.slice(1).replace(/\/$/u, '').split('/');
  const segments: string[] = [];
  for (const part of parts) {
    const segment = part.normalize('NFKC').toLowerCase();
    if (!PATH_SEGMENTS.has(segment)) return null;
    segments.push(segment);
  }
  return `/${segments.join('/')}`;
}

/** The primary language subtag when it matches `^[a-z]{2,3}$`; region, script and private-use subtags are dropped. */
export function primaryLanguage(tag: string | null | undefined): string | null {
  if (typeof tag !== 'string') return null;
  const primary = tag.trim().toLowerCase().split(/[-_]/u, 1)[0];
  return /^[a-z]{2,3}$/u.test(primary) ? primary : null;
}

function direction(dir: string | null | undefined): 'ltr' | 'rtl' | null {
  const value = typeof dir === 'string' ? dir.trim().toLowerCase() : '';
  return value === 'ltr' || value === 'rtl' ? value : null;
}

export function languageFact(lang: string | null | undefined, dir: string | null | undefined): CandidateFact | null {
  const primary = primaryLanguage(lang);
  if (!primary) return null;
  return { factId: 'site.language', kind: 'site.language', value: { lang: primary, dir: direction(dir) } };
}

/**
 * A search name that starts with a reviewed prefix ("search …", "ابحث في …") maps to that prefix's
 * canonical phrase; the rest of the page's name is dropped, so no page text is stored.
 */
function canonicalSearchName(text: string): string | null {
  if (typeof text !== 'string') return null;
  const normalized = normalizeText(text);
  for (const { prefix, canonical } of ALLOWLIST.searchPrefixes) {
    if (normalized.startsWith(prefix) && normalized.length > prefix.length) return canonical;
  }
  return null;
}

export function searchFact(role: string, name: string): CandidateFact | null {
  if (!(ALLOWLIST.searchRoles as readonly string[]).includes(role)) return null;
  const phrase = matchSearchName(name) ?? canonicalSearchName(name);
  if (!phrase) return null;
  return { factId: 'ui.search', kind: 'ui.search', value: { role: role as SearchRole, name: phrase } };
}

export function loginFact(passwordField: boolean, pagePath: string | null | undefined): CandidateFact | null {
  if (passwordField !== true) return null;
  const matched = typeof pagePath === 'string' ? matchPath(pagePath) : null;
  return { factId: 'ui.login', kind: 'ui.login', value: { path: matched } };
}

export function controlFact(role: string, name: string): CandidateFact | null {
  if (!(ALLOWLIST.controlRoles as readonly string[]).includes(role)) return null;
  const phrase = matchControlName(name);
  if (!phrase) return null;
  return { factId: `ui.control:${role}:${phrase}`, kind: 'ui.control', value: { role: role as ControlRole, name: phrase } };
}

/** True for a consent or analytics cookie/storage key name that does not by itself indicate a signed-in user. Exact and case-sensitive. */
export function isAnonymityName(name: string): boolean {
  if (typeof name !== 'string' || name === '') return false;
  return ANONYMITY_EXACT.has(name) || ANONYMITY_PATTERNS.some((pattern) => pattern.test(name));
}
