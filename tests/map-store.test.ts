import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { JsonMapStore } from '../mcp-server/src/memory/map-store.js';
import { emptyMapRecord, mapFileName, type MapRecord } from '../mcp-server/src/memory/map-record.js';
import { MemoryStoreError } from '../mcp-server/src/memory/site-record.js';
import { mkMapDir } from './helpers/map-fixtures.js';

const T = '2026-10-28T10:00:00.000Z';
const A = 'https://a.example';
const B = 'https://b.example';

function withPage(profile: string, origin: string, pagePath = '/'): MapRecord {
  return {
    ...emptyMapRecord(profile, origin, T),
    pages: [{ path: pagePath, title: 'Home', lang: 'en', dir: 'ltr', addressable: true, reason: 'root', via: null, lastOpen: null, useCount: 0, lastUse: null, readChars: 5, contexts: {}, firstSeenAt: T, lastSeenAt: T, controls: [] }],
  };
}

let dir: ReturnType<typeof mkMapDir>;
beforeEach(() => {
  dir = mkMapDir();
});
afterEach(() => dir.cleanup());

const rejectsWith = async (promise: Promise<unknown>, code: string): Promise<void> => {
  await expect(promise).rejects.toSatisfy((error: unknown) => error instanceof MemoryStoreError && error.code === code);
};

describe('JsonMapStore (T009)', () => {
  it('writes private files under hashed names and reads them back', async () => {
    const store = new JsonMapStore(dir.memoryDir);
    await store.putMap(withPage('browser-a', A));
    const file = path.join(dir.memoryDir, 'maps', mapFileName('browser-a', A));
    expect(fs.existsSync(file)).toBe(true);
    expect(fs.readdirSync(path.join(dir.memoryDir, 'maps')).join(' ')).not.toContain('browser-a');
    if (process.platform !== 'win32') {
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
      expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
    }
    const fresh = new JsonMapStore(dir.memoryDir);
    expect((await fresh.getMap('browser-a', A))?.pages[0].path).toBe('/');
    expect(await fresh.getMap('browser-b', A)).toBeNull();
  });

  it('keeps profiles apart (FR-005)', async () => {
    const store = new JsonMapStore(dir.memoryDir);
    await store.putMap(withPage('browser-a', A));
    await store.putMap(withPage('browser-b', A, '/b'));
    expect((await store.listMaps('browser-a')).map((record) => record.profile)).toEqual(['browser-a']);
    expect(await store.listMaps()).toHaveLength(2);
  });

  it('deletes one map, one origin across profiles, one profile, and everything', async () => {
    const store = new JsonMapStore(dir.memoryDir);
    await store.putMap(withPage('browser-a', A));
    await store.putMap(withPage('browser-a', B));
    await store.putMap(withPage('browser-b', A));
    await store.putCounters({ schemaVersion: 1, profiles: { 'browser-a': { lookups: 1, usesWorked: 0, usesFailed: 0, loadsSavedEstimate: 0, charsSavedEstimate: 0, since: T } } });
    expect(await store.deleteMap('browser-a', B)).toBe(true);
    expect(await store.deleteOrigin(A, ['browser-a', 'browser-b', 'browser-c'])).toBe(2);
    expect(await store.listMaps()).toEqual([]);
    await store.putMap(withPage('browser-a', A));
    await store.putMap(withPage('browser-b', A));
    expect(await store.deleteProfile('browser-a')).toBe(1);
    expect((await store.status()).files).toBe(1);
    expect(await store.deleteAll()).toBe(1);
    expect(await store.status()).toEqual({ profiles: 0, files: 0, totalBytes: 0, corrupt: 0 });
    expect((await store.getCounters()).profiles).toEqual({});
  });

  it('refuses a new file at the per-profile and total limits, not an existing one', async () => {
    const store = new JsonMapStore(dir.memoryDir, { limits: { maxFilesPerProfile: 1 } });
    await store.putMap(withPage('browser-a', A));
    await rejectsWith(store.putMap(withPage('browser-a', B)), 'MEMORY_FULL');
    await store.putMap(withPage('browser-a', A, '/x'));
    await store.putMap(withPage('browser-b', B));
    expect(await store.wouldRefuseNew('browser-a', B)).toBe(true);
    expect(await store.wouldRefuseNew('browser-a', A)).toBe(false);
    const tiny = new JsonMapStore(dir.memoryDir, { limits: { maxFileBytes: 50 } });
    await rejectsWith(tiny.putMap(withPage('browser-c', A)), 'MEMORY_FULL');
  });

  it('quarantines a corrupt or mismatched file and starts empty', async () => {
    const store = new JsonMapStore(dir.memoryDir, { now: () => 42 });
    await store.putMap(withPage('browser-a', A));
    const file = path.join(dir.memoryDir, 'maps', mapFileName('browser-a', A));
    fs.writeFileSync(file, '{not json', { mode: 0o600 });
    const fresh = new JsonMapStore(dir.memoryDir, { now: () => 42 });
    await rejectsWith(fresh.getMap('browser-a', A), 'MEMORY_CORRUPT');
    expect(fs.existsSync(`${file}.corrupt-42`)).toBe(true);
    expect(await fresh.getMap('browser-a', A)).toBeNull();
    expect((await fresh.status()).corrupt).toBe(1);

    // A valid record copied under another pair's name is refused too.
    await fresh.putMap(withPage('browser-b', B));
    fs.copyFileSync(path.join(dir.memoryDir, 'maps', mapFileName('browser-b', B)), file);
    await rejectsWith(new JsonMapStore(dir.memoryDir, { now: () => 43 }).getMap('browser-a', A), 'MEMORY_CORRUPT');
  });

  it('refuses a maps directory other users can read', async () => {
    if (process.platform === 'win32') return;
    fs.mkdirSync(path.join(dir.memoryDir, 'maps'), { mode: 0o755 });
    fs.chmodSync(path.join(dir.memoryDir, 'maps'), 0o755);
    await rejectsWith(new JsonMapStore(dir.memoryDir).getMap('browser-a', A), 'MEMORY_UNAVAILABLE');
  });

  it('validates counters and quarantines unreadable ones', async () => {
    const store = new JsonMapStore(dir.memoryDir, { now: () => 7 });
    await expect(store.putCounters({ schemaVersion: 1, profiles: { x: { lookups: -1 } } } as never)).rejects.toBeInstanceOf(MemoryStoreError);
    fs.writeFileSync(path.join(dir.memoryDir, 'map-counters.json'), '[]', { mode: 0o600 });
    expect((await store.getCounters()).profiles).toEqual({});
    expect(fs.existsSync(path.join(dir.memoryDir, 'map-counters.json.corrupt-7'))).toBe(true);
  });

  it('reports a counters read error without setting the file aside', async () => {
    if (process.platform === 'win32') return;
    const store = new JsonMapStore(dir.memoryDir, { now: () => 7 });
    await store.putCounters({ schemaVersion: 1, profiles: {} } as never);
    const file = path.join(dir.memoryDir, 'map-counters.json');
    const original = fs.promises.readFile;
    fs.promises.readFile = (() => Promise.reject(Object.assign(new Error('too many open files'), { code: 'EMFILE' }))) as typeof original;
    try {
      await rejectsWith(store.getCounters(), 'MEMORY_UNAVAILABLE');
    } finally {
      fs.promises.readFile = original;
    }
    expect(fs.existsSync(file)).toBe(true);
    expect(fs.existsSync(`${file}.corrupt-7`)).toBe(false);
  });

  it('removes temp files a crash left behind', async () => {
    const store = new JsonMapStore(dir.memoryDir);
    await store.putMap(withPage('browser-a', A));
    const profileDir = path.dirname(path.join(dir.memoryDir, 'maps', mapFileName('browser-a', A)));
    fs.writeFileSync(path.join(profileDir, 'x.json.1.ab.tmp'), 'partial', { mode: 0o600 });
    await new JsonMapStore(dir.memoryDir).warm();
    expect(fs.readdirSync(profileDir).some((name) => name.endsWith('.tmp'))).toBe(false);
  });
});
