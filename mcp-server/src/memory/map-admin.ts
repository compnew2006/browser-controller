/**
 * Owner commands for the site map (specs/004-site-navigation-map research R-05, R-20, R-21): the `map` sub-command
 * of `memory-admin`, and the map side of 003's site delete and delete-all. A command answers only after its policy
 * change is on disk and the queued or in-flight work it affects is dropped, settled or rewritten, so nothing it
 * removed comes back from the queue.
 */
import { randomUUID } from 'node:crypto';
import type { MapAdminProfileStatus, MapAdminRequest, MemoryAdminResult } from '../daemon-config.js';
import { addMapTombstone, disableMapProfile, enableMapProfile, excludeMapPath, includeMapPath, readMapPolicy, type MapTombstone } from './map-policy.js';
import type { MapRecord } from './map-record.js';
import type { MapCounters, MapCountersFile } from './map-store.js';
import { mapErrorCode, type MapService } from './map-service.js';
import { canonicalPagePath, canonicalPrefix } from './map-text.js';
import { MemoryPolicyError, canonicalOrigin } from './policy.js';
import { MemoryStoreError } from './site-record.js';

/**
 * Profiles that may hold maps: the policy's entries (disable keeps them) and the profiles of the stored records,
 * which a reset of an unreadable policy no longer lists (RV-06).
 */
export async function knownMapProfiles(map: MapService): Promise<string[]> {
  let listed: string[] = [];
  try {
    listed = Object.keys(readMapPolicy(map.memoryDir).profiles);
  } catch {
    // The stored records still name every profile.
  }
  return [...new Set([...listed, ...(await map.store.listMaps()).map((record) => record.profile)])];
}

/** 003 `delete <origin>` and `delete --all` also delete maps (R-05). 003's own tombstone already blocks queued map work. */
export async function deleteMapsWithMemory(map: MapService, key: string): Promise<void> {
  const affects = (origin: string): boolean => key === '*' || origin === key;
  map.queue.dropPending('deleted', (op) => key === '*' || ('origin' in op && op.origin === key));
  await map.queue.settle(affects);
  if (key === '*') {
    await map.store.deleteAll();
  } else {
    const profiles = await knownMapProfiles(map);
    await map.store.deleteOrigin(key, profiles);
    await scrubEntrances(map, key, profiles, map.iso());
  }
  map.invalidate();
}

function requireOrigin(value: string | undefined): string {
  const origin = value === undefined ? null : canonicalOrigin(value);
  if (!origin) throw new MemoryPolicyError('INVALID_ARGUMENT', 'origin must be an http or https origin');
  return origin;
}

function requirePagePath(value: string | undefined): string {
  const pagePath = canonicalPagePath(value);
  if (!pagePath) throw new MemoryPolicyError('INVALID_ARGUMENT', 'path must start with "/" and must have no query or fragment');
  return pagePath;
}

function requirePrefix(value: string | undefined): string {
  const prefix = canonicalPrefix(value);
  if (!prefix) throw new MemoryPolicyError('INVALID_ARGUMENT', 'path must start with "/", must not be "/", and must have no query or fragment');
  return prefix;
}

function oldestDate(records: readonly MapRecord[]): string | null {
  let oldest: string | null = null;
  for (const record of records) for (const page of record.pages) if (oldest === null || page.firstSeenAt < oldest) oldest = page.firstSeenAt;
  return oldest ? oldest.slice(0, 10) : null;
}

/**
 * Per profile: counts and a date only, never origins, paths, titles or names (R-21, SC-004). A counters file that
 * cannot be read gives no counters and its code in `mapCountersError`, so it does not block the command.
 */
export async function mapProfileStatus(map: MapService, browser?: string): Promise<Pick<MemoryAdminResult, 'mapStatus' | 'mapCountersError'>> {
  let profiles: Record<string, { enabled: boolean }> = {};
  try {
    profiles = readMapPolicy(map.memoryDir).profiles;
  } catch (error) {
    map.noteError(mapErrorCode(error));
  }
  let counters: Record<string, MapCounters> = {};
  let countersError: string | undefined;
  try {
    counters = (await map.store.getCounters()).profiles;
  } catch (error) {
    countersError = mapErrorCode(error);
    map.noteError(countersError);
  }
  const ids = browser !== undefined ? [browser] : [...new Set([...Object.keys(profiles), ...Object.keys(counters)])].sort();
  const status: Record<string, MapAdminProfileStatus> = {};
  for (const id of ids) {
    const usage = await map.store.profileUsage(id);
    status[id] = {
      enabled: profiles[id]?.enabled === true,
      files: usage.files,
      bytes: usage.bytes,
      oldestEntryDate: usage.files ? oldestDate(await map.store.listMaps(id)) : null,
      quarantined: usage.quarantined,
      dropped: map.droppedFor(id),
      counters: counters[id] ?? null,
    };
  }
  return { mapStatus: status, ...(countersError ? { mapCountersError: countersError } : {}) };
}

/**
 * Bring each listed map file in line with the policy now, through the one writer. When a rewrite did not land, the
 * command fails: the change is saved and reads already apply it, but the file still holds the entries until the next
 * commit to it (RV-06).
 */
async function sanitizeMaps(map: MapService, files: ReadonlyArray<{ profile: string; origin: string }>, at: string): Promise<void> {
  if (files.length === 0) return;
  for (const { profile, origin } of files) map.queue.enqueue({ type: 'sanitize', opId: `sanitize-${randomUUID()}`, profile, origin, at });
  await map.queue.drain();
  for (const { profile, origin } of files) {
    const record = await map.store.getMap(profile, origin, { afterWrites: true });
    if (record && map.applyPolicy(record)) {
      throw new MemoryStoreError('MEMORY_UNAVAILABLE', 'the change is saved and lookups no longer show the entries, but the map file could not be rewritten yet; run the command again');
    }
  }
}

const sanitizeNow = (map: MapService, origin: string, profiles: readonly string[], at: string): Promise<void> =>
  sanitizeMaps(map, profiles.map((profile) => ({ profile, origin })), at);

/**
 * Entrances on other sites' maps that name `source` (specs/005-direct-site-routing FR-009). Reads already hide them
 * once the delete or exclusion is saved; the rewrite keeps a pruned tombstone from bringing one back.
 */
async function scrubEntrances(map: MapService, source: string, profiles: readonly string[], at: string): Promise<void> {
  const files = (await map.store.listMaps())
    .filter((record) => profiles.includes(record.profile) && record.origin !== source && record.entrances?.some((entry) => entry.origin === source))
    .map((record) => ({ profile: record.profile, origin: record.origin }));
  await sanitizeMaps(map, files, at);
}

/** Called once the profile's maps are deleted: a counters file that cannot be read keeps its entry, and the result reports why. */
async function resetCounters(map: MapService, profile: string): Promise<void> {
  let file: MapCountersFile;
  try {
    file = await map.store.getCounters();
  } catch (error) {
    map.noteError(mapErrorCode(error));
    return;
  }
  if (!Object.hasOwn(file.profiles, profile)) return;
  const profiles = { ...file.profiles };
  delete profiles[profile];
  await map.store.putCounters({ ...file, profiles });
}

async function deleteMaps(map: MapService, request: MapAdminRequest, at: string): Promise<void> {
  const profile = request.browser;
  if (request.all === true) {
    const tombstone: MapTombstone = { profile: profile ?? '*', origin: '*', at };
    await map.mutateMapPolicy((policy) => addMapTombstone(policy, tombstone), { resetCorrupt: profile === undefined });
    map.queue.dropPending('deleted', (op) => profile === undefined || op.profile === profile);
    await map.queue.settle();
    if (profile === undefined) {
      await map.store.deleteAll();
    } else {
      await map.store.deleteProfile(profile);
      await resetCounters(map, profile);
    }
    return;
  }
  const origin = requireOrigin(request.origin);
  const pagePath = request.path === undefined ? undefined : requirePagePath(request.path);
  const profiles = profile !== undefined ? [profile] : await knownMapProfiles(map);
  // Exactly that page entry and its controls go; pages under it stay (AC-16). Exclusions remove a subtree.
  await map.mutateMapPolicy((policy) => addMapTombstone(policy, { profile: profile ?? '*', origin, ...(pagePath !== undefined ? { path: pagePath } : {}), at }));
  if (pagePath !== undefined) {
    await sanitizeNow(map, origin, profiles, at);
    await scrubEntrances(map, origin, profiles, at);
    return;
  }
  map.queue.dropPending('deleted', (op) => 'origin' in op && op.origin === origin && (profile === undefined || op.profile === profile));
  await map.queue.settle((inFlight) => inFlight === origin);
  await map.store.deleteOrigin(origin, profiles);
  await scrubEntrances(map, origin, profiles, at);
}

async function inspect(map: MapService, request: MapAdminRequest): Promise<MapRecord[]> {
  const origin = requireOrigin(request.origin);
  const records: MapRecord[] = [];
  for (const profile of request.browser !== undefined ? [request.browser] : await knownMapProfiles(map)) {
    try {
      const record = await map.store.getMap(profile, origin, { afterWrites: true });
      if (record) {
        map.applyPolicy(record);
        records.push(record);
      }
    } catch (error) {
      if (!(error instanceof MemoryStoreError) || error.code !== 'MEMORY_CORRUPT') throw error;
    }
  }
  return records;
}

/**
 * `memory-admin {command: "map", map: {...}}`. An unreadable map policy blocks every change except `disable` and
 * `delete --all` (every profile), which set it aside and start from the default; the refusal names them.
 */
export async function runMapAdmin(map: MapService, id: string, request: MapAdminRequest): Promise<MemoryAdminResult> {
  const done = async (extra: Partial<MemoryAdminResult> = {}): Promise<MemoryAdminResult> => ({ kind: 'memory-admin-result', id, success: true, ...(await mapProfileStatus(map, request.browser)), ...extra });
  try {
    const at = map.iso();
    switch (request.command) {
      case 'status':
        return await done();
      case 'enable':
        await map.mutateMapPolicy((policy) => enableMapProfile(policy, request.browser as string, at));
        return await done();
      case 'disable': {
        const profile = request.browser as string;
        await map.mutateMapPolicy((policy) => disableMapProfile(policy, profile, at), { resetCorrupt: true });
        map.queue.dropPending('disabled', (op) => op.profile === profile);
        await map.queue.settle();
        return await done();
      }
      case 'exclude-path': {
        const origin = requireOrigin(request.origin);
        const prefix = requirePrefix(request.path);
        await map.mutateMapPolicy((policy) => addMapTombstone(excludeMapPath(policy, origin, prefix, at), { profile: '*', origin, pathPrefix: prefix, at }));
        const profiles = await knownMapProfiles(map);
        await sanitizeNow(map, origin, profiles, at);
        await scrubEntrances(map, origin, profiles, at);
        return await done();
      }
      case 'include-path': {
        const origin = requireOrigin(request.origin);
        const prefix = requirePrefix(request.path);
        await map.mutateMapPolicy((policy) => includeMapPath(policy, origin, prefix, at));
        return await done();
      }
      case 'inspect':
        return { kind: 'memory-admin-result', id, success: true, records: await inspect(map, request) };
      case 'export': {
        const records = await map.store.listMaps(request.browser);
        for (const record of records) map.applyPolicy(record);
        return await done({ records });
      }
      case 'delete':
        await deleteMaps(map, request, at);
        return await done();
    }
  } catch (error) {
    const code = mapErrorCode(error);
    let message = error instanceof MemoryPolicyError || error instanceof MemoryStoreError ? error.message : 'map operation failed';
    if (error instanceof MemoryPolicyError && code === 'MEMORY_CORRUPT') message += '; run "map disable" or "map delete --all" to reset the map';
    return { kind: 'memory-admin-result', id, success: false, error: `${code}: ${message}` };
  }
}
