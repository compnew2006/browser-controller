import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MapQueue, type QueuedMapOp } from '../mcp-server/src/memory/map-queue.js';
import { JsonMapStore } from '../mcp-server/src/memory/map-store.js';
import { addMapTombstone, defaultMapPolicy, enableMapProfile, excludeMapPath, type MapPolicy } from '../mcp-server/src/memory/map-policy.js';
import { defaultPolicy, enablePolicy, type MemoryPolicy } from '../mcp-server/src/memory/policy.js';
import type { MapReadOp } from '../mcp-server/src/memory/map-reconcile.js';
import { controlKey } from '../mcp-server/src/memory/map-text.js';
import { mkMapDir } from './helpers/map-fixtures.js';

const O = 'https://a.example';
const T0 = '2026-10-28T09:00:00.000Z';
const NOW = Date.parse('2026-10-28T10:00:00.000Z');
const HELP = { key: controlKey('header', 'link', 'Help'), area: 'header' as const, role: 'link' as const, name: 'Help', nth: null, parent: null };

let dir: ReturnType<typeof mkMapDir>;
let memory: MemoryPolicy;
let map: MapPolicy;
beforeEach(() => {
  dir = mkMapDir();
  memory = enablePolicy(defaultPolicy(), T0);
  map = enableMapProfile(defaultMapPolicy(), 'p', T0);
});
afterEach(() => dir.cleanup());

let seq = 0;
function read(overrides: Partial<MapReadOp> = {}): QueuedMapOp {
  seq += 1;
  return { type: 'read', opId: `r${seq}`, profile: 'p', origin: O, at: new Date(NOW + seq).toISOString(), path: '/', addressable: true, title: 'Home', lang: 'en', dir: 'ltr', context: 'public', complete: true, readChars: 50, controls: [HELP], reason: 'root', ...overrides };
}

function queue(store = new JsonMapStore(dir.memoryDir), extra: Partial<ConstructorParameters<typeof MapQueue>[0]> = {}) {
  return new MapQueue({ store, memoryDir: dir.memoryDir, readMemoryPolicy: () => memory, readMapPolicy: () => map, now: () => NOW + 1_000, ...extra });
}

describe('MapQueue (T011, R-03)', () => {
  it('commits one group with one write and dedupes a replayed opId (AC-24)', async () => {
    const store = new JsonMapStore(dir.memoryDir);
    const q = queue(store);
    const op = read();
    expect(q.enqueue(op).accepted).toBe(true);
    expect(q.enqueue(op)).toEqual({ accepted: false, reason: 'duplicate' });
    q.enqueue(read({ path: '/x', reason: 'refresh' }));
    await q.drain();
    const record = await store.getMap('p', O);
    expect(record?.commitSeq).toBe(1);
    expect(record?.pages).toHaveLength(1);
    expect(q.enqueue(op)).toEqual({ accepted: false, reason: 'duplicate' });
    expect(q.stats()).toMatchObject({ committed: 2, dropped: { duplicate: 2 } });
  });

  it('re-checks the policy at commit: off, excluded path and tombstones drop queued work (AC-11, AC-16)', async () => {
    const store = new JsonMapStore(dir.memoryDir);
    const q = queue(store);
    q.enqueue(read());
    map = { ...map, profiles: { p: { enabled: false, enabledAt: null } } };
    await q.drain();
    expect(await store.getMap('p', O)).toBeNull();

    map = enableMapProfile(defaultMapPolicy(), 'p', T0);
    q.enqueue(read({ path: '/health/x', reason: 'landing', rawPaths: ['/health/x'] }));
    map = excludeMapPath(map, O, '/health', T0);
    await q.drain();
    expect(await store.getMap('p', O)).toBeNull();

    const late = read();
    map = addMapTombstone(map, { profile: 'p', origin: O, at: new Date(NOW + 10_000).toISOString() });
    q.enqueue(late);
    await q.drain();
    expect(await store.getMap('p', O)).toBeNull();
    expect(q.stats().dropped).toMatchObject({ disabled: 1, excluded: 1, deleted: 1 });
  });

  it('writes nothing for a pair without structural pages', async () => {
    const store = new JsonMapStore(dir.memoryDir);
    const q = queue(store);
    q.enqueue(read({ path: '/news/a', reason: 'refresh' }));
    await q.drain();
    expect(await store.listMaps()).toEqual([]);
  });

  it('bounds pending groups', () => {
    const q = queue(undefined, { maxPending: 1 });
    expect(q.enqueue(read()).accepted).toBe(true);
    expect(q.enqueue(read({ origin: 'https://b.example' }))).toEqual({ accepted: false, reason: 'queue_full' });
  });

  it('drops pending work on demand and settles in-flight work', async () => {
    const q = queue();
    q.enqueue(read());
    expect(q.dropPending('deleted')).toBe(1);
    await q.settle();
    await q.drain();
    expect(q.stats().pending).toBe(0);
  });

  it('turns a store failure into a coded drop, never a throw (AC-23)', async () => {
    const store = new JsonMapStore(dir.memoryDir);
    store.putMap = async () => {
      throw new Error('disk on fire');
    };
    const q = queue(store);
    q.enqueue(read());
    await q.drain();
    expect(q.stats().dropped.io_error).toBe(1);
  });

  it('abandons a commit that runs past the timeout', async () => {
    const store = new JsonMapStore(dir.memoryDir);
    store.getMap = () => new Promise(() => undefined);
    const q = queue(store, { commitTimeoutMs: 20 });
    q.enqueue(read());
    await q.drain();
    expect(q.stats().dropped.timeout).toBe(1);
  });

  it('folds counters per profile into one write, and a profile wipe drops older deltas (R-19)', async () => {
    const store = new JsonMapStore(dir.memoryDir);
    const q = queue(store);
    q.count({ opId: 'l1', profile: 'p', at: new Date(NOW).toISOString(), field: 'lookups', delta: 1 });
    q.count({ opId: 'l2', profile: 'p', at: new Date(NOW).toISOString(), field: 'lookups', delta: 1 });
    await q.drain();
    expect((await store.getCounters()).profiles.p.lookups).toBe(2);
    map = addMapTombstone(map, { profile: 'p', origin: '*', at: new Date(NOW + 5).toISOString() });
    q.count({ opId: 'l3', profile: 'p', at: new Date(NOW).toISOString(), field: 'lookups', delta: 1 });
    await q.drain();
    expect((await store.getCounters()).profiles.p.lookups).toBe(2);
  });

  it('counts decided uses and the labeled estimates', async () => {
    const store = new JsonMapStore(dir.memoryDir);
    const q = queue(store);
    q.enqueue(read());
    const base = { profile: 'p', origin: O, fromPath: '/', control: HELP, lang: 'en', sourceContext: 'public' as const, navigated: true, destination: { path: '/help' }, destinationAddressable: true };
    q.enqueue({ type: 'click', opId: 'c1', at: new Date(NOW + 100).toISOString(), ...base });
    q.enqueue({ type: 'click', opId: 'c2', at: new Date(NOW + 200).toISOString(), ...base });
    q.enqueue({ type: 'open', opId: 'o1', profile: 'p', origin: O, at: new Date(NOW + 300).toISOString(), requestedPath: '/help', result: 'same' });
    await q.drain();
    const counters = (await store.getCounters()).profiles.p;
    expect(counters).toMatchObject({ usesWorked: 2, usesFailed: 0, loadsSavedEstimate: 1, charsSavedEstimate: 100 });
  });
});
