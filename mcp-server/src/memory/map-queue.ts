/**
 * The site-map writer (specs/004-site-navigation-map research R-03): a bounded, single-writer queue between the
 * browser call path and the map store, with 003's contract. Groups are keyed by map file (profile and origin);
 * each commit reads once, re-checks the policy for every op, applies, bounds and writes once. Counter changes
 * from decided uses and lookups fold per profile into one counters write per drain round. Local only.
 */
import { COUNTER_FIELDS, type CounterField, type JsonMapStore, type MapCountersFile } from './map-store.js';
import { isPathExcluded, mapVerdict, readMapPolicy, tombstoneBlocks, type MapPolicy, type MapVerdict } from './map-policy.js';
import { emptyMapRecord, type MapRecord } from './map-record.js';
import { applyMapOp, enforceMapLimits, sanitizeRecord, viaChain, type ApplyResult, type MapRecordOp, type SanitizePolicy } from './map-reconcile.js';
import { MemoryPolicyError, readPolicy, type MemoryPolicy } from './policy.js';
import { MemoryStoreError } from './site-record.js';

export const MAX_MAP_PENDING_GROUPS = 256;
export const MAX_MAP_GROUP_ENTRIES = 64;
export const MAP_DEDUPE_ENTRIES = 1_024;
export const MAP_COMMIT_TIMEOUT_MS = 2_000;
const MAX_ESTIMATE_HOPS = 5;

export const MAP_DROP_REASONS = ['disabled', 'excluded', 'deleted', 'duplicate', 'queue_full', 'timeout', 'capacity', 'io_error', 'corrupt'] as const;
export type MapDropReason = (typeof MAP_DROP_REASONS)[number];

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
  commitTimeoutMs?: number;
  dedupeEntries?: number;
  onCommit?: (op: QueuedMapOp, result: ApplyResult) => void;
  onDrop?: (op: QueuedMapOp | MapCounterOp, reason: MapDropReason) => void;
  onDrained?: (drainedThrough: string) => void;
}

interface Group {
  key: string;
  profile: string;
  origin: string;
  ops: QueuedMapOp[];
}

const groupKey = (profile: string, origin: string): string => `${profile}\n${origin}`;

function storeDrop(error: unknown): MapDropReason {
  if (error instanceof MemoryStoreError || error instanceof MemoryPolicyError) {
    if (error.code === 'MEMORY_CORRUPT') return 'corrupt';
    if (error.code === 'MEMORY_FULL') return 'capacity';
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
  private readonly pending = new Map<string, Group>();
  private readonly pendingIds = new Set<string>();
  private readonly committedIds = new Map<string, true>();
  private readonly dropped = Object.fromEntries(MAP_DROP_REASONS.map((reason) => [reason, 0])) as Record<MapDropReason, number>;
  private readonly waiters: Array<() => void> = [];
  private counterOps: MapCounterOp[] = [];
  private current: { key: string; origin: string; done: Promise<void> } | null = null;
  private inFlightCount = 0;
  private running = false;
  private scheduled = false;
  private committed = 0;

  constructor(options: MapQueueOptions) {
    this.options = options;
    this.store = options.store;
    this.readMemory = options.readMemoryPolicy ?? (() => readPolicy(options.memoryDir));
    this.readMap = options.readMapPolicy ?? (() => readMapPolicy(options.memoryDir));
    this.now = options.now ?? Date.now;
    this.maxPending = options.maxPending ?? MAX_MAP_PENDING_GROUPS;
    this.commitTimeoutMs = options.commitTimeoutMs ?? MAP_COMMIT_TIMEOUT_MS;
    this.dedupeEntries = options.dedupeEntries ?? MAP_DEDUPE_ENTRIES;
  }

  /** Never waits and never throws. */
  enqueue(op: QueuedMapOp): { accepted: boolean; reason?: MapDropReason } {
    if (this.isDuplicate(op.opId)) return this.reject(op, 'duplicate');
    const key = groupKey(op.profile, op.origin);
    let group = this.pending.get(key);
    if (!group && key !== this.current?.key && this.heldGroups() >= this.maxPending) return this.reject(op, 'queue_full');
    group ??= { key, profile: op.profile, origin: op.origin, ops: [] };
    if (group.ops.length >= MAX_MAP_GROUP_ENTRIES) return this.reject(op, 'queue_full');
    group.ops.push(op);
    this.pending.set(key, group);
    this.pendingIds.add(op.opId);
    this.schedule();
    return { accepted: true };
  }

  /** Lookups and estimates (R-19). Folded per profile; written once per drain round. */
  count(op: MapCounterOp): void {
    if (this.isDuplicate(op.opId)) {
      this.dropCounter(op, 'duplicate');
      return;
    }
    if (this.counterOps.length >= this.dedupeEntries) {
      this.dropCounter(op, 'queue_full');
      return;
    }
    this.counterOps.push(op);
    this.pendingIds.add(op.opId);
    this.schedule();
  }

  dropPending(reason: MapDropReason, filter: (op: QueuedMapOp | MapCounterOp) => boolean = () => true): number {
    let count = 0;
    for (const [key, group] of this.pending) {
      group.ops = group.ops.filter((op) => {
        if (!filter(op)) return true;
        this.pendingIds.delete(op.opId);
        this.drop(op, reason);
        count += 1;
        return false;
      });
      if (group.ops.length === 0) this.pending.delete(key);
    }
    this.counterOps = this.counterOps.filter((op) => {
      if (!filter(op)) return true;
      this.pendingIds.delete(op.opId);
      this.drop(op, reason);
      count += 1;
      return false;
    });
    return count;
  }

  /** Resolves once the commit in flight for a matching origin has finished, bounded by the commit timeout. Never rejects. */
  settle(affects: (origin: string) => boolean = () => true, timeoutMs = this.commitTimeoutMs + 500): Promise<void> {
    const current = this.current;
    if (!current || !affects(current.origin)) return Promise.resolve();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const bound = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
      timer.unref?.();
    });
    return Promise.race([current.done, bound]).finally(() => clearTimeout(timer));
  }

  drain(): Promise<void> {
    if (!this.running && !this.scheduled) return Promise.resolve();
    return new Promise<void>((resolve) => this.waiters.push(resolve));
  }

  stats(): MapQueueStats {
    let pending = this.inFlightCount + this.counterOps.length;
    for (const group of this.pending.values()) pending += group.ops.length;
    return {
      pending,
      groups: this.heldGroups(),
      inFlight: this.current !== null,
      committed: this.committed,
      dropped: { ...this.dropped },
      maxPending: this.maxPending,
      commitTimeoutMs: this.commitTimeoutMs,
    };
  }

  private isDuplicate(opId: string): boolean {
    return this.committedIds.has(opId) || this.pendingIds.has(opId);
  }

  private reject(op: QueuedMapOp, reason: MapDropReason): { accepted: false; reason: MapDropReason } {
    this.drop(op, reason);
    return { accepted: false, reason };
  }

  private dropCounter(op: MapCounterOp, reason: MapDropReason): void {
    this.drop(op, reason);
  }

  private drop(op: QueuedMapOp | MapCounterOp, reason: MapDropReason): void {
    this.dropped[reason] += 1;
    try {
      this.options.onDrop?.(op, reason);
    } catch {
      // A reporting hook must not disturb the writer.
    }
  }

  private remember(opId: string): void {
    this.committedIds.delete(opId);
    this.committedIds.set(opId, true);
    while (this.committedIds.size > this.dedupeEntries) {
      const oldest = this.committedIds.keys().next().value;
      if (oldest === undefined) break;
      this.committedIds.delete(oldest);
    }
  }

  private heldGroups(): number {
    return this.pending.size + (this.current && !this.pending.has(this.current.key) ? 1 : 0);
  }

  private schedule(): void {
    if (!this.running && !this.scheduled) {
      this.scheduled = true;
      setImmediate(() => void this.pump());
    }
  }

  private async pump(): Promise<void> {
    this.scheduled = false;
    this.running = true;
    try {
      for (;;) {
        const next = this.pending.values().next();
        if (next.done) {
          if (this.counterOps.length === 0) break;
          await this.commitCounters(this.counterOps.splice(0));
          continue;
        }
        const group = next.value;
        this.pending.delete(group.key);
        for (const op of group.ops) this.pendingIds.delete(op.opId);
        this.inFlightCount = group.ops.length;
        const done = this.commit(group);
        this.current = { key: group.key, origin: group.origin, done };
        await done;
        this.current = null;
        this.inFlightCount = 0;
      }
    } finally {
      this.current = null;
      this.inFlightCount = 0;
      this.running = false;
    }
    try {
      this.options.onDrained?.(new Date(this.now()).toISOString());
    } catch {
      // Same as onDrop.
    }
    for (const resolve of this.waiters.splice(0)) resolve();
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
      return error instanceof MemoryPolicyError && error.code === 'MEMORY_CORRUPT' ? 'corrupt' : 'io_error';
    }
  }

  private async commit(group: Group): Promise<void> {
    const controller = new AbortController();
    const outcomes: Array<MapDropReason | null> = group.ops.map(() => 'timeout');
    const results: Array<ApplyResult | null> = group.ops.map(() => null);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve('timeout');
      }, this.commitTimeoutMs);
    });
    let record: MapRecord | null = null;
    const finished = await Promise.race([
      this.run(group, controller.signal, outcomes, results).then((written) => {
        record = written;
        return 'done' as const;
      }),
      timeout,
    ]);
    clearTimeout(timer);
    const settled = finished === 'timeout' ? [...outcomes] : outcomes;
    group.ops.forEach((op, index) => {
      const outcome = settled[index];
      if (outcome !== null) {
        this.drop(op, outcome);
        return;
      }
      this.committed += 1;
      this.remember(op.opId);
      const result = results[index];
      if (result && record) this.countUse(op, result, record);
      try {
        if (result) this.options.onCommit?.(op, result);
      } catch {
        // Same as onDrop.
      }
    });
  }

  /** Read once, apply what the policy allows, bound, write once. Returns the written record, or null. Never rejects. */
  private async run(group: Group, signal: AbortSignal, outcomes: Array<MapDropReason | null>, results: Array<ApplyResult | null>): Promise<MapRecord | null> {
    try {
      const policies = this.readPolicies();
      if (typeof policies === 'string') {
        outcomes.fill(policies);
        return null;
      }
      const allowed: number[] = [];
      group.ops.forEach((op, index) => {
        const blocked = this.verdict(op, policies.memory, policies.map);
        if (blocked) outcomes[index] = blocked;
        else allowed.push(index);
      });
      if (allowed.length === 0) return null;
      const existing = await this.store.getMap(group.profile, group.origin, { afterWrites: true });
      if (!existing && (await this.store.wouldRefuseNew(group.profile, group.origin))) {
        for (const index of allowed) outcomes[index] = 'capacity';
        return null;
      }
      const record = structuredClone(existing ?? emptyMapRecord(group.profile, group.origin, group.ops[allowed[0]].at));
      const applied: number[] = [];
      for (const index of allowed) {
        const op = group.ops[index];
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
      const stillBlocked = applied.map((index) => this.verdict(group.ops[index], recheck.memory, recheck.map));
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
  private countUse(op: QueuedMapOp, result: ApplyResult, record: MapRecord): void {
    if (!result.use) return;
    const base = { profile: op.profile, at: op.at };
    if (result.use === 'failed') {
      this.counterOps.push({ ...base, opId: `${op.opId}#uf`, field: 'usesFailed', delta: 1 });
      return;
    }
    this.counterOps.push({ ...base, opId: `${op.opId}#uw`, field: 'usesWorked', delta: 1 });
    if (!result.usedPath) return;
    if (result.usedKind === 'open') {
      const chain = viaChain(record, result.usedPath, MAX_ESTIMATE_HOPS);
      if (chain.length) {
        this.counterOps.push({ ...base, opId: `${op.opId}#ls`, field: 'loadsSavedEstimate', delta: chain.length });
        this.counterOps.push({ ...base, opId: `${op.opId}#cs`, field: 'charsSavedEstimate', delta: chain.reduce((sum, page) => sum + page.readChars, 0) });
      }
    } else {
      const page = record.pages.find((entry) => entry.path === result.usedPath);
      if (page?.readChars) this.counterOps.push({ ...base, opId: `${op.opId}#cs`, field: 'charsSavedEstimate', delta: page.readChars });
    }
  }

  private async commitCounters(ops: MapCounterOp[]): Promise<void> {
    for (const op of ops) this.pendingIds.delete(op.opId);
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
      for (const op of allowed) this.remember(op.opId);
    } catch (error) {
      const reason = storeDrop(error);
      for (const op of allowed) this.drop(op, reason);
    }
  }

  /** A delete-all for the profile (or for everyone) newer than the counter change. */
  private profileWiped(memory: MemoryPolicy, map: MapPolicy, op: MapCounterOp): boolean {
    const at = Date.parse(op.at);
    const everything = Object.hasOwn(memory.deletions, '*') ? memory.deletions['*'] : undefined;
    if (everything !== undefined && Date.parse(everything) >= at) return true;
    return map.deletions.some((entry) => entry.origin === '*' && entry.pathPrefix === undefined && entry.path === undefined && (entry.profile === '*' || entry.profile === op.profile) && Date.parse(entry.at) >= at);
  }
}
