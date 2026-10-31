/**
 * The site-map writer (specs/004-site-navigation-map research R-03): a bounded, single-writer queue between the
 * browser call path and the map store, with 003's contract. Groups are keyed by map file (profile and origin);
 * each commit reads once, re-checks the policy for every op, applies, bounds and writes once. Counter changes
 * from decided uses and lookups fold per profile into one counters write per drain round. Local only.
 *
 * The queue mechanics are the shared engine in `core/`; this module is the map profile of it: what an operation
 * is, how a group is keyed, what the two policies say and what a commit writes.
 */
import { COUNTER_FIELDS, type CounterField, type JsonMapStore, type MapCountersFile } from './map-store.js';
import { isPathExcluded, mapVerdict, readMapPolicy, tombstoneBlocks, type MapPolicy, type MapVerdict } from './map-policy.js';
import { emptyMapRecord, type MapRecord } from './map-record.js';
import { applyMapOp, enforceMapLimits, sanitizeRecord, viaChain, type ApplyResult, type MapRecordOp, type SanitizePolicy } from './map-reconcile.js';
import { MemoryPolicyError, readPolicy, type MemoryPolicy } from './policy.js';
import { MemoryStoreError } from './site-record.js';
import { ERROR_CODES } from '../core/error-codes.js';
import {
  BoundedQueue,
  COMMIT_TIMEOUT_MS,
  DEDUPE_ENTRIES,
  MAX_GROUP_ENTRIES,
  MAX_PENDING_OPERATIONS,
  QUEUE_DROP_REASONS,
  type QueueDropReason,
  type QueueGroup,
} from '../core/bounded-queue.js';

/** The map writer's own names for the shared bounds; the values are the engine's. */
export const MAX_MAP_PENDING_GROUPS = MAX_PENDING_OPERATIONS;
export const MAX_MAP_GROUP_ENTRIES = MAX_GROUP_ENTRIES;
export const MAP_DEDUPE_ENTRIES = DEDUPE_ENTRIES;
export const MAP_COMMIT_TIMEOUT_MS = COMMIT_TIMEOUT_MS;
const MAX_ESTIMATE_HOPS = 5;

export const MAP_DROP_REASONS = QUEUE_DROP_REASONS;
export type MapDropReason = QueueDropReason;

/** The same bounds under the shared names, so both writers read as one engine. */
export { MAX_PENDING_OPERATIONS, MAX_GROUP_ENTRIES, DEDUPE_ENTRIES, COMMIT_TIMEOUT_MS };
export const DROP_REASONS = QUEUE_DROP_REASONS;

/** An owner change (path exclusion, page delete) asks the writer to bring one map in line with the policy. */
export interface MapSanitizeOp {
  type: 'sanitize';
  opId: string;
  profile: string;
  origin: string;
  at: string;
}

/** A queued op: the record op plus the raw (unmasked) paths the exclusion check also tests (R-13). Never stored. */
export type QueuedMapOp = (MapRecordOp & { rawPaths?: string[] }) | (MapSanitizeOp & { rawPaths?: undefined });

export interface MapCounterOp {
  opId: string;
  profile: string;
  at: string;
  field: CounterField;
  delta: number;
}

export interface MapQueueStats {
  pending: number;
  groups: number;
  inFlight: boolean;
  committed: number;
  dropped: Record<MapDropReason, number>;
  maxPending: number;
  commitTimeoutMs: number;
}

export interface MapQueueOptions {
  store: JsonMapStore;
  memoryDir: string;
  readMemoryPolicy?: () => MemoryPolicy;
  readMapPolicy?: () => MapPolicy;
  now?: () => number;
  maxPending?: number;
  /** Bound on the operations one map file holds; the default is MAX_MAP_GROUP_ENTRIES. */
  maxGroupEntries?: number;
  commitTimeoutMs?: number;
  dedupeEntries?: number;
  onCommit?: (op: QueuedMapOp, result: ApplyResult) => void;
  onDrop?: (op: QueuedMapOp | MapCounterOp, reason: MapDropReason) => void;
  onDrained?: (drainedThrough: string) => void;
}

/** Everything held for one map file (profile and origin), in arrival order. */
interface MapGroup extends QueueGroup<QueuedMapOp> {
  profile: string;
}

const groupKey = (profile: string, origin: string): string => `${profile}\n${origin}`;

function storeDrop(error: unknown): MapDropReason {
  if (error instanceof MemoryStoreError || error instanceof MemoryPolicyError) {
    if (error.code === ERROR_CODES.MEMORY_CORRUPT) return 'corrupt';
    if (error.code === ERROR_CODES.MEMORY_FULL) return 'capacity';
  }
  return 'io_error';
}

const toDrop = (verdict: MapVerdict): MapDropReason | null => (verdict === 'ok' ? null : verdict);

/** The paths an op touches that a policy check must cover (masked and raw). */
function opPaths(op: MapRecordOp & { rawPaths?: string[] }): string[] {
  const own = op.type === 'read' ? op.path : op.type === 'click' ? op.fromPath : op.type === 'clickFailed' ? op.path : op.requestedPath;
  return [own, ...(op.rawPaths ?? [])];
}

/** The exclusions and tombstones that apply to one map file. */
export function sanitizePolicyFor(memory: MemoryPolicy, map: MapPolicy, profile: string, origin: string): SanitizePolicy {
  const tombstones: SanitizePolicy['tombstones'][number][] = map.deletions
    .filter((entry) => (entry.profile === '*' || entry.profile === profile) && (entry.origin === '*' || entry.origin === origin))
    .map((entry) => ({ ...(entry.pathPrefix !== undefined ? { pathPrefix: entry.pathPrefix } : {}), ...(entry.path !== undefined ? { path: entry.path } : {}), at: entry.at }));
  for (const key of [origin, '*']) {
    const at = Object.hasOwn(memory.deletions, key) ? memory.deletions[key] : undefined;
    if (at !== undefined) tombstones.push({ at });
  }
  return { excludedPrefixes: map.excludedPaths[origin] ?? [], tombstones, entranceBlocked: (source, path, at) => entranceBlocked(memory, map, profile, source, path, at) };
}

/**
 * An entrance names another site's page (specs/005-direct-site-routing FR-009): it goes when website memory excludes
 * that site, the map excludes the path, or a delete of that site or page is newer than the entrance.
 */
function entranceBlocked(memory: MemoryPolicy, map: MapPolicy, profile: string, origin: string, path: string, at: string): boolean {
  if (memory.excluded.includes(origin) || isPathExcluded(map, origin, path)) return true;
  const seen = Date.parse(at);
  for (const key of [origin, '*']) {
    const deleted = Object.hasOwn(memory.deletions, key) ? memory.deletions[key] : undefined;
    if (deleted !== undefined && Date.parse(deleted) >= seen) return true;
  }
  return tombstoneBlocks(map, { profile, origin, path, at });
}

export class MapQueue {
  private readonly options: MapQueueOptions;
  private readonly store: JsonMapStore;
  private readonly readMemory: () => MemoryPolicy;
  private readonly readMap: () => MapPolicy;
  private readonly now: () => number;
  private readonly maxPending: number;
  private readonly commitTimeoutMs: number;
  private readonly dedupeEntries: number;
  private readonly engine: BoundedQueue<QueuedMapOp, MapCounterOp, MapGroup, ApplyResult>;
  /** The record the last commit wrote; the decided uses in it feed the counters. */
  private lastRecord: MapRecord | null = null;

  constructor(options: MapQueueOptions) {
    this.options = options;
    this.store = options.store;
    this.readMemory = options.readMemoryPolicy ?? (() => readPolicy(options.memoryDir));
    this.readMap = options.readMapPolicy ?? (() => readMapPolicy(options.memoryDir));
    this.now = options.now ?? Date.now;
    this.maxPending = options.maxPending ?? MAX_MAP_PENDING_GROUPS;
    this.commitTimeoutMs = options.commitTimeoutMs ?? MAP_COMMIT_TIMEOUT_MS;
    this.dedupeEntries = options.dedupeEntries ?? MAP_DEDUPE_ENTRIES;
    this.engine = new BoundedQueue<QueuedMapOp, MapCounterOp, MapGroup, ApplyResult>({
      maxPending: this.maxPending,
      maxGroupEntries: options.maxGroupEntries ?? MAX_MAP_GROUP_ENTRIES,
      dedupeEntries: this.dedupeEntries,
      commitTimeoutMs: this.commitTimeoutMs,
      now: this.now,
      opId: (op) => op.opId,
      groupKey: (op) => groupKey(op.profile, op.origin),
      admit: (op, group) => ({
        group: group ?? { key: groupKey(op.profile, op.origin), profile: op.profile, origin: op.origin, entries: [], ids: 0 },
        entry: { op, count: 1, opIds: [] },
        added: true,
      }),
      members: (entry) => [entry.op],
      commitGroup: (group, signal, outcomes, results) => this.commitGroup(group, signal, outcomes, results),
      onCommitted: (op, result) => this.committed(op, result),
      onDrop: (op, reason) => this.options.onDrop?.(op, reason),
      onDrained: (through) => this.options.onDrained?.(through),
      side: { limit: this.dedupeEntries, commit: (ops) => this.commitCounters(ops) },
    });
  }

  /** Never waits and never throws. */
  enqueue(op: QueuedMapOp): { accepted: boolean; reason?: MapDropReason } {
    return this.engine.enqueue(op);
  }

  /** Lookups and estimates (R-19). Folded per profile; written once per drain round. */
  count(op: MapCounterOp): void {
    this.engine.enqueueSide(op);
  }

  dropPending(reason: MapDropReason, filter: (op: QueuedMapOp | MapCounterOp) => boolean = () => true): number {
    return this.engine.dropPending(reason, filter);
  }

  /** Resolves once the commit in flight for a matching origin has finished, bounded by the commit timeout. Never rejects. */
  settle(affects: (origin: string) => boolean = () => true, timeoutMs = this.commitTimeoutMs + 500): Promise<void> {
    return this.engine.settle(affects, timeoutMs);
  }

  drain(): Promise<void> {
    return this.engine.drain();
  }

  stats(): MapQueueStats {
    const stats = this.engine.stats();
    return {
      pending: stats.pending,
      groups: stats.groups,
      inFlight: stats.inFlight,
      committed: stats.committed,
      dropped: stats.dropped,
      maxPending: stats.maxPending,
      commitTimeoutMs: stats.commitTimeoutMs,
    };
  }

  /** The verdict for one op under both policies; a policy that cannot be read drops it. */
  private verdict(op: QueuedMapOp, memory: MemoryPolicy, map: MapPolicy): MapDropReason | null {
    // Owner changes always run: they only remove.
    if (op.type === 'sanitize') return null;
    const [own, ...raw] = opPaths(op);
    const masked = toDrop(mapVerdict(memory, map, { profile: op.profile, origin: op.origin, path: own, at: op.at }));
    if (masked) return masked;
    for (const rawPath of raw) {
      const blocked = toDrop(mapVerdict(memory, map, { profile: op.profile, origin: op.origin, rawPath, at: op.at }));
      if (blocked) return blocked;
    }
    return null;
  }

  /** A click or open whose landing path is now excluded or deleted keeps the use, not the path (R-13). */
  private guardTargets(op: MapRecordOp & { rawPaths?: string[] }, memory: MemoryPolicy, map: MapPolicy): MapRecordOp {
    if (op.type === 'click' && op.destination?.path !== undefined) {
      const verdict = mapVerdict(memory, map, { profile: op.profile, origin: op.origin, path: op.destination.path, at: op.at });
      if (verdict === 'excluded') return { ...op, destination: { excluded: true } };
      if (verdict === 'deleted') return { ...op, destination: null, undecided: true };
    }
    if (op.type === 'read' && op.entrance) {
      const { rawPath, ...entrance } = op.entrance;
      // The other site is checked as if this were its own observation: off, excluded or deleted drops the entrance (005 FR-009).
      const verdict = mapVerdict(memory, map, { profile: op.profile, origin: entrance.origin, path: entrance.path, ...(rawPath !== undefined ? { rawPath } : {}), at: op.at });
      const { entrance: _dropped, ...rest } = op;
      return verdict === 'ok' ? { ...rest, entrance } : rest;
    }
    if (op.type === 'open' && op.landingPath !== undefined) {
      const verdict = mapVerdict(memory, map, { profile: op.profile, origin: op.origin, path: op.landingPath, at: op.at });
      if (verdict !== 'ok') {
        const { landingPath: _dropped, ...rest } = op;
        return rest;
      }
    }
    return op;
  }

  private readPolicies(): { memory: MemoryPolicy; map: MapPolicy } | MapDropReason {
    try {
      return { memory: this.readMemory(), map: this.readMap() };
    } catch (error) {
      return error instanceof MemoryPolicyError && error.code === ERROR_CODES.MEMORY_CORRUPT ? 'corrupt' : 'io_error';
    }
  }

  /** Read once, apply what the policy allows, bound, write once. Fills the outcomes and the results; never rejects. */
  private async commitGroup(group: MapGroup, signal: AbortSignal, outcomes: Array<MapDropReason | null>, results: Array<ApplyResult | null>): Promise<void> {
    this.lastRecord = await this.run(group, signal, outcomes, results);
  }

  private async run(group: MapGroup, signal: AbortSignal, outcomes: Array<MapDropReason | null>, results: Array<ApplyResult | null>): Promise<MapRecord | null> {
    try {
      const policies = this.readPolicies();
      if (typeof policies === 'string') {
        outcomes.fill(policies);
        return null;
      }
      const allowed: number[] = [];
      group.entries.forEach((entry, index) => {
        const blocked = this.verdict(entry.op, policies.memory, policies.map);
        if (blocked) outcomes[index] = blocked;
        else allowed.push(index);
      });
      if (allowed.length === 0) return null;
      const existing = await this.store.getMap(group.profile, group.origin, { afterWrites: true });
      if (!existing && (await this.store.wouldRefuseNew(group.profile, group.origin))) {
        for (const index of allowed) outcomes[index] = 'capacity';
        return null;
      }
      const record = structuredClone(existing ?? emptyMapRecord(group.profile, group.origin, group.entries[allowed[0]].op.at));
      const applied: number[] = [];
      for (const index of allowed) {
        const op = group.entries[index].op;
        results[index] = op.type === 'sanitize' ? { changed: false, use: null, usedPath: null, usedKind: null } : applyMapOp(record, this.guardTargets(op, policies.memory, policies.map));
        applied.push(index);
      }
      sanitizeRecord(record, sanitizePolicyFor(policies.memory, policies.map, group.profile, group.origin));
      if (record.pages.length === 0 && !record.entrances?.length) {
        // Nothing structural is left (or was ever observed): no file for this pair.
        if (existing) await this.store.deleteMap(group.profile, group.origin);
        for (const index of applied) outcomes[index] = null;
        return null;
      }
      enforceMapLimits(record, this.store.fileByteLimit);
      record.commitSeq += 1;
      record.updatedAt = new Date(this.now()).toISOString();
      if (signal.aborted) return null;
      // A policy change that landed mid-commit drops the whole write; the ops are retried by nobody (they are hints).
      const recheck = this.readPolicies();
      if (typeof recheck === 'string') {
        for (const index of applied) outcomes[index] = recheck;
        return null;
      }
      const stillBlocked = applied.map((index) => this.verdict(group.entries[index].op, recheck.memory, recheck.map));
      if (stillBlocked.some((reason) => reason !== null)) {
        applied.forEach((index, position) => {
          outcomes[index] = stillBlocked[position] ?? 'deleted';
        });
        return null;
      }
      // An owner change that landed during the apply is honoured before the write.
      sanitizeRecord(record, sanitizePolicyFor(recheck.memory, recheck.map, group.profile, group.origin));
      if (record.pages.length === 0 && !record.entrances?.length) {
        if (existing) await this.store.deleteMap(group.profile, group.origin);
        for (const index of applied) outcomes[index] = null;
        return null;
      }
      try {
        await this.store.putMap(record, { signal });
      } catch (error) {
        if (signal.aborted) return null;
        const reason = storeDrop(error);
        for (const index of applied) outcomes[index] = reason;
        return null;
      }
      for (const index of applied) outcomes[index] = null;
      return record;
    } catch (error) {
      const reason = storeDrop(error);
      outcomes.forEach((outcome, index) => {
        if (outcome === 'timeout') outcomes[index] = reason;
      });
      return null;
    }
  }

  /** Decided uses feed the counters (R-19): exact counts, plus the labeled estimates from the `via` chain. */
  private committed(op: QueuedMapOp, result: ApplyResult | null): void {
    if (!result) return;
    if (this.lastRecord) this.countUse(op, result, this.lastRecord);
    this.options.onCommit?.(op, result);
  }

  private countUse(op: QueuedMapOp, result: ApplyResult, record: MapRecord): void {
    if (!result.use) return;
    const base = { profile: op.profile, at: op.at };
    if (result.use === 'failed') {
      this.countCounter({ ...base, opId: `${op.opId}#uf`, field: 'usesFailed', delta: 1 });
      return;
    }
    this.countCounter({ ...base, opId: `${op.opId}#uw`, field: 'usesWorked', delta: 1 });
    if (!result.usedPath) return;
    if (result.usedKind === 'open') {
      const chain = viaChain(record, result.usedPath, MAX_ESTIMATE_HOPS);
      if (chain.length) {
        this.countCounter({ ...base, opId: `${op.opId}#ls`, field: 'loadsSavedEstimate', delta: chain.length });
        this.countCounter({ ...base, opId: `${op.opId}#cs`, field: 'charsSavedEstimate', delta: chain.reduce((sum, page) => sum + page.readChars, 0) });
      }
    } else {
      const page = record.pages.find((entry) => entry.path === result.usedPath);
      if (page?.readChars) this.countCounter({ ...base, opId: `${op.opId}#cs`, field: 'charsSavedEstimate', delta: page.readChars });
    }
  }

  /** A decided use adds a counter change; it is written with the counters, once per drain round. */
  private countCounter(op: MapCounterOp): void {
    this.engine.pushSide(op);
  }

  private async commitCounters(ops: MapCounterOp[]): Promise<void> {
    const policies = this.readPolicies();
    if (typeof policies === 'string') {
      for (const op of ops) this.drop(op, policies);
      return;
    }
    const allowed = ops.filter((op) => {
      const state = policies.map.profiles[op.profile];
      const blocked: MapDropReason | null = !policies.memory.enabled || !state?.enabled ? 'disabled' : this.profileWiped(policies.memory, policies.map, op) ? 'deleted' : null;
      if (blocked) this.drop(op, blocked);
      return !blocked;
    });
    if (allowed.length === 0) return;
    let counters: MapCountersFile;
    try {
      counters = await this.store.getCounters();
    } catch (error) {
      // An unreadable file is not an empty one: writing now would zero every profile's counters.
      const reason = storeDrop(error);
      for (const op of allowed) this.drop(op, reason);
      return;
    }
    for (const op of allowed) {
      const entry = counters.profiles[op.profile] ?? { ...Object.fromEntries(COUNTER_FIELDS.map((field) => [field, 0])), since: op.at };
      entry[op.field] = Math.min(Number.MAX_SAFE_INTEGER, entry[op.field] + Math.max(0, Math.floor(op.delta)));
      counters.profiles[op.profile] = entry as MapCountersFile['profiles'][string];
    }
    try {
      await this.store.putCounters(counters);
      for (const op of allowed) this.engine.rememberCommitted(op.opId);
    } catch (error) {
      const reason = storeDrop(error);
      for (const op of allowed) this.drop(op, reason);
    }
  }

  private drop(op: QueuedMapOp | MapCounterOp, reason: MapDropReason): void {
    this.engine.countDrop(op, reason);
  }

  /** A delete-all for the profile (or for everyone) newer than the counter change. */
  private profileWiped(memory: MemoryPolicy, map: MapPolicy, op: MapCounterOp): boolean {
    const at = Date.parse(op.at);
    const everything = Object.hasOwn(memory.deletions, '*') ? memory.deletions['*'] : undefined;
    if (everything !== undefined && Date.parse(everything) >= at) return true;
    return map.deletions.some((entry) => entry.origin === '*' && entry.pathPrefix === undefined && entry.path === undefined && (entry.profile === '*' || entry.profile === op.profile) && Date.parse(entry.at) >= at);
  }
}
