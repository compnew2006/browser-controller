import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  addMapTombstone,
  countQuarantinedMapPolicies,
  defaultMapPolicy,
  disableMapProfile,
  enableMapProfile,
  excludeMapPath,
  includeMapPath,
  mapVerdict,
  pruneMapTombstones,
  quarantineMapPolicy,
  readMapPolicy,
  tombstoneBlocks,
  writeMapPolicy,
  MAX_MAP_PROFILES,
} from '../mcp-server/src/memory/map-policy.js';
import { MemoryPolicyError, defaultPolicy, enablePolicy, excludeOrigin, recordDeletion } from '../mcp-server/src/memory/policy.js';
import { mkMapDir } from './helpers/map-fixtures.js';

const T0 = '2026-10-28T09:00:00.000Z';
const T1 = '2026-10-28T10:00:00.000Z';
const T2 = '2026-10-28T11:00:00.000Z';
const O = 'https://a.example';

let dir: ReturnType<typeof mkMapDir>;
beforeEach(() => {
  dir = mkMapDir();
});
afterEach(() => dir.cleanup());

const codeOf = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (error) {
    return error instanceof MemoryPolicyError ? error.code : 'other';
  }
  return undefined;
};

describe('map policy file (T008)', () => {
  it('is the disabled default when missing, and round-trips', async () => {
    expect(readMapPolicy(dir.memoryDir)).toEqual(defaultMapPolicy());
    const policy = enableMapProfile(defaultMapPolicy(), 'browser-a', T1);
    await writeMapPolicy(dir.memoryDir, policy);
    expect(readMapPolicy(dir.memoryDir)).toEqual(policy);
    if (process.platform !== 'win32') expect(fs.statSync(path.join(dir.memoryDir, 'map-policy.json')).mode & 0o777).toBe(0o600);
  });

  it('reports corrupt content and can set it aside', () => {
    fs.writeFileSync(path.join(dir.memoryDir, 'map-policy.json'), '{"schemaVersion":2}', { mode: 0o600 });
    expect(codeOf(() => readMapPolicy(dir.memoryDir))).toBe('MEMORY_CORRUPT');
    quarantineMapPolicy(dir.memoryDir, 123);
    expect(countQuarantinedMapPolicies(dir.memoryDir)).toBe(1);
    expect(readMapPolicy(dir.memoryDir)).toEqual(defaultMapPolicy());
  });

  it('refuses unknown fields and unsafe profile keys', () => {
    const raw = { ...defaultMapPolicy(), extra: true };
    fs.writeFileSync(path.join(dir.memoryDir, 'map-policy.json'), JSON.stringify(raw), { mode: 0o600 });
    expect(codeOf(() => readMapPolicy(dir.memoryDir))).toBe('MEMORY_CORRUPT');
    fs.writeFileSync(path.join(dir.memoryDir, 'map-policy.json'), '{"schemaVersion":1,"profiles":{"__proto__":{"enabled":true,"enabledAt":null}},"excludedPaths":{},"deletions":[],"updatedAt":"2026-10-28T10:00:00.000Z"}', { mode: 0o600 });
    expect(codeOf(() => readMapPolicy(dir.memoryDir))).toBe('MEMORY_CORRUPT');
  });

  it('refuses a policy file other users can write', () => {
    if (process.platform === 'win32') return;
    fs.writeFileSync(path.join(dir.memoryDir, 'map-policy.json'), JSON.stringify(defaultMapPolicy()), { mode: 0o666 });
    fs.chmodSync(path.join(dir.memoryDir, 'map-policy.json'), 0o666);
    expect(codeOf(() => readMapPolicy(dir.memoryDir))).toBe('MEMORY_UNAVAILABLE');
  });
});

describe('map policy transitions', () => {
  it('enables per profile, keeps enabledAt while on, and disable keeps the entry', () => {
    let policy = enableMapProfile(defaultMapPolicy(), 'browser-a', T1);
    policy = enableMapProfile(policy, 'browser-a', T2);
    expect(policy.profiles['browser-a']).toEqual({ enabled: true, enabledAt: T1 });
    policy = disableMapProfile(policy, 'browser-a', T2);
    expect(policy.profiles['browser-a']).toEqual({ enabled: false, enabledAt: null });
    expect(codeOf(() => enableMapProfile(defaultMapPolicy(), 'default', T1))).toBe('INVALID_ARGUMENT');
  });

  it('bounds profiles and prefixes', () => {
    let policy = defaultMapPolicy();
    for (let index = 0; index < MAX_MAP_PROFILES; index += 1) policy = enableMapProfile(policy, `browser-${index}`, T1);
    expect(codeOf(() => enableMapProfile(policy, 'browser-x', T1))).toBe('MEMORY_FULL');
    let paths = defaultMapPolicy();
    for (let index = 0; index < 32; index += 1) paths = excludeMapPath(paths, O, `/p${index}`, T1);
    expect(codeOf(() => excludeMapPath(paths, O, '/one-more', T1))).toBe('MEMORY_FULL');
  });

  it('excludes and includes canonical prefixes, case-insensitively', () => {
    let policy = excludeMapPath(defaultMapPolicy(), `${O}/`, '/Health/', T1);
    expect(policy.excludedPaths[O]).toEqual(['/Health']);
    policy = excludeMapPath(policy, O, '/health', T1);
    expect(policy.excludedPaths[O]).toEqual(['/Health']);
    policy = includeMapPath(policy, O, '/health', T2);
    expect(policy.excludedPaths[O]).toBeUndefined();
    expect(codeOf(() => excludeMapPath(defaultMapPolicy(), O, '/', T1))).toBe('INVALID_ARGUMENT');
  });

  it('prunes tombstones the queue has drained past, once they are older than the retention (RV-06)', () => {
    let policy = addMapTombstone(defaultMapPolicy(), { profile: '*', origin: O, at: T1 });
    policy = addMapTombstone(policy, { profile: '*', origin: O, at: T2 });
    // Drained past both, but both are recent: kept, so reads still hide what a failed rewrite left behind.
    expect(pruneMapTombstones(policy, T2, '2026-10-28T12:00:00.000Z').deletions).toHaveLength(2);
    // Eight days later: only the one the queue has drained past goes.
    expect(pruneMapTombstones(policy, T1, '2026-11-05T12:00:00.000Z').deletions).toHaveLength(1);
  });

  it('keeps an exact page tombstone apart from a prefix and refuses both at once (RV-08)', () => {
    const page = addMapTombstone(defaultMapPolicy(), { profile: 'browser-a', origin: O, path: '/account', at: T2 });
    const target = { profile: 'browser-a', origin: O, path: '/account', at: T1 };
    expect(tombstoneBlocks(page, target)).toBe(true);
    expect(tombstoneBlocks(page, { ...target, path: '/Account' })).toBe(true);
    expect(tombstoneBlocks(page, { ...target, path: '/account/edit' })).toBe(false);
    const both = addMapTombstone(defaultMapPolicy(), { profile: 'browser-a', origin: O, path: '/a', pathPrefix: '/a', at: T2 });
    fs.writeFileSync(path.join(dir.memoryDir, 'map-policy.json'), JSON.stringify(both), { mode: 0o600 });
    expect(codeOf(() => readMapPolicy(dir.memoryDir))).toBe('MEMORY_CORRUPT');
  });
});

describe('mapVerdict (R-04, AC-11, AC-34)', () => {
  const memoryOn = enablePolicy(defaultPolicy(), T0);
  const mapOn = enableMapProfile(defaultMapPolicy(), 'browser-a', T0);
  const target = { profile: 'browser-a', origin: O, path: '/account', at: T1 };

  it('is ok only when memory and the profile map are on', () => {
    expect(mapVerdict(memoryOn, mapOn, target)).toBe('ok');
    expect(mapVerdict(defaultPolicy(), mapOn, target)).toBe('disabled');
    expect(mapVerdict(memoryOn, defaultMapPolicy(), target)).toBe('disabled');
    expect(mapVerdict(memoryOn, mapOn, { ...target, profile: 'browser-b' })).toBe('disabled');
    expect(mapVerdict(memoryOn, mapOn, { ...target, at: '2026-10-28T08:00:00.000Z' })).toBe('disabled');
  });

  it('honours 003 exclusions, path prefixes (raw or masked) and tombstones', () => {
    expect(mapVerdict(excludeOrigin(memoryOn, O, T0), mapOn, target)).toBe('excluded');
    const prefixed = excludeMapPath(mapOn, O, '/acc', T0);
    expect(mapVerdict(memoryOn, prefixed, target)).toBe('ok');
    expect(mapVerdict(memoryOn, excludeMapPath(mapOn, O, '/account', T0), { ...target, path: '/account/x' })).toBe('excluded');
    expect(mapVerdict(memoryOn, excludeMapPath(mapOn, O, '/u/secret', T0), { profile: 'browser-a', origin: O, rawPath: '/u/secret', path: '/u/{n}', at: T1 })).toBe('excluded');
    expect(mapVerdict(recordDeletion(memoryOn, O, T2), mapOn, target)).toBe('deleted');
    expect(mapVerdict(memoryOn, addMapTombstone(mapOn, { profile: 'browser-a', origin: '*', at: T2 }), target)).toBe('deleted');
    // An older site delete does not hide a newer 003 delete-all (RV-12).
    expect(mapVerdict(recordDeletion(recordDeletion(memoryOn, O, T0), '*', T2), mapOn, target)).toBe('deleted');
  });

  it('applies a page tombstone at segment boundaries only, and only to older work', () => {
    const policy = addMapTombstone(mapOn, { profile: 'browser-a', origin: O, pathPrefix: '/account', at: T2 });
    expect(tombstoneBlocks(policy, target)).toBe(true);
    expect(tombstoneBlocks(policy, { ...target, path: '/accounts' })).toBe(false);
    expect(tombstoneBlocks(policy, { ...target, at: '2026-10-28T12:00:00.000Z' })).toBe(false);
  });
});
