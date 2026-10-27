/**
 * The reviewed fact allowlist as code. It mirrors
 * specs/003-website-agent-memory/contracts/fact-allowlist.json (owner gate 3,
 * approved 2026-10-27); tests/memory-allowlist.test.ts fails if the two drift.
 * A stored string must equal an entry here after normalizeText(); anything
 * else is discarded, never truncated or rewritten.
 */

export const ALLOWLIST = {
  version: 1,
  factKinds: {
    'site.language': { source: 'siteContext.lang and siteContext.dir', values: 'lang: primaryLanguageTags; dir: ltr | rtl | null' },
    'ui.search': { source: 'snapshot line \'<role> "<name>"\' with role in searchRoles and name in phrases.search' },
    'ui.login': { source: 'siteContext.passwordField === true', values: 'path: page path if every segment is in pathSegments, else null' },
    'ui.control': { source: 'snapshot line \'<role> "<name>"\' with role in controlRoles and name in any phrases group except search' },
  },
  searchRoles: ['searchbox', 'textbox', 'combobox'],
  controlRoles: ['button', 'link', 'tab', 'menuitem'],
  phrases: {
    search: ['search', 'search site', 'بحث', 'ابحث', 'البحث'],
    account: [
      'sign in', 'log in', 'login', 'sign up', 'register', 'create account', 'log out', 'sign out', 'forgot password',
      'تسجيل الدخول', 'دخول', 'إنشاء حساب', 'تسجيل', 'تسجيل الخروج', 'خروج', 'نسيت كلمة المرور',
    ],
    consent: [
      'accept', 'accept all', 'accept cookies', 'allow all', 'reject', 'reject all', 'decline', 'cookie settings', 'manage cookies', 'manage preferences',
      'قبول', 'قبول الكل', 'موافق', 'رفض', 'رفض الكل', 'إعدادات ملفات تعريف الارتباط',
    ],
    navigation: [
      'menu', 'close', 'next', 'previous', 'back', 'home', 'help', 'contact us', 'language', 'settings',
      'القائمة', 'إغلاق', 'التالي', 'السابق', 'رجوع', 'الرئيسية', 'مساعدة', 'اتصل بنا', 'اللغة', 'الإعدادات',
    ],
    commerce: ['cart', 'add to cart', 'checkout', 'buy now', 'السلة', 'أضف إلى السلة', 'الدفع', 'اشتر الآن'],
    forms: ['submit', 'continue', 'send', 'save', 'إرسال', 'متابعة', 'حفظ'],
  },
  pathSegments: [
    'login', 'log-in', 'signin', 'sign-in', 'logon', 'auth', 'account', 'accounts', 'session', 'sessions', 'sso', 'identity',
    'register', 'signup', 'sign-up', 'join', 'password', 'reset', 'search', 'help', 'support', 'contact', 'cart', 'checkout',
    'en', 'ar', 'fr', 'de', 'es',
  ],
  anonymityNames: {
    exact: [
      'CookieConsent', 'OptanonConsent', 'OptanonAlertBoxClosed', 'euconsent-v2', 'cookieyes-consent', 'cookielawinfo-checkbox-necessary',
      '_ga', '_gid', '_gat', '_gcl_au', '_fbp',
    ],
    prefix: ['_ga_', '_gat_'],
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

export function searchFact(role: string, name: string): CandidateFact | null {
  if (!(ALLOWLIST.searchRoles as readonly string[]).includes(role)) return null;
  const phrase = matchSearchName(name);
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
  return ANONYMITY_EXACT.has(name) || ALLOWLIST.anonymityNames.prefix.some((prefix) => name.startsWith(prefix) && name.length > prefix.length);
}
