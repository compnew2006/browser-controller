/**
 * The reviewed fact allowlist as code. It mirrors
 * specs/003-website-agent-memory/contracts/fact-allowlist.json (owner gate 3,
 * approved 2026-10-27, widened at the owner's request 2026-10-28 as v2, widened
 * again on 2026-10-31 as v3 for the form shape facts of specs/007-form-shape-facts);
 * tests/memory-allowlist.test.ts fails if the two drift.
 * A stored string must equal an entry here after normalizeText(); anything
 * else is discarded, never truncated or rewritten.
 */
import { ERROR_CODES } from '../core/error-codes.js';

export const ALLOWLIST = {
  version: 3,
  factKinds: {
    'site.language': { source: 'siteContext.lang and siteContext.dir', values: 'lang: primaryLanguageTags; dir: ltr | rtl | null' },
    'ui.search': { source: 'snapshot line \'<role> "<name>"\' with role in searchRoles and name in phrases.search, or name starting with a searchPrefixes prefix (then the stored name is that prefix\'s canonical phrase, never the page\'s name)' },
    'ui.login': { source: 'siteContext.passwordField === true', values: 'path: page path if every segment is in pathSegments, else null' },
    'ui.control': { source: 'snapshot line \'<role> "<name>"\' with role in controlRoles and name in any phrases group except search' },
    'ui.form.shape': {
      source: 'siteContext.formShape for the form inside the main landmark; the commit mode is added by the daemon from an observed write on that path and applied at the next observed read of that path',
      values: 'shape: fields, required, types (each from fieldTypes, each at most once), hidden; commit: from commitModes',
      identity: "ui.form.shape:<path> - the path is kept only when every segment is in pathSegments; the root path '/' is kept as well, because it names no topic",
    },
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
  /** The reviewed field types (007). A type outside this list is counted as `other` and never guessed. */
  fieldTypes: [
    'text', 'password', 'email', 'search', 'tel', 'url', 'number', 'date',
    'checkbox', 'radio', 'select', 'textarea', 'file', 'other',
  ],
  /** How a form commits, as observed from an action. There is no `none`: nothing observed proves a form never commits. */
  commitModes: ['unknown', 'enter', 'button'],
  /** The action failures that raise the hidden-control counter (007). */
  failureCodes: [ERROR_CODES.ELEMENT_HIDDEN, ERROR_CODES.ELEMENT_COVERED],
  formShapeLimits: {
    shapeFactsPerSite: 8,
    typesPerShape: 8,
    valueBytes: 200,
    occurrenceCountMax: 1_000_000,
  },
} as const;

/**
 * Which option of OD-1 is in force for the shape fact (007). `option1` keeps the shape behind 003's anonymity
 * gate, so only an anonymous page's form is measured. `option2` stores the shape for every in-scope site, because
 * the shape holds counts and vocabulary words only and no content from the page. The owner decides; the default
 * here is the assumption recorded in plan.md, and the daemon passes its choice to the memory service.
 */
export type ShapeGate = 'option1' | 'option2';

export const DEFAULT_SHAPE_GATE: ShapeGate = 'option1';

export type SearchRole = (typeof ALLOWLIST.searchRoles)[number];
export type ControlRole = (typeof ALLOWLIST.controlRoles)[number];
export type FactKind = keyof typeof ALLOWLIST.factKinds;
export type FieldType = (typeof ALLOWLIST.fieldTypes)[number];
export type CommitMode = (typeof ALLOWLIST.commitModes)[number];

/** The measured shape of one form: counts and closed-vocabulary words, never a string from the page. */
export interface FormShape {
  /** How many fillable controls the form has. */
  fields: number;
  /** How many of them are required. */
  required: number;
  /** The distinct field types, each at most once. */
  types: FieldType[];
  /** Whether at least one field is visually hidden. */
  hidden: boolean;
}

export type FactValue =
  | { lang: string; dir: 'ltr' | 'rtl' | null }
  | { role: SearchRole; name: string }
  | { path: string | null }
  | { role: ControlRole; name: string }
  | { shape: FormShape; commit: CommitMode };

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

/**
 * The path a shape fact may carry. Every segment must be on the reviewed list, as for `ui.login`; the root path
 * is allowed as well, because it names no topic (007 D-06). Anything else yields null, and no fact is stored.
 */
export function shapePath(path: string): string | null {
  if (typeof path !== 'string' || !path.startsWith('/') || /[?#%\\:]/u.test(path)) return null;
  const trimmed = path.replace(/\/$/u, '');
  if (trimmed === '') return '/';
  return matchPath(path);
}

/**
 * The distinct field types, bounded: each type at most once, at most `typesPerShape` of them, and the types
 * beyond that merged into `other`. A type outside the reviewed list is counted as `other` and never guessed
 * (FR-001, D-02): the extension already maps an unknown type to `other`, and this is the same rule again at the
 * store's edge, so a malformed or hostile block cannot put a word of its own into the record.
 */
function boundedTypes(types: readonly unknown[]): FieldType[] {
  const counts = new Map<string, number>();
  for (const raw of types) {
    if (typeof raw !== 'string') continue;
    const type = raw.trim().toLowerCase();
    const reviewed = (ALLOWLIST.fieldTypes as readonly string[]).includes(type) ? type : 'other';
    counts.set(reviewed, (counts.get(reviewed) ?? 0) + 1);
  }
  const limit = ALLOWLIST.formShapeLimits.typesPerShape;
  const ordered = [...counts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  if (ordered.length <= limit) return ordered.map(([type]) => type as FieldType);
  const head = ordered.slice(0, limit - 1).map(([type]) => type as FieldType);
  return head.includes('other') ? head : [...head, 'other'];
}

/**
 * The shape fact for one measured form (007). It holds counts and reviewed words only: no label, no name, no
 * value, no placeholder, no id, no selector. The commit mode is the one observed from an action, never guessed.
 */
export function shapeFact(shape: unknown, path: string, commit: CommitMode = 'unknown'): CandidateFact | null {
  if (typeof shape !== 'object' || shape === null) return null;
  const raw = shape as Record<string, unknown>;
  const stored = shapePath(path);
  if (!stored) return null;
  const fields = raw.fields;
  const required = raw.required;
  if (typeof fields !== 'number' || !Number.isInteger(fields) || fields < 0 || fields > 64) return null;
  if (typeof required !== 'number' || !Number.isInteger(required) || required < 0 || required > fields) return null;
  if (!Array.isArray(raw.types)) return null;
  if (raw.hidden !== true && raw.hidden !== false) return null;
  if (!(ALLOWLIST.commitModes as readonly string[]).includes(commit)) return null;
  const types = boundedTypes(raw.types);
  const value = {
    shape: { fields, required, types, hidden: raw.hidden },
    commit,
  };
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > ALLOWLIST.formShapeLimits.valueBytes) return null;
  return { factId: `ui.form.shape:${stored}`, kind: 'ui.form.shape', value };
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
