import { describe, expect, it } from 'vitest';
import {
  boundName,
  boundTitle,
  canonicalPrefix,
  controlKey,
  isDataChanging,
  looksUnmasked,
  maskPath,
  maskText,
  matchesWords,
  normalizeForMatch,
  pathUnderPrefix,
  queryWords,
} from '../mcp-server/src/memory/map-text.js';

describe('normalizeForMatch (R-14)', () => {
  it('lowercases, removes Arabic diacritics and tatweel, and unifies letter forms', () => {
    expect(normalizeForMatch('  Sign   IN… ')).toBe('sign in');
    expect(normalizeForMatch('الإعدادَاتُ')).toBe(normalizeForMatch('الاعدادات'));
    expect(normalizeForMatch('مـكـتـبـة')).toBe('مكتبه');
    expect(normalizeForMatch('أدوات ى ؤ ئ')).toBe('ادوات ي و ي');
  });
});

describe('maskText and maskPath (R-12, AC-15)', () => {
  it('masks e-mail, phone, ids and long digit runs in that order', () => {
    expect(maskText('mail a.b@mail.example now').text).toBe('mail {email} now');
    expect(maskText('call +20 100 555 0199').text).toBe('call {phone}');
    // Contract order: a long digit tail is a phone number before the id rules run; nothing of the value survives.
    expect(maskText('id 123e4567-e89b-12d3-a456-426614174000').text).not.toMatch(/\d/u);
    expect(maskText('id 9f8e7d6c5b4a').text).toBe('id {id}');
    expect(maskText('tok_9f8e7d6c5b4a39281706').text).not.toMatch(/\d/u);
    expect(maskText('ref Zx_q9w8k7r6t5y4u').text).toBe('ref {id}');
    expect(maskText('order 12345').text).toBe('order {n}');
    expect(maskText('order 12345678').text).toBe('order {phone}');
    expect(maskText('Help').masked).toBe(false);
  });

  it('keeps ordinary slugs (no letter-only rule)', () => {
    expect(maskPath('/terms-and-conditions-of-use')).toEqual({ path: '/terms-and-conditions-of-use', masked: false });
  });

  it('masks a year: the path is no longer addressable (CHK031)', () => {
    const masked = maskPath('/news/2026/launch');
    expect(masked).toEqual({ path: '/news/{n}/launch', masked: true });
  });

  it('masks percent-encoded data through the decoded form', () => {
    expect(maskPath('/u/a%40b.example')?.path).toBe('/u/{email}');
  });

  it('masks Arabic-Indic, Persian and full-width digits like ASCII ones (RV-02)', () => {
    expect(maskText('طلب رقم ١٢٣٤٥٦٧٨').text).toBe('طلب رقم {phone}');
    expect(maskText('اتصل ٠١٠٠١٢٣٤٥٦٧').text).toBe('اتصل {phone}');
    expect(maskText('سال ۱۴۰۳').text).toBe('سال {n}');
    expect(maskText('Order １２３４').text).toBe('Order {n}');
    expect(maskPath(`/orders/${encodeURIComponent('١٢٣٤')}`)).toEqual({ path: '/orders/{n}', masked: true });
    expect(boundName('اتصل ٠١٠٠١٢٣٤٥٦٧')).toBeNull();
  });

  it('refuses a path longer than the bound', () => {
    expect(maskPath(`/${'a'.repeat(250)}`)).toBeNull();
  });

  it('flags text that still holds something masking would replace', () => {
    expect(looksUnmasked('call 0123456')).toBe(true);
    expect(looksUnmasked('/news/{n}/launch')).toBe(false);
  });
});

describe('bounds (R-12)', () => {
  it('skips names that are empty, too long or held data', () => {
    expect(boundName('  Help  ')).toBe('Help');
    expect(boundName('x'.repeat(81))).toBeNull();
    // The snapshot cuts names at 80 characters, so one that long may be cut and its locator would never match (RV-13).
    expect(boundName('x'.repeat(80))).toBeNull();
    expect(boundName('x'.repeat(79))).toBe('x'.repeat(79));
    expect(boundName('Order 12345678')).toBeNull();
    expect(boundName('')).toBeNull();
  });

  it('masks and truncates titles with an ellipsis', () => {
    expect(boundTitle('Inbox (order 1234)')).toBe('Inbox (order {n})');
    const long = boundTitle('t'.repeat(200));
    expect(long).toHaveLength(120);
    expect(long?.endsWith('…')).toBe(true);
    expect(boundTitle(null)).toBeNull();
  });
});

describe('isDataChanging (R-15, AC-32)', () => {
  it('matches English phrases as consecutive words', () => {
    expect(isDataChanging('Sign out')).toBe(true);
    expect(isDataChanging('Place order')).toBe(true);
    expect(isDataChanging('Delete')).toBe(true);
    expect(isDataChanging('Help')).toBe(false);
    expect(isDataChanging('Order history')).toBe(false);
  });

  it('honours the reviewed false friends', () => {
    expect(isDataChanging('Clear filters')).toBe(false);
    expect(isDataChanging('حول')).toBe(false);
    expect(isDataChanging('حول الموقع')).toBe(false);
  });

  it('keeps a harmless control that uses a listed verb matched, as the spec accepts (RV-18)', () => {
    expect(isDataChanging('Remove filter')).toBe(true);
    expect(isDataChanging('Cancel search')).toBe(true);
    expect(isDataChanging('إزالة الفلتر')).toBe(true);
    expect(isDataChanging('مسح البحث')).toBe(true);
  });

  it('matches Arabic forms with one proclitic removed', () => {
    expect(isDataChanging('تسجيل الخروج')).toBe(true);
    expect(isDataChanging('الغاء')).toBe(true);
    expect(isDataChanging('والغاء')).toBe(true);
    expect(isDataChanging('إلغاء الاشتراك')).toBe(true);
    expect(isDataChanging('الملف الشخصي')).toBe(false);
  });
});

describe('lookup words', () => {
  it('splits, normalizes and caps at 8 words', () => {
    expect(queryWords('Account  SETTINGS')).toEqual(['account', 'settings']);
    expect(queryWords('a b c d e f g h i j')).toHaveLength(8);
    expect(matchesWords('/account/Settings "Your settings"', ['settings'])).toBe(true);
    expect(matchesWords('الإعدادات', queryWords('الاعدادات'))).toBe(true);
    expect(matchesWords('x', [])).toBe(true);
  });
});

describe('path prefixes (R-13, AC-34)', () => {
  it('canonicalizes: starts with /, not /, no query, fragment or trailing slash', () => {
    expect(canonicalPrefix('/health/')).toBe('/health');
    expect(canonicalPrefix('/')).toBeNull();
    expect(canonicalPrefix('health')).toBeNull();
    expect(canonicalPrefix('/a?b')).toBeNull();
    expect(canonicalPrefix('/a#b')).toBeNull();
    expect(canonicalPrefix(5)).toBeNull();
  });

  it('matches at segment boundaries, ignoring case', () => {
    expect(pathUnderPrefix('/health', '/health')).toBe(true);
    expect(pathUnderPrefix('/Health/x', '/health')).toBe(true);
    expect(pathUnderPrefix('/healthy', '/health')).toBe(false);
  });

  it('compares non-ASCII prefixes and paths decoded, whichever form each was given in (RV-04)', () => {
    const encoded = `/${encodeURIComponent('صحة')}`;
    expect(canonicalPrefix(`${encoded}/`)).toBe('/صحة');
    expect(canonicalPrefix('/%3Fx')).toBeNull();
    expect(pathUnderPrefix(`${encoded}/${encodeURIComponent('تحاليل')}`, '/صحة')).toBe(true);
    expect(pathUnderPrefix('/صحة/x', encoded)).toBe(true);
    expect(pathUnderPrefix(`/${encodeURIComponent('صحتي')}`, '/صحة')).toBe(false);
    expect(pathUnderPrefix('/bad%E0%A4%A', '/bad%E0%A4%A')).toBe(true);
  });

  it('builds a control key from area, role and the normalized name', () => {
    expect(controlKey('header', 'link', 'Help')).toBe('header\nlink\nhelp');
  });
});
