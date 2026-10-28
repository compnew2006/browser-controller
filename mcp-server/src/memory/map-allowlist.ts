/**
 * The reviewed site-map rules as code. It mirrors
 * specs/004-site-navigation-map/contracts/map-allowlist.json (owner gate 3);
 * tests/map-allowlist.test.ts fails if the two drift. Changing either changes
 * what the map can store: review it like a permission change.
 */

export type MapArea = 'header' | 'nav' | 'sidebar' | 'footer' | 'main' | 'page' | 'dialog' | 'menu';
export type MapRole = 'link' | 'button' | 'tab' | 'menuitem';

export const MAP_ALLOWLIST = {
  version: 1,
  areas: {
    banner: 'header',
    navigation: 'nav',
    search: 'nav',
    complementary: 'sidebar',
    contentinfo: 'footer',
    main: 'main',
    dialog: 'dialog',
    alertdialog: 'dialog',
    menu: 'menu',
    menubar: 'nav',
    '(none)': 'page',
  } as Readonly<Record<string, MapArea>>,
  eligibleRoles: {
    header: ['link', 'button', 'tab', 'menuitem'],
    nav: ['link', 'button', 'tab', 'menuitem'],
    sidebar: ['link', 'button', 'tab', 'menuitem'],
    footer: ['link', 'button', 'tab', 'menuitem'],
    main: ['button', 'tab', 'menuitem'],
    page: ['button', 'tab', 'menuitem'],
    dialog: ['link', 'button', 'tab', 'menuitem'],
    menu: ['link', 'button', 'tab', 'menuitem'],
  } as Readonly<Record<MapArea, readonly MapRole[]>>,
  openedOnly: ['dialog', 'menu'] as readonly MapArea[],
  contentContainers: {
    roles: ['article', 'feed', 'table', 'grid', 'treegrid', 'row', 'rowgroup', 'cell', 'gridcell', 'listitem', 'log', 'comment', 'document'],
  },
  ignoredLineFields: ['value', 'context'],
  masking: {
    rules: [
      { placeholder: '{email}', pattern: '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}' },
      { placeholder: '{phone}', pattern: '\\+?\\p{Nd}(?:[\\s.()-]*\\p{Nd}){6,}' },
      { placeholder: '{id}', pattern: '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}' },
      { placeholder: '{id}', pattern: '(?=[0-9a-fA-F]*\\d)[0-9a-fA-F]{12,}' },
      { placeholder: '{id}', pattern: '(?=[A-Za-z0-9_-]*\\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{16,}' },
      { placeholder: '{n}', pattern: '\\p{Nd}{4,}' },
    ],
  },
  limits: {
    nameChars: 80,
    titleChars: 120,
    pathChars: 200,
    pagesPerOrigin: 500,
    controlsPerPage: 60,
    mapFileBytes: 1_048_576,
    mapFilesPerProfile: 1_000,
    mapTotalBytes: 67_108_864,
    excludedPrefixesPerOrigin: 32,
    reminderLines: 4,
    reminderChars: 600,
    lookupEntries: 20,
    lookupChars: 4_000,
    outlineLines: 10,
    outlineChars: 1_000,
    tabCacheEntries: 64,
    errorAttributionSeconds: 120,
  },
  arabicProclitics: {
    prefixes: ['وال', 'بال', 'فال', 'كال', 'لل', 'ال', 'و', 'ف', 'ب', 'ل', 'ك'],
  },
  dataChanging: {
    en: [
      'delete', 'remove', 'erase', 'clear all', 'discard', 'destroy',
      'pay', 'pay now', 'purchase', 'buy', 'buy now', 'checkout', 'check out', 'place order', 'order now', 'subscribe', 'upgrade', 'renew',
      'transfer', 'send', 'send money', 'withdraw', 'deposit', 'donate',
      'submit', 'confirm', 'approve', 'reject', 'decline', 'accept invitation',
      'sign out', 'log out', 'logout', 'signout',
      'unsubscribe', 'cancel', 'cancel subscription', 'cancel order', 'close account', 'deactivate', 'disable account', 'revoke', 'reset', 'archive', 'publish', 'post', 'share', 'block', 'report', 'unfollow', 'leave group',
    ],
    ar: [
      'حذف', 'احذف', 'امسح', 'مسح', 'ازاله', 'ازل', 'ازاله الكل', 'تفريغ',
      'دفع', 'ادفع', 'ادفع الان', 'شراء', 'اشتر', 'اشتري', 'اشتري الان', 'اطلب', 'اطلب الان', 'اتمام الطلب', 'اتمام الشراء', 'اتمام الدفع', 'اشتراك', 'اشترك', 'ترقيه', 'تجديد', 'جدد',
      'تحويل', 'حول الاموال', 'حول المبلغ', 'ارسال', 'ارسل', 'سحب', 'اسحب', 'ايداع', 'تبرع',
      'تاكيد', 'اكد', 'موافقه', 'وافق', 'رفض', 'ارفض', 'قبول الدعوه',
      'تسجيل الخروج', 'تسجيل خروج', 'خروج', 'اخرج',
      'الغاء الاشتراك', 'الغاء', 'الغاء الطلب', 'اغلاق الحساب', 'تعطيل الحساب', 'عطل', 'ابطال', 'اعاده تعيين', 'اعاده الضبط', 'ارشفه', 'نشر', 'انشر', 'مشاركه', 'شارك', 'حظر', 'احظر', 'ابلاغ', 'بلغ', 'الغاء المتابعه', 'مغادره المجموعه',
    ],
  },
  // False friends only (R-15). A harmless control that really uses a listed verb, such as "Remove filter", stays
  // matched: the spec accepts that over-match, which costs one reminder line (Edge Cases; RV-18).
  notDataChanging: {
    en: [],
    ar: ['حول', 'حول الموقع', 'حولنا'],
  },
} as const;

export const MAP_LIMITS = MAP_ALLOWLIST.limits;
