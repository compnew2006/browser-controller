import type { CandidateFact } from './allowlist.js';
import { MemoryPolicyError, readPolicy as readPolicyFile, type MemoryPolicy } from './policy.js';
import { applyOp, canonicalValue, earlier, later } from './reconcile.js';
import { MemoryStoreError, type MemoryStore, type ProfileVerification } from './store.js';
import { ERROR_CODES } from '../core/error-codes.js';
import {
  BoundedQueue,
  COMMIT_TIMEOUT_MS,
  DEDUPE_ENTRIES,
  MAX_GROUP_ENTRIES,
  MAX_PENDING_OPERATIONS,
  QUEUE_DROP_REASONS,
  type QueueDropReason,
  type QueueEntry,
  type QueueGroup,
} from '../core/bounded-queue.js';

export { applyOp };
export { MAX_PENDING_OPERATIONS, MAX_GROUP_ENTRIES, DEDUPE_ENTRIES, COMMIT_TIMEOUT_MS };

/** The reasons a queued operation can be dropped. */
export const DROP_REASONS = QUEUE_DROP_REASONS;
export type DropReason = QueueDropReason;

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

export type EnqueueResult = { accepted: true } | { accepted: false; reason: 'queue_full' | 'duplicate'; code?: typeof ERROR_CODES.MEMORY_QUEUE_FULL };

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
  /** Bound on the folded entries one origin holds; the default is MAX_GROUP_ENTRIES. */
  maxGroupEntries?: number;
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

function storeDrop(error: unknown): DropReason {
  if (error instanceof MemoryStoreError) {
    if (error.code === ERROR_CODES.MEMORY_CORRUPT) return 'corrupt';
    if (error.code === ERROR_CODES.MEMORY_FULL) return 'capacity';
  }
  return 'io_error';
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
 * What the queue remembers about one entry so that a later operation may still fold into it. It belongs to the
 * memory profile, not to the engine: the engine only knows an entry as an operation and a count.
 */
interface FoldState {
  /** Facts entries: candidate values by factId, used to decide whether a later operation may fold. */
  values: Map<string, string> | null;
  /** Facts entries: identity of the candidate set, the profile and whether it verifies. */
  key: string | null;
  /** Latest `enqueuedAt` folded in (`op.enqueuedAt` is the earliest). */
  lastEnqueuedAt: string;
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
 * The queue mechanics (the bounded groups, the dedupe rings, the pump, the
 * commit timeout, the drop counters) are the shared engine in `core/`; this
 * class is the memory profile of it: what an operation is, how visits and
 * facts fold, what the policy says and what a commit writes.
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
  private readonly engine: BoundedQueue<CaptureOp>;
  /** How each held entry may still fold; the engine keeps no such knowledge. */
  private readonly folds = new WeakMap<QueueEntry<CaptureOp>, FoldState>();

  constructor(options: MemoryQueueOptions) {
    this.options = options;
    this.store = options.store;
    this.readPolicy = options.readPolicy ?? (() => readPolicyFile(options.memoryDir));
    this.now = options.now ?? Date.now;
    this.maxPending = options.maxPending ?? MAX_PENDING_OPERATIONS;
    this.commitTimeoutMs = options.commitTimeoutMs ?? COMMIT_TIMEOUT_MS;
    this.dedupeEntries = options.dedupeEntries ?? DEDUPE_ENTRIES;
    this.engine = new BoundedQueue<CaptureOp>({
      maxPending: this.maxPending,
      maxGroupEntries: options.maxGroupEntries ?? MAX_GROUP_ENTRIES,
      dedupeEntries: this.dedupeEntries,
      commitTimeoutMs: this.commitTimeoutMs,
      now: this.now,
      opId: (op) => op.opId,
      groupKey: (op) => op.origin,
      admit: (op, group) => this.admit(op, group),
      members: (entry) => this.members(entry),
      // One origin remembers at most `dedupeEntries` ids; beyond that the id is not deduped any more.
      rememberId: (group) => group.ids < this.dedupeEntries,
      dedupeInFlight: true,
      commitGroup: (group, signal, outcomes) => this.commitGroup(group, signal, outcomes),
      onCommitted: (op) => this.options.onCommit?.(op),
      onDrop: (op, reason) => this.options.onDrop?.(op, reason),
      onDrained: (through) => this.options.onDrained?.(through),
    });
  }

  enqueue(op: CaptureOp): EnqueueResult {
    const result = this.engine.enqueue(op);
    if (result.accepted) return { accepted: true };
    if (result.reason === 'queue_full') return { accepted: false, reason: 'queue_full', code: ERROR_CODES.MEMORY_QUEUE_FULL };
    return { accepted: false, reason: 'duplicate' };
  }

  /** Drop queued operations that have not started (all of them without a filter). The operation being committed is checked against the policy again just before its write. */
  dropPending(reason: DropReason, filter: (op: CaptureOp) => boolean = () => true): number {
    return this.engine.dropPending(reason, filter);
  }

  /**
   * Resolves once the commit now in flight has finished, when `affects` matches its origin, and at most after
   * `timeoutMs` (default: the commit timeout plus a margin). Queued work is not waited for: the caller drops what
   * it must, and every later commit re-reads the policy before it writes. Never rejects.
   */
  settle(affects: (origin: string) => boolean = () => true, timeoutMs = this.commitTimeoutMs + 500): Promise<void> {
    return this.engine.settle(affects, timeoutMs);
  }

  /** Resolves when nothing is queued or being committed. Never rejects. */
  drain(): Promise<void> {
    return this.engine.drain();
  }

  stats(): QueueStats {
    const stats = this.engine.stats();
    return {
      pending: stats.pending,
      groups: stats.groups,
      maxGroupEntries: stats.maxGroupEntries,
      inFlight: stats.inFlight,
      committed: stats.committed,
      dropped: stats.dropped,
      maxPending: stats.maxPending,
      commitTimeoutMs: stats.commitTimeoutMs,
    };
  }

  /** Files the operation in its origin: folded into an entry already held, or as a new entry. */
  private admit(op: CaptureOp, group: QueueGroup<CaptureOp> | undefined): { group: QueueGroup<CaptureOp>; entry: QueueEntry<CaptureOp>; added: boolean } {
    const target = group ?? { key: op.origin, origin: op.origin, entries: [], ids: 0 };
    const entry = this.foldTarget(target, op);
    if (entry) {
      this.fold(entry, op);
      return { group: target, entry, added: false };
    }
    return { group: target, entry: this.newEntry(op), added: true };
  }

  private newEntry(op: CaptureOp): QueueEntry<CaptureOp> {
    const values = op.type === 'facts' ? factsValues(op) : null;
    const entry: QueueEntry<CaptureOp> = { op: { ...op }, count: 1, opIds: [] };
    this.folds.set(entry, { values, key: values ? factsKey(op, values) : null, lastEnqueuedAt: op.enqueuedAt });
    return entry;
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
  private sameVerdict(entry: QueueEntry<CaptureOp>, op: CaptureOp, policy: () => MemoryPolicy | null): boolean {
    const state = this.folds.get(entry);
    const lastEnqueuedAt = state?.lastEnqueuedAt ?? entry.op.enqueuedAt;
    if (entry.op.enqueuedAt === op.enqueuedAt && lastEnqueuedAt === op.enqueuedAt) return true;
    const current = policy();
    if (!current) return false;
    const verdict = policyVerdict(current, op.origin, op.enqueuedAt);
    return policyVerdict(current, op.origin, entry.op.enqueuedAt) === verdict && policyVerdict(current, op.origin, lastEnqueuedAt) === verdict;
  }

  /** The entry `op` may fold into without changing the result, or null. */
  private foldTarget(group: QueueGroup<CaptureOp>, op: CaptureOp): QueueEntry<CaptureOp> | null {
    const policy = this.foldPolicy();
    if (op.type === 'visit' || op.type === 'hidden') {
      return group.entries.find((entry) => entry.op.type === op.type && entry.op.profileId === op.profileId && this.sameVerdict(entry, op, policy)) ?? null;
    }
    const values = factsValues(op);
    const key = factsKey(op, values);
    for (let index = group.entries.length - 1; index >= 0; index -= 1) {
      const entry = group.entries[index];
      const state = this.folds.get(entry);
      if (!state?.values) continue;
      if (state.key === key && this.sameVerdict(entry, op, policy)) return entry;
      if (conflicts(values, state.values)) return null;
    }
    return null;
  }

  private fold(entry: QueueEntry<CaptureOp>, op: CaptureOp): void {
    const merged = entry.op;
    const firstAt = earlier(merged.firstAt ?? merged.at, op.firstAt ?? op.at);
    merged.enqueuedAt = earlier(merged.enqueuedAt, op.enqueuedAt);
    const state = this.folds.get(entry);
    if (state) state.lastEnqueuedAt = later(op.enqueuedAt, state.lastEnqueuedAt);
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

  /** One view per operation an entry stands for, so the hooks stay per operation. */
  private members(entry: QueueEntry<CaptureOp>): CaptureOp[] {
    const { count: _count, firstAt: _firstAt, ...base } = entry.op;
    const views: CaptureOp[] = [];
    for (let index = 0; index < entry.count; index += 1) views.push({ ...base, opId: entry.opIds[index] ?? entry.op.opId });
    return views;
  }

  /**
   * The commit of one origin's group: read once, apply each operation that the policy still allows (an operation
   * that would not fit is dropped alone), write once. Fills `outcomes` (null = committed) and never rejects.
   */
  private async commitGroup(group: QueueGroup<CaptureOp>, signal: AbortSignal, outcomes: Array<DropReason | null>): Promise<void> {
    await this.run(group.entries.map((entry) => entry.op), signal, outcomes);
  }

  /** Why an operation must not commit under the current policy, or null. A folded one is judged by its earliest enqueue. */
  private policyDrop(op: CaptureOp): DropReason | null {
    let policy: MemoryPolicy;
    try {
      policy = this.readPolicy();
    } catch (error) {
      return error instanceof MemoryPolicyError && error.code === ERROR_CODES.MEMORY_CORRUPT ? 'corrupt' : 'io_error';
    }
    return policyVerdict(policy, op.origin, op.enqueuedAt);
  }

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
          outcomes[index] = storeDrop(error);
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
        const reason = storeDrop(error);
        for (const index of writable) outcomes[index] = reason;
        return;
      }
      for (const index of writable) outcomes[index] = null;
    } catch (error) {
      const reason = storeDrop(error);
      outcomes.forEach((outcome, index) => {
        if (outcome === 'timeout') outcomes[index] = reason;
      });
    }
  }
}
