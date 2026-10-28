import { describe, expect, it } from 'vitest';
import { emptyMapRecord, type MapRecord } from '../mcp-server/src/memory/map-record.js';
import {
  applyMapOp,
  controlStatus,
  enforceMapLimits,
  pageStatus,
  removePathPrefix,
  viaChain,
  type MapClickOp,
  type MapReadOp,
  type ObservedControl,
} from '../mcp-server/src/memory/map-reconcile.js';
import { controlKey } from '../mcp-server/src/memory/map-text.js';

const O = 'https://a.example';
const at = (minute: number): string => new Date(Date.UTC(2026, 9, 28, 10, minute)).toISOString();
const control = (area: ObservedControl['area'], role: ObservedControl['role'], name: string, parent: string | null = null): ObservedControl => ({ key: controlKey(area, role, name), area, role, name, nth: null, parent });

const HELP = control('header', 'link', 'Help');
const ACCOUNT = control('header', 'button', 'Account');
const SIGN_OUT = control('header', 'button', 'Sign out');

let seq = 0;
function read(overrides: Partial<MapReadOp> = {}): MapReadOp {
  return {
    type: 'read',
    opId: `r${(seq += 1)}`,
    profile: 'p',
    origin: O,
    at: at(seq),
    path: '/',
    addressable: true,
    title: 'Home',
    lang: 'en',
    dir: 'ltr',
    context: 'public',
    complete: true,
    readChars: 100,
    controls: [HELP, ACCOUNT],
    reason: 'root',
    ...overrides,
  };
}

function click(overrides: Partial<MapClickOp> = {}): MapClickOp {
  return {
    type: 'click',
    opId: `c${(seq += 1)}`,
    profile: 'p',
    origin: O,
    at: at(seq),
    fromPath: '/',
    control: HELP,
    lang: 'en',
    sourceContext: 'public',
    navigated: true,
    destination: { path: '/help' },
    destinationAddressable: true,
    ...overrides,
  };
}

const fresh = (): MapRecord => emptyMapRecord('p', O, at(0));
const page = (record: MapRecord, path: string) => record.pages.find((entry) => entry.path === path);
const ctl = (record: MapRecord, path: string, key: string) => page(record, path)?.controls.find((entry) => entry.key === key);

describe('applyMapOp: reads (AC-01, AC-10, R-11)', () => {
  it('creates structural pages only; a refresh read of an unknown page creates nothing (AC-27)', () => {
    const record = fresh();
    expect(applyMapOp(record, read({ path: '/news/a', reason: 'refresh' })).changed).toBe(false);
    applyMapOp(record, read());
    expect(record.pages.map((entry) => entry.path)).toEqual(['/']);
    expect(page(record, '/')).toMatchObject({ title: 'Home', lang: 'en', reason: 'root', contexts: { public: { lastSeenAt: expect.any(String) } } });
  });

  it('re-observing refreshes without duplicates', () => {
    const record = fresh();
    applyMapOp(record, read());
    applyMapOp(record, read({ title: 'Home v2' }));
    expect(record.pages).toHaveLength(1);
    expect(page(record, '/')?.controls).toHaveLength(2);
    expect(page(record, '/')?.title).toBe('Home v2');
  });

  it('keeps no title for a path with a placeholder (FR-003)', () => {
    const record = fresh();
    applyMapOp(record, read({ path: '/u/{n}', addressable: false, title: 'Order 1', reason: 'destination' }));
    expect(applyMapOp(record, read({ path: '/moved', reason: 'landing', landingOf: '/nowhere' })).changed).toBe(false);
    expect(page(record, '/u/{n}')).toMatchObject({ title: null, addressable: false });
  });
});

describe('not-seen marking (AC-18, AC-28, CHK028)', () => {
  it('a complete read in the same context and language marks a missing control not seen', () => {
    const record = fresh();
    applyMapOp(record, read());
    applyMapOp(record, read({ controls: [HELP] }));
    expect(ctl(record, '/', ACCOUNT.key)?.seen.public?.atLastComplete).toBe(false);
    expect(controlStatus(ctl(record, '/', ACCOUNT.key)!)).toBe('not_seen');
    applyMapOp(record, read());
    expect(controlStatus(ctl(record, '/', ACCOUNT.key)!)).toBe('working');
  });

  it('a truncated read, another context, another language or the unknown context does not mark', () => {
    const record = fresh();
    applyMapOp(record, read());
    applyMapOp(record, read({ controls: [HELP], complete: false }));
    applyMapOp(record, read({ controls: [HELP], context: 'not_public' }));
    applyMapOp(record, read({ controls: [HELP], context: 'unknown' }));
    applyMapOp(record, read({ controls: [HELP], lang: 'ar' }));
    expect(ctl(record, '/', ACCOUNT.key)?.seen.public?.atLastComplete).toBe(true);
  });

  it('alternating public and not-public reads never mark the account menu (AC-28)', () => {
    const record = fresh();
    for (let round = 0; round < 3; round += 1) {
      applyMapOp(record, read({ context: 'public', controls: [HELP] }));
      applyMapOp(record, read({ context: 'not_public', controls: [HELP, ACCOUNT] }));
    }
    expect(ctl(record, '/', ACCOUNT.key)?.seen.public).toBeUndefined();
    expect(controlStatus(ctl(record, '/', ACCOUNT.key)!)).toBe('working');
  });

  it('never marks menu items that are only visible while the menu is open', () => {
    const record = fresh();
    const profile = control('menu', 'menuitem', 'Profile', ACCOUNT.key);
    applyMapOp(record, read({ controls: [HELP, ACCOUNT, profile] }));
    applyMapOp(record, read());
    expect(ctl(record, '/', profile.key)?.seen.public?.atLastComplete).toBe(true);
    expect(ctl(record, '/', profile.key)?.parent).toBe(ACCOUNT.key);
  });
});

describe('clicks and destinations (AC-07, AC-08, AC-20, AC-31, R-08)', () => {
  it('learns a destination without deciding a use, then decides worked or mismatch', () => {
    const record = fresh();
    applyMapOp(record, read());
    expect(applyMapOp(record, click()).use).toBeNull();
    expect(ctl(record, '/', HELP.key)?.destinations.public?.path).toBe('/help');
    expect(page(record, '/help')).toMatchObject({ reason: 'destination', via: { path: '/', control: HELP.key }, title: null });
    expect(applyMapOp(record, click()).use).toBe('worked');
    expect(ctl(record, '/', HELP.key)?.useCount).toBe(1);
    const mismatch = applyMapOp(record, click({ destination: { path: '/support' } }));
    expect(mismatch.use).toBe('failed');
    expect(ctl(record, '/', HELP.key)?.lastUse).toMatchObject({ result: 'failed', code: 'MISMATCH' });
    expect(ctl(record, '/', HELP.key)?.destinations.public?.path).toBe('/support');
    expect(controlStatus(ctl(record, '/', HELP.key)!)).toBe('failed');
  });

  it('stores destinations per read context (a sign-in reached while not public does not replace it)', () => {
    const record = fresh();
    applyMapOp(record, read());
    applyMapOp(record, click({ destination: { path: '/account' } }));
    applyMapOp(record, click({ sourceContext: 'not_public', destination: { path: '/login' } }));
    expect(ctl(record, '/', HELP.key)?.destinations).toMatchObject({ public: { path: '/account' }, not_public: { path: '/login' } });
  });

  it('another origin stores the origin only', () => {
    const record = fresh();
    applyMapOp(record, read());
    applyMapOp(record, click({ destination: { origin: 'https://help.example' } }));
    expect(ctl(record, '/', HELP.key)?.destinations.public).toEqual({ origin: 'https://help.example', at: expect.any(String) });
    expect(record.pages).toHaveLength(1);
  });

  it('records opens: menu through the next read, then a non-navigating click works', () => {
    const record = fresh();
    applyMapOp(record, read());
    expect(applyMapOp(record, click({ control: ACCOUNT, navigated: false, destination: null })).use).toBeNull();
    applyMapOp(record, read({ openedBy: { controlKey: ACCOUNT.key, opens: 'menu', context: 'public' } }));
    expect(ctl(record, '/', ACCOUNT.key)?.destinations.public?.opens).toBe('menu');
    expect(applyMapOp(record, click({ control: ACCOUNT, navigated: false, destination: null })).use).toBe('worked');
  });

  it('a failed locator records the code and never changes seen (FR-010)', () => {
    const record = fresh();
    applyMapOp(record, read());
    const result = applyMapOp(record, { type: 'clickFailed', opId: 'f1', profile: 'p', origin: O, at: at(50), path: '/', controlKey: HELP.key, code: 'NOT_FOUND' });
    expect(result.use).toBe('failed');
    expect(ctl(record, '/', HELP.key)).toMatchObject({ lastUse: { result: 'failed', code: 'NOT_FOUND' }, seen: { public: { atLastComplete: true } } });
  });

  it('a click on an unknown page records nothing', () => {
    expect(applyMapOp(fresh(), click()).changed).toBe(false);
  });
});

describe('direct opens (AC-19, AC-29, R-08)', () => {
  const open = (result: 'same' | 'elsewhere' | 'sign_in' | 'not_found' | 'error', extra = {}, requestedPath = '/account') => ({ type: 'open' as const, opId: `o${(seq += 1)}`, profile: 'p', origin: O, at: at(seq), requestedPath, result, ...extra });

  it('counts a worked open, ranks failures lower, keeps sign-in and errors neutral', () => {
    const record = fresh();
    applyMapOp(record, read({ path: '/account' }));
    const seenAt = page(record, '/account')?.lastSeenAt;
    expect(applyMapOp(record, open('same')).use).toBe('worked');
    expect(page(record, '/account')?.useCount).toBe(1);
    applyMapOp(record, open('sign_in', { landingPath: '/login' }));
    expect(pageStatus(page(record, '/account')!)).toBe('working');
    applyMapOp(record, open('error', { statusClass: '5xx' }));
    expect(pageStatus(page(record, '/account')!)).toBe('working');
    applyMapOp(record, open('not_found'));
    expect(pageStatus(page(record, '/account')!)).toBe('failed');
    applyMapOp(record, open('elsewhere', { landingPath: '/moved' }));
    expect(page(record, '/account')?.lastOpen).toMatchObject({ result: 'elsewhere', path: '/moved' });
    expect(page(record, '/account')?.lastSeenAt).toBe(seenAt);
  });

  it('records an open of the root but does not count it as a hint use (RV-16)', () => {
    const record = fresh();
    applyMapOp(record, read());
    expect(applyMapOp(record, open('same', {}, '/'))).toMatchObject({ changed: true, use: null });
    expect(applyMapOp(record, open('not_found', {}, '/')).use).toBeNull();
    expect(page(record, '/')).toMatchObject({ useCount: 0, lastOpen: { result: 'not_found' } });
    expect(page(record, '/')?.lastUse).toBeFalsy();
  });
});

describe('limits and removal (AC-25, AC-34, R-18)', () => {
  it('evicts the least recent pages and controls first', () => {
    const record = fresh();
    for (let index = 0; index < 505; index += 1) {
      record.pages.push({ ...structuredClone(emptyPage()), path: `/p${index}`, lastSeenAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString() });
    }
    expect(enforceMapLimits(record)).toBe(5);
    expect(record.pages.some((entry) => entry.path === '/p0')).toBe(false);
    expect(record.pages.some((entry) => entry.path === '/p504')).toBe(true);
  });

  it('evicts by bytes until the file fits', () => {
    const record = fresh();
    for (let index = 0; index < 20; index += 1) record.pages.push({ ...emptyPage(), path: `/p${index}`, lastSeenAt: at(index) });
    const evicted = enforceMapLimits(record, 2_000);
    expect(evicted).toBeGreaterThan(0);
    expect(Buffer.byteLength(`${JSON.stringify(record)}\n`)).toBeLessThanOrEqual(2_000);
  });

  it('caps controls per page', () => {
    const record = fresh();
    applyMapOp(record, read({ controls: Array.from({ length: 70 }, (_, index) => control('nav', 'link', `Item ${String.fromCharCode(65 + (index % 26))}${index}`)) }));
    enforceMapLimits(record);
    expect(page(record, '/')?.controls).toHaveLength(60);
  });

  it('a path exclusion removes pages, via links and destinations under it', () => {
    const record = fresh();
    applyMapOp(record, read());
    applyMapOp(record, click({ destination: { path: '/health/records' } }));
    expect(removePathPrefix(record, '/health', 'exclude')).toBe(true);
    expect(page(record, '/health/records')).toBeUndefined();
    expect(ctl(record, '/', HELP.key)?.destinations.public).toEqual({ excluded: true, at: expect.any(String) });
    expect(removePathPrefix(record, '/healthy', 'delete')).toBe(false);
  });

  it('walks the via chain without looping', () => {
    const record = fresh();
    applyMapOp(record, read());
    applyMapOp(record, click({ destination: { path: '/a' } }));
    applyMapOp(record, read({ path: '/a', controls: [HELP], reason: 'refresh' }));
    applyMapOp(record, click({ fromPath: '/a', destination: { path: '/b' } }));
    applyMapOp(record, read({ path: '/b', controls: [HELP], reason: 'refresh' }));
    applyMapOp(record, click({ fromPath: '/b', destination: { path: '/' } }));
    expect(viaChain(record, '/b').map((entry) => entry.path)).toEqual(['/a', '/']);
  });
});

function emptyPage() {
  return { path: '/', title: null, lang: null, dir: null, addressable: true, reason: 'root' as const, via: null, lastOpen: null, useCount: 0, lastUse: null, readChars: 0, contexts: {}, firstSeenAt: at(0), lastSeenAt: at(0), controls: [] };
}

void SIGN_OUT;
