import type { CandidateFact } from './allowlist.js';
import { MemoryPolicyError, readPolicy as readPolicyFile, type MemoryPolicy } from './policy.js';
import { applyOp, canonicalValue, earlier, later } from './reconcile.js';
import { MemoryStoreError, type MemoryStore, type ProfileVerification } from './store.js';

export { applyOp };

/**
 * Bound on the distinct origins the queue holds (waiting plus the one being committed). Operations for an origin
 * that is already held fold into it (see `enqueue`), so a burst on one site never fills the queue; only a new origin
 * arriving at the bound is dropped as `queue_full`.
 */
export const MAX_PENDING_OPERATIONS = 256;
/** Bound on the folded entries one origin holds (one visit tally per profile, plus fact observations that cannot fold). */
export const MAX_GROUP_ENTRIES = 64;
export const DEDUPE_ENTRIES = 1_024;
export const COMMIT_TIMEOUT_MS = 2_000;

export const DROP_REASONS = ['disabled', 'excluded', 'deleted', 'duplicate', 'queue_full', 'timeout', 'capacity', 'io_error', 'corrupt'] as const;
export type DropReason = (typeof DROP_REASONS)[number];

/** One capture waiting to be committed. `opId` is the daemon call id. */
export interface CaptureOp {
  opId: string;
  type: 'visit' | 'facts' | 'hidden';
  /** Verified `browserId` of the observing profile. */
  profileId: string;
  /** Canonical origin. */
  origin: string;
  /** Time of the browser outcome. */
  at: string;
  /** Candidates already filtered by the allowlist; used when `type` is `facts`. */
  facts: CandidateFact[];
  /** Page path and source tool for the verification; used when `type` is `facts`. */
  path?: string;
  tool?: ProfileVerification['tool'];
  /** When the operation entered the queue; compared with `enabledAt` and deletion tombstones at commit. */
  enqueuedAt: string;
  /** Set by the queue when operations fold: the earliest `at` among them (`at` is the latest). */
  firstAt?: string;
  /** Set by the queue when operations fold: how many operations (visits, hidden-control failures, or identical observations) this one stands for. */
  count?: number;
}

export type EnqueueResult = { accepted: true } | { accepted: false; reason: 'queue_full' | 'duplicate'; code?: 'MEMORY_QUEUE_FULL' };

export interface QueueStats {
  /** Operations held: waiting ones plus those being committed, counted before folding. */
  pending: number;
  /** Distinct origins held, bounded by `maxPending`. */
  groups: number;
  /** Largest number of folded entries one held origin has, bounded by MAX_GROUP_ENTRIES. */
  maxGroupEntries: number;
  inFlight: boolean;
  committed: number;
  dropped: Record<DropReason, number>;
  /** Bound on distinct origins held. */
  maxPending: number;
  commitTimeoutMs: number;
}

export interface MemoryQueueOptions {
  store: MemoryStore;
  memoryDir: string;
  /** Test seam; the default reads `<memoryDir>/policy.json` on every call. */
  readPolicy?: () => MemoryPolicy;
  now?: () => number;
  maxPending?: number;
  commitTimeoutMs?: number;
  dedupeEntries?: number;
  onCommit?: (op: CaptureOp) => void;
  onDrop?: (op: CaptureOp, reason: DropReason) => void;
  /** Called with the time the queue emptied, so the owner of the policy can prune tombstones older than it. */
  onDrained?: (drainedThrough: string) => void;
}

/** Why an operation enqueued at `enqueuedAt` for `origin` must not commit under `policy`, or null. */
function policyVerdict(policy: MemoryPolicy, origin: string, enqueuedAt: string): DropReason | null {
  const queuedAt = Date.parse(enqueuedAt);
  if (!policy.enabled || !policy.enabledAt || queuedAt < Date.parse(policy.enabledAt)) return 'disabled';
  if (policy.excluded.includes(origin)) return 'excluded';
  for (const key of [origin, '*']) {
    const deletedAt = Object.hasOwn(policy.deletions, key) ? policy.deletions[key] : undefined;
    if (deletedAt !== undefined && queuedAt <= Date.parse(deletedAt)) return 'deleted';
  }
  return null;
}

function mapStoreError(error: unknown): DropReason {
  if (error instanceof MemoryStoreError) {
    if (error.code === 'MEMORY_CORRUPT') return 'corrupt';
    if (error.code === 'MEMORY_FULL') return 'capacity';
  }
  return 'io_error';
}


/** Operations folded into one: `op` carries the merged values, `count` how many operations it stands for. */
interface QueuedEntry {
  op: CaptureOp;
  count: number;
  /** Ids remembered for dedupe; at most DEDUPE_ENTRIES per origin. */
  opIds: string[];
  /** Facts entries: candidate values by factId, used to decide whether a later operation may fold. */
  values: Map<string, string> | null;
  /** Facts entries: identity of the candidate set, the profile and whether it verifies. */
  key: string | null;
  /** Latest `enqueuedAt` folded in (`op.enqueuedAt` is the earliest). */
  lastEnqueuedAt: string;
}

/** Everything held for one origin, in arrival order. */
interface OriginGroup {
  origin: string;
  entries: QueuedEntry[];
  /** Ids remembered across the entries. */
  ids: number;
}

function factsValues(op: CaptureOp): Map<string, string> {
  return new Map(op.facts.map((candidate) => [candidate.factId, canonicalValue(candidate.value)]));
}

function factsKey(op: CaptureOp, values: Map<string, string>): string {
  const sorted = [...values.entries()].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return JSON.stringify([op.profileId, op.tool !== undefined, sorted]);
}

/** True when the two candidate sets disagree on the value of a shared fact, so their order matters. */
function conflicts(a: Map<string, string>, b: Map<string, string>): boolean {
  for (const [factId, value] of a) {
    const other = b.get(factId);
    if (other !== undefined && other !== value) return true;
  }
  return false;
}

/**
 * A bounded, single-writer queue between the browser call path and the store
 * (R-03). `enqueue` never waits and never throws; commits run one at a time
 * after the call that produced them, and each one re-reads the policy, so a
 * disable, exclusion or deletion also covers work that was already queued
 * (AC-11). A commit that runs longer than the timeout is abandoned: its
 * signal is aborted, so the store removes the temp file instead of renaming it.
 * An abandoned write that had already reached the rename may still land; it is
 * reported as `timeout`, never as committed. Local only.
 *
 * Operations fold per origin as they arrive: visits of one profile become one
 * tally, and a fact observation folds into an earlier identical one (same
 * profile, same candidate values) unless a later entry disagrees with it on a
 * shared fact. The bound is on distinct origins held, so memory stays bounded
 * by MAX_PENDING_OPERATIONS × MAX_GROUP_ENTRIES entries while a burst on one
 * origin is never dropped. Counters stay per operation.
 */
export class MemoryQueue {
  private readonly store: MemoryStore;
  private readonly readPolicy: () => MemoryPolicy;
  private readonly now: () => number;
  private readonly maxPending: number;
  private readonly commitTimeoutMs: number;
  private readonly dedupeEntries: number;
  private readonly options: MemoryQueueOptions;
  /** Waiting work by origin; Map order is arrival order of each origin's first operation. */
  private readonly pending = new Map<string, OriginGroup>();
  private readonly pendingIds = new Set<string>();
  private readonly inFlightIds = new Set<string>();
  private readonly committedIds = new Map<string, true>();
  private readonly dropped = Object.fromEntries(DROP_REASONS.map((reason) => [reason, 0])) as Record<DropReason, number>;
  private readonly waiters: Array<() => void> = [];
  private inFlight: QueuedEntry[] = [];
  private current: { origin: string; done: Promise<void> } | null = null;
  private running = false;
  private scheduled = false;
  private committed = 0;

  constructor(options: MemoryQueueOptions) {
    this.options = options;
    this.store = options.store;
    this.readPolicy = options.readPolicy ?? (() => readPolicyFile(options.memoryDir));
    this.now = options.now ?? Date.now;
    this.maxPending = options.maxPending ?? MAX_PENDING_OPERATIONS;
    this.commitTimeoutMs = options.commitTimeoutMs ?? COMMIT_TIMEOUT_MS;
    this.dedupeEntries = options.dedupeEntries ?? DEDUPE_ENTRIES;
  }

  enqueue(op: CaptureOp): EnqueueResult {
    if (this.committedIds.has(op.opId) || this.pendingIds.has(op.opId) || this.inFlightIds.has(op.opId)) {
      this.dropOne(op, 'duplicate');
      return { accepted: false, reason: 'duplicate' };
    }
    let group = this.pending.get(op.origin);
    if (!group && op.origin !== this.current?.origin && this.heldOrigins() >= this.maxPending) {
      this.dropOne(op, 'queue_full');
      return { accepted: false, reason: 'queue_full', code: 'MEMORY_QUEUE_FULL' };
    }
    group ??= { origin: op.origin, entries: [], ids: 0 };
    const entry = this.foldTarget(group, op, this.foldPolicy());
    if (!entry && group.entries.length >= MAX_GROUP_ENTRIES) {
      this.dropOne(op, 'queue_full');
      return { accepted: false, reason: 'queue_full', code: 'MEMORY_QUEUE_FULL' };
    }
    const target = entry ?? this.newEntry(op);
    if (entry) this.fold(entry, op);
    else group.entries.push(target);
    if (group.ids < this.dedupeEntries) {
      target.opIds.push(op.opId);
      this.pendingIds.add(op.opId);
      group.ids += 1;
    }
    this.pending.set(op.origin, group);
    if (!this.running && !this.scheduled) {
      this.scheduled = true;
      setImmediate(() => void this.pump());
    }
    return { accepted: true };
  }

  /** Drop queued operations that have not started (all of them without a filter). The operation being committed is checked against the policy again just before its write. */
  dropPending(reason: DropReason, filter: (op: CaptureOp) => boolean = () => true): number {
    let count = 0;
    for (const [origin, group] of this.pending) {
      group.entries = group.entries.filter((entry) => {
        if (!filter(entry.op)) return true;
        for (const id of entry.opIds) this.pendingIds.delete(id);
        group.ids -= entry.opIds.length;
        this.dropEntry(entry, reason);
        count += entry.count;
        return false;
      });
      if (group.entries.length === 0) this.pending.delete(origin);
    }
    return count;
  }

  /**
   * Resolves once the commit now in flight has finished, when `affects` matches its origin, and at most after
   * `timeoutMs` (default: the commit timeout plus a margin). Queued work is not waited for: the caller drops what
   * it must, and every later commit re-reads the policy before it writes. Never rejects.
   */
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

  /** Resolves when nothing is queued or being committed. Never rejects. */
  drain(): Promise<void> {
    if (!this.running && !this.scheduled) return Promise.resolve();
    return new Promise<void>((resolve) => this.waiters.push(resolve));
  }

  stats(): QueueStats {
    let pending = 0;
    let maxGroupEntries = this.inFlight.length;
    for (const entry of this.inFlight) pending += entry.count;
    for (const group of this.pending.values()) {
      maxGroupEntries = Math.max(maxGroupEntries, group.entries.length);
      for (const entry of group.entries) pending += entry.count;
    }
    return {
      pending,
      groups: this.heldOrigins(),
      maxGroupEntries,
      inFlight: this.inFlight.length > 0,
      committed: this.committed,
      dropped: { ...this.dropped },
      maxPending: this.maxPending,
      commitTimeoutMs: this.commitTimeoutMs,
    };
  }

  private heldOrigins(): number {
    return this.pending.size + (this.current && !this.pending.has(this.current.origin) ? 1 : 0);
  }

  private newEntry(op: CaptureOp): QueuedEntry {
    const values = op.type === 'facts' ? factsValues(op) : null;
    return { op: { ...op }, count: 1, opIds: [], values, key: values ? factsKey(op, values) : null, lastEnqueuedAt: op.enqueuedAt };
  }

  /** A lazy, once-per-enqueue policy read for fold decisions; null when the policy cannot be read. */
  private foldPolicy(): () => MemoryPolicy | null {
    let read = false;
    let policy: MemoryPolicy | null = null;
    return () => {
      if (!read) {
        read = true;
        try {
          policy = this.readPolicy();
        } catch {
          policy = null;
        }
      }
      return policy;
    };
  }

  /**
   * Folding must not merge operations that a policy boundary already in force (enabledAt, a tombstone) separates,
   * since a folded entry is judged once, by its earliest enqueue. A boundary set later lies after all of them.
   */
  private sameVerdict(entry: QueuedEntry, op: CaptureOp, policy: () => MemoryPolicy | null): boolean {
    if (entry.op.enqueuedAt === op.enqueuedAt && entry.lastEnqueuedAt === op.enqueuedAt) return true;
    const current = policy();
    if (!current) return false;
    const verdict = policyVerdict(current, op.origin, op.enqueuedAt);
    return policyVerdict(current, op.origin, entry.op.enqueuedAt) === verdict && policyVerdict(current, op.origin, entry.lastEnqueuedAt) === verdict;
  }

  /** The entry `op` may fold into without changing the result, or null. */
  private foldTarget(group: OriginGroup, op: CaptureOp, policy: () => MemoryPolicy | null): QueuedEntry | null {
    if (op.type === 'visit' || op.type === 'hidden') {
      return group.entries.find((entry) => entry.op.type === op.type && entry.op.profileId === op.profileId && this.sameVerdict(entry, op, policy)) ?? null;
    }
    const values = factsValues(op);
    const key = factsKey(op, values);
    for (let index = group.entries.length - 1; index >= 0; index -= 1) {
      const entry = group.entries[index];
      if (!entry.values) continue;
      if (entry.key === key && this.sameVerdict(entry, op, policy)) return entry;
      if (conflicts(values, entry.values)) return null;
    }
    return null;
  }

  private fold(entry: QueuedEntry, op: CaptureOp): void {
    const merged = entry.op;
    const firstAt = earlier(merged.firstAt ?? merged.at, op.firstAt ?? op.at);
    merged.enqueuedAt = earlier(merged.enqueuedAt, op.enqueuedAt);
    entry.lastEnqueuedAt = later(op.enqueuedAt, entry.lastEnqueuedAt);
    if (op.type === 'facts' && Date.parse(op.at) >= Date.parse(merged.at)) {
      // The newest observation supplies the verification (tool and path), as it would applied last.
      merged.tool = op.tool;
      merged.path = op.path;
    }
    merged.at = later(op.at, merged.at);
    merged.firstAt = firstAt;
    entry.count += 1;
    merged.count = entry.count;
  }

  private dropOne(op: CaptureOp, reason: DropReason): void {
    this.dropped[reason] += 1;
    this.report(op, reason);
  }

  private dropEntry(entry: QueuedEntry, reason: DropReason): void {
    this.dropped[reason] += entry.count;
    for (const op of this.members(entry)) this.report(op, reason);
  }

  /** One view per operation an entry stands for, so the hooks stay per operation. */
  private *members(entry: QueuedEntry): Generator<CaptureOp> {
    const { count: _count, firstAt: _firstAt, ...base } = entry.op;
    for (let index = 0; index < entry.count; index += 1) yield { ...base, opId: entry.opIds[index] ?? entry.op.opId };
  }

  private report(op: CaptureOp, reason: DropReason): void {
    try {
      this.options.onDrop?.(op, reason);
    } catch {
      // A reporting hook must not disturb the writer.
    }
  }

  private async pump(): Promise<void> {
    this.scheduled = false;
    this.running = true;
    try {
      for (let next = this.pending.values().next(); !next.done; next = this.pending.values().next()) {
        // Everything held for the first origin goes into one commit: one read, one write (review F-03).
        const group = next.value;
        this.pending.delete(group.origin);
        for (const entry of group.entries) {
          for (const id of entry.opIds) {
            this.pendingIds.delete(id);
            this.inFlightIds.add(id);
          }
        }
        this.inFlight = group.entries;
        const done = this.commit(group.entries);
        this.current = { origin: group.origin, done };
        await done;
        this.current = null;
        this.inFlight = [];
        this.inFlightIds.clear();
      }
    } finally {
      this.inFlight = [];
      this.inFlightIds.clear();
      this.current = null;
      this.running = false;
    }
    try {
      this.options.onDrained?.(new Date(this.now()).toISOString());
    } catch {
      // Same as onDrop.
    }
    for (const resolve of this.waiters.splice(0)) resolve();
  }

  private async commit(group: QueuedEntry[]): Promise<void> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const outcomes: Array<DropReason | null> = group.map(() => 'timeout');
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve('timeout');
      }, this.commitTimeoutMs);
    });
    const ops = group.map((entry) => entry.op);
    const finished = await Promise.race([this.run(ops, controller.signal, outcomes).then(() => 'done' as const), timeout]);
    clearTimeout(timer);
    // After a timeout the run may still be filling `outcomes`; take the values as they stand now.
    const settled = finished === 'timeout' ? [...outcomes] : outcomes;
    group.forEach((entry, index) => {
      const outcome = settled[index];
      if (outcome !== null) {
        this.dropEntry(entry, outcome);
        return;
      }
      this.committed += entry.count;
      for (const id of entry.opIds) {
        this.committedIds.delete(id);
        this.committedIds.set(id, true);
      }
      while (this.committedIds.size > this.dedupeEntries) {
        const oldest = this.committedIds.keys().next().value;
        if (oldest === undefined) break;
        this.committedIds.delete(oldest);
      }
      for (const op of this.members(entry)) {
        try {
          this.options.onCommit?.(op);
        } catch {
          // Same as onDrop.
        }
      }
    });
  }

  /** Why an operation must not commit under the current policy, or null. A folded one is judged by its earliest enqueue. */
  private policyDrop(op: CaptureOp): DropReason | null {
    let policy: MemoryPolicy;
    try {
      policy = this.readPolicy();
    } catch (error) {
      return error instanceof MemoryPolicyError && error.code === 'MEMORY_CORRUPT' ? 'corrupt' : 'io_error';
    }
    return policyVerdict(policy, op.origin, op.enqueuedAt);
  }

  /**
   * The commit of one origin's group: read once, apply each operation that the policy still allows (an operation
   * that would not fit is dropped alone), write once. Fills `outcomes` (null = committed) and never rejects.
   */
  private async run(group: CaptureOp[], signal: AbortSignal, outcomes: Array<DropReason | null>): Promise<void> {
    try {
      const allowed: number[] = [];
      group.forEach((op, index) => {
        const blocked = this.policyDrop(op);
        if (blocked) outcomes[index] = blocked;
        else allowed.push(index);
      });
      if (allowed.length === 0) return;
      let site = await this.store.getSite(group[0].origin, { afterWrites: true });
      const now = new Date(this.now()).toISOString();
      const applied: number[] = [];
      for (const index of allowed) {
        try {
          site = applyOp(site, group[index], now);
          applied.push(index);
        } catch (error) {
          outcomes[index] = mapStoreError(error);
        }
      }
      if (signal.aborted) return;
      const writable = applied.filter((index) => {
        const stillBlocked = this.policyDrop(group[index]);
        if (stillBlocked) outcomes[index] = stillBlocked;
        return !stillBlocked;
      });
      if (writable.length === 0) return;
      if (writable.length !== applied.length) {
        // A policy change landed mid-commit: redo the merge with only the operations that are still allowed.
        site = await this.store.getSite(group[0].origin, { afterWrites: true });
        for (const index of writable) site = applyOp(site, group[index], now);
      }
      if (!site) return;
      try {
        await this.store.putSite(site, { signal });
      } catch (error) {
        if (signal.aborted) return;
        const reason = mapStoreError(error);
        for (const index of writable) outcomes[index] = reason;
        return;
      }
      for (const index of writable) outcomes[index] = null;
    } catch (error) {
      const reason = mapStoreError(error);
      outcomes.forEach((outcome, index) => {
        if (outcome === 'timeout') outcomes[index] = reason;
      });
    }
  }
}
