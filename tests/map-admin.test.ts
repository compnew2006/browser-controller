import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseMemoryAdminRequest } from '../mcp-server/src/daemon-config.js';
import { MemoryService, type MemoryConnection } from '../mcp-server/src/memory/service.js';
import { defaultPolicy, enablePolicy, writePolicy } from '../mcp-server/src/memory/policy.js';
import { readMapPolicy } from '../mcp-server/src/memory/map-policy.js';
import { ORIGIN, clickOutcome, homeText, mkMapDir, navigateOutcome, navigateWithSnapshot, profileText, snapshotOutcome, snapshotText, type OutcomeShape } from './helpers/map-fixtures.js';

const PROFILE = 'profile-a';
const OTHER = 'https://other.example';

let dir: ReturnType<typeof mkMapDir>;
let clock: number;
let conn: MemoryConnection;
let service: MemoryService;

const makeService = () => new MemoryService({ memoryDir: dir.memoryDir, vault: { memoryEligibility: () => 'clear' }, connection: () => ({ ...conn }), now: () => clock });
let seq = 0;
const admin = (command: string, extra: Record<string, unknown> = {}) => service.adminFromWire({ kind: 'memory-admin', id: `a${(seq += 1)}`, command, ...extra });
const mapAdmin = (map: Record<string, unknown>) => admin('map', { map });

async function run(shape: OutcomeShape, flush = true): Promise<void> {
  clock += 1_000;
  const call = service.beginCall(shape.sessionId, shape.tool);
  const observation = call.observe && shape.observation ? { ...shape.observation, digestBefore: 'a', digestAfter: 'a' } : undefined;
  service.afterCall(call, { sessionId: shape.sessionId, tool: shape.tool, params: shape.params, daemonCallId: shape.daemonCallId, result: shape.result, observation, ...(shape.error ? { error: shape.error } : {}) });
  if (flush) await service.flush();
}

/** `/`, then `/profilev2.php` through the Help link, read; and `/` of a second site. */
async function learn(origin = ORIGIN): Promise<void> {
  await run(navigateOutcome({ url: `${origin}/`, snapshot: true, text: navigateWithSnapshot(homeText()) }));
  await run(clickOutcome({ target: 'e3', fromUrl: `${origin}/`, url: `${origin}/profilev2.php` }));
  await run(snapshotOutcome({ url: `${origin}/profilev2.php`, text: profileText() }));
}

const paths = async (profile = PROFILE, origin = ORIGIN) => (await service.map.store.getMap(profile, origin, { afterWrites: true }))?.pages.map((page) => page.path).sort() ?? null;

beforeEach(async () => {
  dir = mkMapDir('bc-mapadm-');
  clock = Date.parse('2026-10-28T09:00:00.000Z');
  conn = { browserId: PROFILE, browserLabel: 'Work', connectionId: 'conn-1', ambiguous: false, supportsSiteContext: true, supportsSiteMap: true };
  service = makeService();
  await writePolicy(dir.memoryDir, enablePolicy(defaultPolicy(), new Date(clock).toISOString()));
  clock += 1_000;
  expect(await mapAdmin({ command: 'enable', browser: PROFILE })).toMatchObject({ success: true });
  clock += 1_000;
});

afterEach(async () => {
  await service.flush();
  dir.cleanup();
});

describe('memory-admin map: request validation (T028)', () => {
  it.each([
    [{ command: 'status' }],
    [{ command: 'enable', browser: 'b' }],
    [{ command: 'exclude-path', origin: ORIGIN, path: '/health' }],
    [{ command: 'inspect', origin: ORIGIN, browser: 'b' }],
    [{ command: 'export' }],
    [{ command: 'delete', origin: ORIGIN, path: '/a' }],
    [{ command: 'delete', all: true, browser: 'b' }],
  ])('accepts %j', (map) => {
    expect(parseMemoryAdminRequest({ kind: 'memory-admin', id: '1', command: 'map', map })).toMatchObject({ ok: true, request: { command: 'map', map } });
  });

  it.each([
    ['no map field', { command: 'map' }],
    ['map with origin', { command: 'map', origin: ORIGIN, map: { command: 'status' } }],
    ['map field on another command', { command: 'status', map: { command: 'status' } }],
    ['enable without browser', { command: 'map', map: { command: 'enable' } }],
    ['unknown field', { command: 'map', map: { command: 'status', extra: 1 } }],
    ['path with query', { command: 'map', map: { command: 'exclude-path', origin: ORIGIN, path: '/a?b' } }],
    ['path on status', { command: 'map', map: { command: 'status', path: '/a' } }],
    ['delete with origin and all', { command: 'map', map: { command: 'delete', origin: ORIGIN, all: true } }],
    ['delete with neither', { command: 'map', map: { command: 'delete' } }],
    ['bad origin', { command: 'map', map: { command: 'inspect', origin: 'shop.example' } }],
  ])('refuses %s', (_name, extra) => {
    expect(parseMemoryAdminRequest({ kind: 'memory-admin', id: '1', ...extra })).toMatchObject({ ok: false, error: expect.stringMatching(/^INVALID_ARGUMENT:/u) });
  });
});

describe('memory-admin map: status and counters (AC-35, SC-010)', () => {
  it('reports per profile counts, a date and counters, and never an origin, path, title or name', async () => {
    await learn();
    await service.handleTool('browser_site_map', { origin: ORIGIN }, 's1', { siteContext: null, connectionIdBefore: null });
    await service.handleTool('browser_site_map', { origin: ORIGIN, query: 'profile' }, 's1', { siteContext: null, connectionIdBefore: null });
    await run(navigateOutcome({ url: `${ORIGIN}/profilev2.php` }));
    const answer = await mapAdmin({ command: 'status' });
    expect(answer.success).toBe(true);
    const status = answer.mapStatus?.[PROFILE];
    expect(status).toMatchObject({ enabled: true, files: 1, quarantined: 0, oldestEntryDate: '2026-10-28' });
    expect(status?.counters).toMatchObject({ lookups: 2, usesWorked: 1, usesFailed: 0 });
    const json = JSON.stringify(answer);
    for (const secret of ['shop.example', '/profilev2.php', 'Shop home', 'Your profile', 'Edit profile', 'Help']) expect(json).not.toContain(secret);
  });

  it('delete --all for the profile resets its counters', async () => {
    await learn();
    await service.handleTool('browser_site_map', { origin: ORIGIN }, 's1', { siteContext: null, connectionIdBefore: null });
    await service.flush();
    expect((await mapAdmin({ command: 'status' })).mapStatus?.[PROFILE]?.counters).toMatchObject({ lookups: 1 });
    await mapAdmin({ command: 'delete', all: true, browser: PROFILE });
    const status = (await mapAdmin({ command: 'status', browser: PROFILE })).mapStatus?.[PROFILE];
    expect(status).toMatchObject({ files: 0, counters: null });
  });

  it.skipIf(process.platform === 'win32')('keeps status and the policy commands working when the counters file cannot be read', async () => {
    await learn();
    await service.handleTool('browser_site_map', { origin: ORIGIN }, 's1', { siteContext: null, connectionIdBefore: null });
    await service.flush();
    // Readable by other users: the store refuses the file without reading it.
    fs.chmodSync(path.join(dir.memoryDir, 'map-counters.json'), 0o644);
    const status = await mapAdmin({ command: 'status' });
    expect(status).toMatchObject({ success: true });
    expect(status.mapStatus?.[PROFILE]).toMatchObject({ enabled: true, files: 1, counters: null });
    expect(await mapAdmin({ command: 'exclude-path', origin: ORIGIN, path: '/profilev2.php' })).toMatchObject({ success: true });
    expect(await mapAdmin({ command: 'disable', browser: PROFILE })).toMatchObject({ success: true, mapStatus: { [PROFILE]: { enabled: false } } });
    expect(status.mapCountersError).toBe('MEMORY_UNAVAILABLE');
  });

  it.skipIf(process.platform === 'win32')('deletes a profile\'s maps when the counters file cannot be read, and says the counters were not reset', async () => {
    await learn();
    await service.handleTool('browser_site_map', { origin: ORIGIN }, 's1', { siteContext: null, connectionIdBefore: null });
    await service.flush();
    fs.chmodSync(path.join(dir.memoryDir, 'map-counters.json'), 0o644);
    const answer = await mapAdmin({ command: 'delete', all: true, browser: PROFILE });
    expect(answer).toMatchObject({ success: true, mapCountersError: 'MEMORY_UNAVAILABLE', mapStatus: { [PROFILE]: { files: 0, counters: null } } });
    // Readable again: the entry the delete could not reset is still there, and status no longer reports an error.
    fs.chmodSync(path.join(dir.memoryDir, 'map-counters.json'), 0o600);
    const status = await mapAdmin({ command: 'status', browser: PROFILE });
    expect(status).not.toHaveProperty('mapCountersError');
    expect(status.mapStatus?.[PROFILE]?.counters).toMatchObject({ lookups: 1 });
  });
});

describe('memory-admin map: deletes (AC-16)', () => {
  it('deletes exactly one page entry, not the pages under it, and it does not come back after a restart (RV-08)', async () => {
    await learn();
    await run(clickOutcome({ target: 'e102', fromUrl: `${ORIGIN}/profilev2.php`, url: `${ORIGIN}/profilev2.php/edit` }));
    await run(snapshotOutcome({ url: `${ORIGIN}/profilev2.php/edit`, text: snapshotText('Edit', `${ORIGIN}/profilev2.php/edit`, [{ depth: 0, role: 'navigation' }, { depth: 1, role: 'link', name: 'Home', ref: 'e1' }]) }));
    expect(await paths()).toEqual(['/', '/profilev2.php', '/profilev2.php/edit']);
    expect(await mapAdmin({ command: 'delete', origin: ORIGIN, path: '/profilev2.php', browser: PROFILE })).toMatchObject({ success: true });
    expect(await paths()).toEqual(['/', '/profilev2.php/edit']);
    service = makeService();
    expect(await paths()).toEqual(['/', '/profilev2.php/edit']);
    // The root page can be named too.
    expect(await mapAdmin({ command: 'delete', origin: ORIGIN, path: '/', browser: PROFILE })).toMatchObject({ success: true });
    expect(await paths()).toEqual(['/profilev2.php/edit']);
  });

  it('reports a failed rewrite and keeps the excluded entry out of reads (RV-06)', async () => {
    await learn();
    const store = service.map.store;
    const original = store.putMap.bind(store);
    let writes = 0;
    store.putMap = () => {
      writes += 1;
      return Promise.reject(new Error('disk full'));
    };
    try {
      const answer = await mapAdmin({ command: 'exclude-path', origin: ORIGIN, path: '/profilev2.php' });
      expect(answer).toMatchObject({ success: false, error: expect.stringMatching(/^MEMORY_UNAVAILABLE:/u) });
      expect(writes).toBeGreaterThan(0);
    } finally {
      store.putMap = original;
    }
    const lookup = await service.handleTool('browser_site_map', { origin: ORIGIN }, 's1', { siteContext: null, connectionIdBefore: null });
    expect(JSON.stringify(lookup)).not.toContain('profilev2');
  });

  it('deletes a site, and queued work for it is dropped', async () => {
    await learn();
    await learn(OTHER);
    await run(navigateOutcome({ url: `${ORIGIN}/`, snapshot: true, text: navigateWithSnapshot(homeText()) }), false);
    expect(await mapAdmin({ command: 'delete', origin: ORIGIN })).toMatchObject({ success: true });
    await service.flush();
    expect(await paths()).toBeNull();
    expect(await paths(PROFILE, OTHER)).toEqual(['/', '/profilev2.php']);
    service = makeService();
    expect(await paths()).toBeNull();
  });

  it('deletes everything with delete --all, including the counters', async () => {
    await learn();
    await mapAdmin({ command: 'delete', all: true });
    expect(await paths()).toBeNull();
    expect(fs.existsSync(path.join(dir.memoryDir, 'map-counters.json'))).toBe(false);
    // New work after the delete is recorded again.
    await learn();
    expect(await paths()).toEqual(['/', '/profilev2.php']);
  });

  it('003 delete <origin> and delete --all also delete maps (R-05)', async () => {
    await learn();
    await learn(OTHER);
    expect(await admin('delete', { origin: ORIGIN })).toMatchObject({ success: true });
    expect(await paths()).toBeNull();
    expect(await paths(PROFILE, OTHER)).not.toBeNull();
    expect(await admin('delete', { all: true })).toMatchObject({ success: true });
    expect(await paths(PROFILE, OTHER)).toBeNull();
  });
});

describe('memory-admin map: path exclusion (AC-34)', () => {
  it('excludes at segment boundaries, deletes existing entries and stores no destination under it', async () => {
    await learn();
    expect(await mapAdmin({ command: 'exclude-path', origin: ORIGIN, path: '/profilev2.php' })).toMatchObject({ success: true });
    expect(await paths()).toEqual(['/']);
    const help = (await service.map.store.getMap(PROFILE, ORIGIN))?.pages[0].controls.find((control) => control.name === 'Help');
    expect(help?.destinations.public).toMatchObject({ excluded: true });
    expect(help?.destinations.public?.path).toBeUndefined();
    // Browsing under it records nothing; a sibling outside the prefix is recorded.
    await run(clickOutcome({ target: 'e3', fromUrl: `${ORIGIN}/`, url: `${ORIGIN}/profilev2.php` }));
    await run(snapshotOutcome({ url: `${ORIGIN}/profilev2.php`, text: profileText() }));
    expect(await paths()).toEqual(['/']);
    expect(await mapAdmin({ command: 'include-path', origin: ORIGIN, path: '/profilev2.php' })).toMatchObject({ success: true });
    expect(readMapPolicy(dir.memoryDir).excludedPaths).toEqual({});
  });

  it('excludes a non-ASCII prefix typed as the owner reads it (RV-04)', async () => {
    const health = `${ORIGIN}/${encodeURIComponent('صحة')}/${encodeURIComponent('تحاليل')}`;
    await run(navigateOutcome({ url: `${ORIGIN}/`, snapshot: true, text: navigateWithSnapshot(homeText()) }));
    await run(clickOutcome({ target: 'e3', fromUrl: `${ORIGIN}/`, url: health }));
    await run(snapshotOutcome({ url: health, text: profileText() }));
    expect(await paths()).toHaveLength(2);
    expect(await mapAdmin({ command: 'exclude-path', origin: ORIGIN, path: '/صحة' })).toMatchObject({ success: true });
    expect(await paths()).toEqual(['/']);
    await run(clickOutcome({ target: 'e3', fromUrl: `${ORIGIN}/`, url: health }));
    await run(snapshotOutcome({ url: health, text: profileText() }));
    expect(await paths()).toEqual(['/']);
  });
});

describe('memory-admin map: enable, disable and a corrupt policy (R-21)', () => {
  it('disable stops capture and keeps the data; an unreadable policy blocks changes except disable and delete --all', async () => {
    await learn();
    await mapAdmin({ command: 'disable', browser: PROFILE });
    await run(navigateOutcome({ url: `${ORIGIN}/news`, snapshot: true, text: navigateWithSnapshot(homeText()) }));
    expect(await paths()).toEqual(['/', '/profilev2.php']);

    fs.writeFileSync(path.join(dir.memoryDir, 'map-policy.json'), '{not json', { mode: 0o600 });
    const refused = await mapAdmin({ command: 'enable', browser: PROFILE });
    expect(refused).toMatchObject({ success: false, error: expect.stringMatching(/^MEMORY_CORRUPT:.*map disable/u) });
    expect(await mapAdmin({ command: 'disable', browser: PROFILE })).toMatchObject({ success: true });
    expect(readMapPolicy(dir.memoryDir).profiles).toEqual({});
    expect((await mapAdmin({ command: 'status' })).mapStatus).toBeDefined();
  });

  it('refuses enabling the default identity', async () => {
    expect(await mapAdmin({ command: 'enable', browser: 'default' })).toMatchObject({ success: false, error: expect.stringMatching(/^INVALID_ARGUMENT:/u) });
  });

  it('inspect and export return this owner\'s full records', async () => {
    await learn();
    const inspected = await mapAdmin({ command: 'inspect', origin: ORIGIN });
    expect(inspected.records).toHaveLength(1);
    expect(inspected.records?.[0]).toMatchObject({ profile: PROFILE, origin: ORIGIN });
    const exported = await mapAdmin({ command: 'export', browser: PROFILE });
    expect(exported.records).toHaveLength(1);
    expect(exported.mapStatus?.[PROFILE]).toBeDefined();
  });
});
