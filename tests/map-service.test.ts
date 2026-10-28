import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MemoryService, type MemoryCall, type MemoryConnection } from '../mcp-server/src/memory/service.js';
import { defaultPolicy, enablePolicy, excludeOrigin, writePolicy } from '../mcp-server/src/memory/policy.js';
import { defaultMapPolicy, enableMapProfile, writeMapPolicy } from '../mcp-server/src/memory/map-policy.js';
import { JsonMapStore } from '../mcp-server/src/memory/map-store.js';
import { MemoryStoreError } from '../mcp-server/src/memory/site-record.js';
import type { MapRecord } from '../mcp-server/src/memory/map-record.js';
import {
  ORIGIN,
  articleText,
  arabicText,
  clickOutcome,
  homeLines,
  homeText,
  mkMapDir,
  navigateOutcome,
  navigateWithSnapshot,
  profileText,
  snapshotOutcome,
  snapshotText,
  type OutcomeShape,
} from './helpers/map-fixtures.js';

const START = Date.parse('2026-10-28T09:00:00.000Z');
const PROFILE = 'profile-a';

let dir: ReturnType<typeof mkMapDir>;
let clock: number;
let conn: MemoryConnection & { throws?: boolean };
let eligibility: 'clear' | 'protected' | 'unknown';
let service: MemoryService;

function makeService(mapStore?: JsonMapStore): MemoryService {
  return new MemoryService({
    memoryDir: dir.memoryDir,
    vault: { memoryEligibility: () => eligibility },
    connection: () => {
      if (conn.throws) throw new Error('NOT_CONNECTED');
      return { ...conn };
    },
    now: () => clock,
    ...(mapStore ? { mapStore } : {}),
  });
}

const iso = () => new Date(clock).toISOString();

async function enableMemory(): Promise<void> {
  await writePolicy(dir.memoryDir, enablePolicy(defaultPolicy(), iso()));
}

async function enableMap(profiles: string[] = [PROFILE]): Promise<void> {
  let policy = defaultMapPolicy();
  for (const profile of profiles) policy = enableMapProfile(policy, profile, iso());
  await writeMapPolicy(dir.memoryDir, policy);
}

async function enableAll(): Promise<void> {
  await enableMemory();
  await enableMap();
  clock += 1_000;
}

/** One daemon call, in the daemon's order: beginCall, the browser outcome, withReminder on success, afterCall. */
async function run(shape: OutcomeShape): Promise<{ call: MemoryCall; result: unknown }> {
  clock += 1_000;
  const call = service.beginCall(shape.sessionId, shape.tool);
  const observation = call.observe && shape.observation ? { ...shape.observation, digestBefore: 'a', digestAfter: 'a' } : undefined;
  const outcome = { sessionId: shape.sessionId, tool: shape.tool, params: shape.params, daemonCallId: shape.daemonCallId, result: shape.result, observation, ...(shape.error !== undefined ? { error: shape.error } : {}) };
  const result = shape.error === undefined ? await service.withReminder(call, outcome) : shape.result;
  service.afterCall(call, outcome);
  await service.flush();
  return { call, result };
}

const map = (profile = PROFILE, origin = ORIGIN): Promise<MapRecord | null> => service.map.store.getMap(profile, origin, { afterWrites: true });
const page = (record: MapRecord | null, path: string) => record?.pages.find((entry) => entry.path === path);
const lookup = (params: Record<string, unknown>, context = { siteContext: null as unknown, connectionIdBefore: null as string | null }) => service.handleTool('browser_site_map', params, 's1', context);
const tabContext = (url: string) => ({ siteContext: { url, incognito: false, topLevel: true, stable: true, anonymous: true, lang: 'en', dir: 'ltr', passwordField: false }, connectionIdBefore: 'conn-1' });

/** Root read, then Help clicked by ref and read: the minimal learned site. */
async function learnHome(): Promise<void> {
  await run(navigateOutcome({ url: `${ORIGIN}/`, snapshot: true, text: navigateWithSnapshot(homeText()) }));
  await run(clickOutcome({ target: 'e3', fromUrl: `${ORIGIN}/`, url: `${ORIGIN}/help` }));
  await run(snapshotOutcome({ url: `${ORIGIN}/help`, text: snapshotText('Help center', `${ORIGIN}/help`, []) }));
}

beforeEach(() => {
  dir = mkMapDir('bc-mapsvc-');
  clock = START;
  conn = { browserId: PROFILE, browserLabel: 'Work', connectionId: 'conn-1', ambiguous: false, supportsSiteContext: true, supportsSiteMap: true };
  eligibility = 'clear';
  service = makeService();
});

afterEach(async () => {
  await service.flush();
  dir.cleanup();
});

describe('MapService through MemoryService — US1 (T021)', () => {
  it('records the root, a click destination and its landing with path, title, lang, context and last seen (AC-01)', async () => {
    await enableAll();
    await learnHome();
    const record = await map();
    const root = page(record, '/');
    expect(root).toMatchObject({ title: 'Shop home', addressable: true });
    expect(root?.controls.map((control) => control.name)).toEqual(expect.arrayContaining(['Account', 'Help', 'Contact', 'Show offers']));
    const help = page(record, '/help');
    expect(help).toMatchObject({ title: 'Help center', via: { path: '/' } });
    expect(help?.lastSeenAt).toBe(new Date(clock).toISOString());
    const helpLink = root?.controls.find((control) => control.name === 'Help');
    expect(helpLink?.destinations.public).toMatchObject({ path: '/help' });
  });

  it('finds a page by a title word and counts a direct open of it as a worked use (AC-03, SC-002)', async () => {
    await enableAll();
    await learnHome();
    const found = await lookup({ tabId: 7, query: 'help center' }, tabContext(`${ORIGIN}/`));
    expect(found).toMatchObject({ success: true, origin: ORIGIN });
    const target = (found as { pages: Array<{ path: string; addressable: boolean }> }).pages.find((entry) => entry.path === '/help');
    expect(target?.addressable).toBe(true);
    // The second agent goes there in one page load.
    await run(navigateOutcome({ url: `${ORIGIN}/help` }));
    const record = await map();
    expect(page(record, '/help')?.useCount).toBe(1);
    const counters = (await service.map.store.getCounters()).profiles[PROFILE];
    expect(counters).toMatchObject({ lookups: 1, usesWorked: 1, usesFailed: 0 });
    expect(counters.loadsSavedEstimate).toBeGreaterThanOrEqual(1);
  });

  it('answers a named-origin lookup without a tab, with https then the www form (AC-05)', async () => {
    await enableAll();
    await learnHome();
    expect(await lookup({ origin: 'shop.example' })).toMatchObject({ success: true, origin: ORIGIN, outline: true, knownPages: 2 });
    expect(await lookup({ origin: ORIGIN, query: 'help' })).toMatchObject({ success: true, outline: false });
    expect(await lookup({ origin: 'https://shop.example/help' })).toMatchObject({ success: false, error: expect.stringMatching(/^INVALID_ARGUMENT:/u) });
    expect(await lookup({ origin: ORIGIN, tabId: 7 })).toMatchObject({ success: false, error: expect.stringMatching(/^INVALID_ARGUMENT:/u) });
  });

  it('gives coded reasons for a disabled map, excluded site, unverified profile and protected vault (AC-05)', async () => {
    expect(await lookup({ origin: ORIGIN })).toMatchObject({ error: expect.stringMatching(/^MEMORY_DISABLED:/u) });
    await enableMemory();
    expect(await lookup({ origin: ORIGIN })).toMatchObject({ error: expect.stringMatching(/^MAP_DISABLED:/u) });
    await enableMap();
    conn.ambiguous = true;
    expect(await lookup({ origin: ORIGIN })).toMatchObject({ error: expect.stringMatching(/^MEMORY_SCOPE_UNKNOWN:/u) });
    conn.ambiguous = false;
    eligibility = 'protected';
    expect(await lookup({ origin: ORIGIN })).toMatchObject({ error: expect.stringMatching(/^MEMORY_SCOPE_UNKNOWN:/u) });
    eligibility = 'clear';
    conn.browserId = 'default';
    expect(await lookup({ origin: ORIGIN })).toMatchObject({ error: expect.stringMatching(/^MEMORY_SCOPE_UNKNOWN:/u) });
    conn.browserId = PROFILE;
    await writePolicy(dir.memoryDir, excludeOrigin(enablePolicy(defaultPolicy(), iso()), ORIGIN, iso()));
    expect(await lookup({ origin: ORIGIN })).toMatchObject({ error: expect.stringMatching(/^MEMORY_EXCLUDED:/u) });
    expect(await lookup({ tabId: 7 }, tabContext(`${ORIGIN}/`))).toMatchObject({ error: expect.stringMatching(/^MEMORY_EXCLUDED:/u) });
  });

  it('shows profile B none of profile A\'s entries (AC-12)', async () => {
    await enableMemory();
    await enableMap([PROFILE, 'profile-b']);
    clock += 1_000;
    await learnHome();
    conn = { ...conn, browserId: 'profile-b', connectionId: 'conn-2' };
    const answer = await lookup({ origin: ORIGIN });
    expect(answer).toMatchObject({ success: true, knownPages: 0, pages: [] });
    expect(await map('profile-b')).toBeNull();
  });
});

describe('MapService — capture gates (AC-11, AC-13)', () => {
  it('records nothing and observes no click while the map is off or memory is off', async () => {
    await enableMemory();
    clock += 1_000;
    await run(navigateOutcome({ url: `${ORIGIN}/`, snapshot: true, text: navigateWithSnapshot(homeText()) }));
    const { call } = await run(clickOutcome({ target: 'e3', fromUrl: `${ORIGIN}/`, url: `${ORIGIN}/help` }));
    expect(call.observe).toBe(false);
    expect(await map()).toBeNull();
    await writePolicy(dir.memoryDir, defaultPolicy());
    await enableMap();
    clock += 1_000;
    await run(navigateOutcome({ url: `${ORIGIN}/`, snapshot: true, text: navigateWithSnapshot(homeText()) }));
    expect(await map()).toBeNull();
  });

  it('does not observe clicks when the extension lacks site-map, but still learns from reads', async () => {
    await enableAll();
    conn.supportsSiteMap = false;
    await run(navigateOutcome({ url: `${ORIGIN}/`, snapshot: true, text: navigateWithSnapshot(homeText()) }));
    const { call } = await run(clickOutcome({ target: 'e3', fromUrl: `${ORIGIN}/`, url: `${ORIGIN}/help` }));
    expect(call.observe).toBe(false);
    expect(page(await map(), '/')).toBeDefined();
    expect(page(await map(), '/help')).toBeUndefined();
  });

  it('records nothing for a private tab, a protected or unknown vault, or a changed connection', async () => {
    await enableAll();
    await run(navigateOutcome({ url: `${ORIGIN}/`, snapshot: true, text: navigateWithSnapshot(homeText()), context: { url: `${ORIGIN}/`, incognito: true } }));
    for (const state of ['protected', 'unknown'] as const) {
      eligibility = state;
      await run(navigateOutcome({ url: `${ORIGIN}/`, snapshot: true, text: navigateWithSnapshot(homeText()) }));
    }
    eligibility = 'clear';
    const shape = navigateOutcome({ url: `${ORIGIN}/`, snapshot: true, text: navigateWithSnapshot(homeText()) });
    const call = service.beginCall('s1', 'browser_navigate');
    conn.connectionId = 'conn-9';
    service.afterCall(call, { ...shape, observation: { ...shape.observation!, digestBefore: 'a', digestAfter: 'a' } });
    await service.flush();
    expect(await map()).toBeNull();
  });

  it('records no page entries for 100 articles opened by address, while 003 still records the visit (AC-27)', async () => {
    await enableAll();
    await run(navigateOutcome({ url: `${ORIGIN}/`, snapshot: true, text: navigateWithSnapshot(homeText()) }));
    for (let index = 0; index < 100; index += 1) {
      const url = `${ORIGIN}/news/story-${index}`;
      await run(navigateOutcome({ url, snapshot: true, text: navigateWithSnapshot(articleText(`story-${index}`)) }));
    }
    const record = await map();
    expect(record?.pages.map((entry) => entry.path)).toEqual(['/']);
    const memory = await service.handleTool('browser_memory', { tabId: 7, kind: 'visits' }, 's1', tabContext(`${ORIGIN}/`));
    expect(memory).toMatchObject({ success: true });
  });
});

describe('MapService — controls and use feedback, US2 (T025)', () => {
  it('records a click destination per context; another origin stores the origin only (AC-07)', async () => {
    await enableAll();
    await run(navigateOutcome({ url: `${ORIGIN}/`, snapshot: true, text: navigateWithSnapshot(homeText()) }));
    await run(clickOutcome({ target: { role: 'link', name: 'Privacy' }, fromUrl: `${ORIGIN}/`, url: 'https://legal.example/privacy?ref=shop' }));
    const privacy = page(await map(), '/')?.controls.find((control) => control.name === 'Privacy');
    expect(privacy?.destinations.public).toMatchObject({ origin: 'https://legal.example' });
    expect(privacy?.destinations.public?.path).toBeUndefined();
    // Reading the page on the other origin does not give that origin a page entry with its path (RV-05).
    await run(snapshotOutcome({ url: 'https://legal.example/privacy', text: snapshotText('Privacy policy', 'https://legal.example/privacy', []) }));
    expect(await map(PROFILE, 'https://legal.example')).toBeNull();
  });

  it('a click without navigation, then a read with the open menu, gives the parent and opens: menu (AC-08)', async () => {
    await enableAll();
    await run(navigateOutcome({ url: `${ORIGIN}/`, snapshot: true, text: navigateWithSnapshot(homeText()) }));
    await run(clickOutcome({ target: 'e2', fromUrl: `${ORIGIN}/`, url: `${ORIGIN}/` }));
    await run(snapshotOutcome({ url: `${ORIGIN}/`, text: homeText({ menuOpen: true }) }));
    const root = page(await map(), '/');
    const account = root?.controls.find((control) => control.name === 'Account');
    const profile = root?.controls.find((control) => control.name === 'Profile');
    expect(account?.destinations.public).toMatchObject({ opens: 'menu' });
    expect(profile?.parent).toBe(account?.key);
    const signOut = root?.controls.find((control) => control.name === 'Sign out');
    expect(signOut?.dataChanging).toBe(true);
  });

  it('a dialog already open before the click is not credited to the clicked control (RV-14)', async () => {
    await enableAll();
    const lines = (menuOpen: boolean) => [
      ...homeLines({ menuOpen }),
      { depth: 0, role: 'dialog', name: 'Cookies' },
      { depth: 1, role: 'button', name: 'Accept all', ref: 'e90' },
      { depth: 1, role: 'button', name: 'Reject', ref: 'e91' },
    ];
    await run(navigateOutcome({ url: `${ORIGIN}/`, snapshot: true, text: navigateWithSnapshot(snapshotText('Shop home', `${ORIGIN}/`, lines(false))) }));
    await run(clickOutcome({ target: 'e2', fromUrl: `${ORIGIN}/`, url: `${ORIGIN}/` }));
    await run(snapshotOutcome({ url: `${ORIGIN}/`, text: snapshotText('Shop home', `${ORIGIN}/`, lines(false)) }));
    let root = page(await map(), '/');
    expect(root?.controls.find((control) => control.name === 'Account')?.destinations.public?.opens).toBeUndefined();
    expect(root?.controls.some((control) => control.name === 'Accept all')).toBe(false);
    // A menu the click does open is still credited, and the old dialog stays out of it.
    await run(clickOutcome({ target: 'e2', fromUrl: `${ORIGIN}/`, url: `${ORIGIN}/` }));
    await run(snapshotOutcome({ url: `${ORIGIN}/`, text: snapshotText('Shop home', `${ORIGIN}/`, lines(true)) }));
    root = page(await map(), '/');
    const account = root?.controls.find((control) => control.name === 'Account');
    expect(account?.destinations.public).toMatchObject({ opens: 'menu' });
    expect(root?.controls.find((control) => control.name === 'Profile')?.parent).toBe(account?.key);
    expect(root?.controls.some((control) => control.name === 'Accept all')).toBe(false);
  });

  it('a failed click by locator marks the control\'s last use failed, and a worked click ranks it first (AC-31)', async () => {
    await enableAll();
    await learnHome();
    await run(navigateOutcome({ url: `${ORIGIN}/`, snapshot: true, text: navigateWithSnapshot(homeText()) }));
    // The first click learned /help; this one matches it, so it is a worked use.
    await run(clickOutcome({ target: 'e3', fromUrl: `${ORIGIN}/`, url: `${ORIGIN}/help` }));
    await run(navigateOutcome({ url: `${ORIGIN}/`, snapshot: true, text: navigateWithSnapshot(homeText()) }));
    await run(clickOutcome({ target: { role: 'link', name: 'Contact', nth: 0 }, fromUrl: `${ORIGIN}/`, url: `${ORIGIN}/`, error: 'NOT_FOUND: no element matches' }));
    const contact = page(await map(), '/')?.controls.find((control) => control.name === 'Contact' && control.area === 'header');
    expect(contact?.lastUse).toMatchObject({ result: 'failed' });
    const help = page(await map(), '/')?.controls.find((control) => control.name === 'Help');
    expect(help?.useCount).toBe(1);
    // Worked: the matching Help click; failed: the Contact click. Opening / is not a hint use (RV-16).
    expect((await service.map.store.getCounters()).profiles[PROFILE]).toMatchObject({ usesWorked: 1, usesFailed: 1 });
    type Answer = { pages: Array<{ path: string; controls?: Array<{ area: string; name: string; status: string }> }> };
    const controls = async (query: string) => ((await lookup({ origin: ORIGIN, query })) as Answer).pages.find((entry) => entry.path === '/')?.controls ?? [];
    expect((await controls('help'))[0]).toMatchObject({ name: 'Help', status: 'working' });
    const contacts = await controls('contact');
    expect(contacts.find((control) => control.area === 'header')?.status).toBe('last_use_failed');
    // The failed one ranks after the working footer link.
    expect(contacts[0]).toMatchObject({ area: 'footer', status: 'working' });
  });

  it('the navigate reminder adds working controls 003 does not show, the page count, and no data-changing control (AC-26, SC-011)', async () => {
    await enableAll();
    await run(navigateOutcome({ url: `${ORIGIN}/`, snapshot: true, text: navigateWithSnapshot(homeText()) }));
    await run(clickOutcome({ target: 'e2', fromUrl: `${ORIGIN}/`, url: `${ORIGIN}/` }));
    await run(snapshotOutcome({ url: `${ORIGIN}/`, text: homeText({ menuOpen: true }) }));
    const { result } = await run(navigateOutcome({ url: `${ORIGIN}/`, text: 'title: Shop home' }));
    const lines = (result as { memory?: string[] }).memory ?? [];
    expect(lines.at(-1)).toMatch(/^map: 1 known pages for this site/u);
    const block = lines.filter((line) => line.startsWith('map: ')).join('\n');
    const shown003 = lines.filter((line) => !line.startsWith('map: ')).join('\n');
    expect(block).toContain('button "Show offers"');
    expect(block).not.toContain('Sign out');
    expect(block).not.toContain('Profile');
    // A control 003 already shows is not repeated, and duplicates are listed once.
    for (const name of ['Help', 'Account', 'Contact']) {
      const count = (block.match(new RegExp(`"${name}"`, 'gu')) ?? []).length;
      expect(count).toBeLessThanOrEqual(shown003.includes(name) ? 0 : 1);
    }
    expect(block.length).toBeLessThanOrEqual(600);
    expect((result as { text?: string }).text).toContain(lines.at(-1));
  });

  it('marks Arabic data-changing controls and leaves them out of the reminder (AC-32)', async () => {
    await enableAll();
    await run(navigateOutcome({ url: `${ORIGIN}/`, snapshot: true, text: navigateWithSnapshot(arabicText()), context: { url: `${ORIGIN}/`, lang: 'ar', dir: 'rtl' } }));
    const root = page(await map(), '/');
    expect(root?.controls.find((control) => control.name === 'تسجيل الخروج')?.dataChanging).toBe(true);
    expect(root?.controls.find((control) => control.name === 'حول الموقع')?.dataChanging).toBe(false);
    const { result } = await run(navigateOutcome({ url: `${ORIGIN}/`, context: { url: `${ORIGIN}/`, lang: 'ar', dir: 'rtl' } }));
    const mapLines = ((result as { memory?: string[] }).memory ?? []).filter((line) => line.startsWith('map: '));
    expect(mapLines.length).toBeGreaterThan(0);
    expect(mapLines.join('\n')).not.toContain('تسجيل الخروج');
  });
});

describe('MapService — site changes, US4 (T031)', () => {
  it('a redirected direct open records lastOpen elsewhere without refreshing last seen; the landing gets an entry (AC-19)', async () => {
    await enableAll();
    await run(navigateOutcome({ url: `${ORIGIN}/`, snapshot: true, text: navigateWithSnapshot(homeText()) }));
    await run(clickOutcome({ target: 'e3', fromUrl: `${ORIGIN}/`, url: `${ORIGIN}/profilev2.php` }));
    await run(snapshotOutcome({ url: `${ORIGIN}/profilev2.php`, text: profileText() }));
    const before = page(await map(), '/profilev2.php')?.lastSeenAt;
    const redirect = navigateOutcome({ url: `${ORIGIN}/profile`, context: { url: `${ORIGIN}/profile` } });
    const moved: OutcomeShape = { ...redirect, params: { tabId: 7, url: `${ORIGIN}/profilev2.php` } };
    await run(moved);
    const old = page(await map(), '/profilev2.php');
    expect(old?.lastOpen).toMatchObject({ result: 'elsewhere', path: '/profile' });
    expect(old?.lastSeenAt).toBe(before);
    expect(page(await map(), '/profile')).toBeDefined();
  });

  it('a 404 on a direct open records not_found and keeps last seen (AC-29)', async () => {
    await enableAll();
    await learnHome();
    const before = page(await map(), '/help')?.lastSeenAt;
    await run(navigateOutcome({ url: `${ORIGIN}/help`, status: 404 }));
    const help = page(await map(), '/help');
    expect(help?.lastOpen).toMatchObject({ result: 'not_found' });
    expect(help?.lastSeenAt).toBe(before);
    const answer = await lookup({ origin: ORIGIN, query: 'help' }) as { pages: Array<{ path: string; status: string }> };
    expect(answer.pages.find((entry) => entry.path === '/help')?.status).toBe('last_open_not_found');
    // Reached again through its link and read: current again (RV-09).
    await run(navigateOutcome({ url: `${ORIGIN}/`, snapshot: true, text: navigateWithSnapshot(homeText()) }));
    await run(clickOutcome({ target: 'e3', fromUrl: `${ORIGIN}/`, url: `${ORIGIN}/help` }));
    await run(snapshotOutcome({ url: `${ORIGIN}/help`, text: snapshotText('Help center', `${ORIGIN}/help`, []) }));
    const again = await lookup({ origin: ORIGIN, query: 'help' }) as { pages: Array<{ path: string; status: string }> };
    expect(again.pages.find((entry) => entry.path === '/help')?.status).toBe('working');
  });

  it('after the moved-page flow the new page ranks before the old one (AC-30)', async () => {
    await enableAll();
    await run(navigateOutcome({ url: `${ORIGIN}/`, snapshot: true, text: navigateWithSnapshot(homeText()) }));
    await run(clickOutcome({ target: 'e3', fromUrl: `${ORIGIN}/`, url: `${ORIGIN}/profilev2.php` }));
    await run(snapshotOutcome({ url: `${ORIGIN}/profilev2.php`, text: profileText() }));
    const redirect = navigateOutcome({ url: `${ORIGIN}/profile`, context: { url: `${ORIGIN}/profile` } });
    await run({ ...redirect, params: { tabId: 7, url: `${ORIGIN}/profilev2.php` } });
    await run(snapshotOutcome({ url: `${ORIGIN}/profile`, text: snapshotText('My profile', `${ORIGIN}/profile`, []) }));
    await run(navigateOutcome({ url: `${ORIGIN}/profile` }));
    const answer = await lookup({ origin: ORIGIN, query: 'profile' }) as { pages: Array<{ path: string }> };
    const paths = answer.pages.map((entry) => entry.path);
    expect(paths.indexOf('/profile')).toBeLessThan(paths.indexOf('/profilev2.php'));
  });
});

describe('MapService — failures never change the browser result, US5 (T032)', () => {
  it('a store failure leaves the navigate result unchanged apart from one map: unavailable line (AC-23)', async () => {
    const store = new JsonMapStore(dir.memoryDir);
    store.getMap = async () => {
      throw new MemoryStoreError('MEMORY_UNAVAILABLE', 'disk on fire');
    };
    service = makeService(store);
    await enableAll();
    const shape = navigateOutcome({ url: `${ORIGIN}/`, text: 'title: Shop home' });
    const { result } = await run(shape);
    const lines = (result as { memory?: string[] }).memory ?? [];
    expect(lines).toEqual(['map: unavailable (MEMORY_UNAVAILABLE)']);
    const { memory: _memory, text, ...rest } = result as Record<string, unknown>;
    const { text: originalText, ...original } = shape.result as Record<string, unknown>;
    expect(rest).toEqual(original);
    expect(text).toBe(`${originalText}\nmap: unavailable (MEMORY_UNAVAILABLE)`);
  });

  it('a slow store times out to the same line, and a lookup reports MAP_UNAVAILABLE', async () => {
    const store = new JsonMapStore(dir.memoryDir);
    store.getMap = () => new Promise(() => undefined);
    service = makeService(store);
    await enableAll();
    const { result } = await run(navigateOutcome({ url: `${ORIGIN}/` }));
    expect((result as { memory?: string[] }).memory).toEqual(['map: unavailable (MEMORY_UNAVAILABLE)']);
    expect(await lookup({ origin: ORIGIN })).toMatchObject({ success: false, error: expect.stringMatching(/^MAP_UNAVAILABLE:/u) });
  });

  it('a capture that throws inside the map never throws out of afterCall', async () => {
    await enableAll();
    conn.throws = true;
    const shape = navigateOutcome({ url: `${ORIGIN}/`, snapshot: true, text: navigateWithSnapshot(homeText()) });
    expect(() => service.afterCall({ observe: true, browserId: PROFILE, connectionIdBefore: 'conn-1' }, { ...shape, observation: { ...shape.observation!, digestBefore: 'a', digestAfter: 'a' } })).not.toThrow();
    conn.throws = false;
    await service.flush();
    expect(await map()).toBeNull();
  });
});
