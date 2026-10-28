import { describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import { emptyMapRecord, mapFileName, validateMapRecord, type MapRecord, type PageEntry } from '../mcp-server/src/memory/map-record.js';
import { MemoryStoreError } from '../mcp-server/src/memory/site-record.js';

const T = '2026-10-28T10:00:00.000Z';
const sha = (value: string): string => crypto.createHash('sha256').update(value).digest('hex');

function page(overrides: Partial<PageEntry> = {}): PageEntry {
  return {
    path: '/',
    title: 'Home',
    lang: 'en',
    dir: 'ltr',
    addressable: true,
    reason: 'root',
    via: null,
    lastOpen: null,
    useCount: 0,
    lastUse: null,
    readChars: 10,
    contexts: { public: { lastSeenAt: T } },
    firstSeenAt: T,
    lastSeenAt: T,
    controls: [
      {
        key: 'header\nlink\nhelp',
        area: 'header',
        role: 'link',
        name: 'Help',
        nth: null,
        parent: null,
        lang: 'en',
        dataChanging: false,
        destinations: { public: { path: '/help', at: T } },
        seen: { public: { lastSeenAt: T, atLastComplete: true } },
        useCount: 1,
        lastUse: { result: 'worked', at: T },
        firstSeenAt: T,
        lastSeenAt: T,
      },
    ],
    ...overrides,
  };
}

function record(pages: PageEntry[] = [page()]): MapRecord {
  return { ...emptyMapRecord('browser-a', 'https://a.example', T), pages };
}

const code = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (error) {
    return error instanceof MemoryStoreError ? error.code : 'other';
  }
  return undefined;
};

describe('map record (T006)', () => {
  it('hides profile and origin in the file name', () => {
    expect(mapFileName('browser-a', 'https://a.example')).toBe(`${sha('browser-a')}/${sha('browser-a\nhttps://a.example')}.json`);
  });

  it('accepts a valid record and returns a copy', () => {
    const valid = record();
    const copy = validateMapRecord(valid, 'read');
    expect(copy).toEqual(valid);
    expect(copy).not.toBe(valid);
  });

  it('is MEMORY_CORRUPT on read and INVALID_ARGUMENT on write', () => {
    const bad = { ...record(), extra: 1 };
    expect(code(() => validateMapRecord(bad, 'read'))).toBe('MEMORY_CORRUPT');
    expect(code(() => validateMapRecord(bad, 'write'))).toBe('INVALID_ARGUMENT');
  });

  it.each([
    ['unknown page field', { secret: 'x' }],
    ['unmasked title', { title: 'Order 12345678' }],
    ['unmasked path', { path: '/u/a@b.example' }],
    ['relative path', { path: 'x' }],
    ['bad reason', { reason: 'content' }],
    ['bad context', { contexts: { signed_in: { lastSeenAt: T } } }],
    ['bad time', { lastSeenAt: 'yesterday' }],
  ])('refuses %s', (_label, overrides) => {
    expect(code(() => validateMapRecord(record([page(overrides as Partial<PageEntry>)]), 'read'))).toBe('MEMORY_CORRUPT');
  });

  it('refuses duplicate paths and duplicate control keys', () => {
    expect(code(() => validateMapRecord(record([page(), page()]), 'read'))).toBe('MEMORY_CORRUPT');
    const one = page();
    expect(code(() => validateMapRecord(record([{ ...one, controls: [one.controls[0], one.controls[0]] }]), 'read'))).toBe('MEMORY_CORRUPT');
  });

  it('refuses a destination with two targets or an unmasked control name', () => {
    const one = page();
    const twoTargets = { ...one, controls: [{ ...one.controls[0], destinations: { public: { path: '/a', origin: 'https://b.example', at: T } } }] };
    expect(code(() => validateMapRecord(record([twoTargets as PageEntry]), 'read'))).toBe('MEMORY_CORRUPT');
    const unmasked = { ...one, controls: [{ ...one.controls[0], name: 'Call 0123456789' }] };
    expect(code(() => validateMapRecord(record([unmasked]), 'read'))).toBe('MEMORY_CORRUPT');
  });

  it('refuses more than 500 pages', () => {
    const many = Array.from({ length: 501 }, (_, index) => page({ path: `/p${String.fromCharCode(97 + (index % 26))}/${'x'.repeat(index % 7)}${index.toString(36)}`, controls: [] }));
    expect(code(() => validateMapRecord(record(many), 'read'))).toBe('MEMORY_CORRUPT');
  });
});
