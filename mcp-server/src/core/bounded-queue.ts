/**
 * The bounded, single-writer queue engine both memory writers run on.
 *
 * The site-memory writer and the site-map writer were the same queue written
 * twice: the same pending map, the same dedupe rings, the same single-writer
 * pump, the same commit timeout, the same drop counters. A fix in one branch
 * never reached the other, so a bug fixed for memory stayed broken for the
 * map. This module is that queue once; the two writers are profiles of it.
 *
 * What the engine owns: the bounded map of pending groups, the dedupe rings,
 * the one-group-at-a-time pump, the commit timeout that abandons a stuck
 * write, the drop counters, the statistics, and the drain and settle
 * semantics.
 *
 * What a profile owns: what an operation is, how operations fold into a
 * group, which policy judges an operation, and what a commit writes.
 *
 * The engine imports nothing, so neither writer depends on the other and the
 * neutral layer stays free of any memory or map knowledge.
 */

/** The reasons a held operation can be dropped. Both writers count the same nine. */
export const QUEUE_DROP_REASONS = ['disabled', 'excluded', 'deleted', 'duplicate', 'queue_full', 'timeout', 'capacity', 'io_error', 'corrupt'] as const;
export type QueueDropReason = (typeof QUEUE_DROP_REASONS)[number];

/**
 * Bound on the distinct groups a writer holds (waiting plus the one being committed). Operations for a group that
 * is already held fold into it (see the profile's `admit`), so a burst on one site never fills the queue; only a
 * new group arriving at the bound is dropped as `queue_full`.
 */
export const MAX_PENDING_OPERATIONS = 256;
/** Bound on the folded entries one group holds. */
export const MAX_GROUP_ENTRIES = 64;
/** How many operation ids a writer remembers for dedupe. */
export const DEDUPE_ENTRIES = 1_024;
/** How long one commit may run before it is abandoned. */
export const COMMIT_TIMEOUT_MS = 2_000;

/**
 * One operation held by a group. `count` is how many operations the entry stands for.
 *
 * The entry holds the operation and nothing else: whatever a profile needs to remember about how its operations
 * fold (the memory writer's fact values) lives in that profile, not here.
 */
export interface QueueEntry<Op> {
  /** The representative operation, already merged when operations fold. */
  op: Op;
  /** How many operations this entry stands for. */
  count: number;
  /** The ids of the operations this entry stands for, in arrival order. */
  opIds: string[];
}

/** Everything held for one key, in arrival order. */
export interface QueueGroup<Op> {
  /** The key the group is filed under. */
  key: string;
  /** The origin the group belongs to; the settle filter matches on it. */
  origin: string;
  /** The operations held, in arrival order. */
  entries: QueueEntry<Op>[];
  /** How many ids this group remembers. */
  ids: number;
}

/** What the engine reports about itself. */
export interface BoundedQueueStats {
  /** Operations held: waiting ones plus those being committed, counted before folding. */
  pending: number;
  /** Distinct groups held, bounded by `maxPending`. */
  groups: number;
  /** Largest number of entries one held group has. */
  maxGroupEntries: number;
  inFlight: boolean;
  committed: number;
  dropped: Record<QueueDropReason, number>;
  /** Bound on distinct groups held. */
  maxPending: number;
  commitTimeoutMs: number;
}

/** How an operation was placed in a group. */
export interface Admission<Op, G> {
  /** The group the operation belongs to, created when it is new. */
  group: G;
  /** The entry the operation landed in. */
  entry: QueueEntry<Op>;
  /** True when the entry is new, so the group bound still applies to it. */
  added: boolean;
}

/** What the engine needs from the writer it serves. */
export interface BoundedQueueOptions<Op, SideOp, G extends QueueGroup<Op>, Result> {
  /** Bound on the distinct groups held (waiting plus the one being committed). */
  maxPending: number;
  /** Bound on the entries one group holds. */
  maxGroupEntries: number;
  /** How many ids are remembered for dedupe. */
  dedupeEntries: number;
  /** How long one commit may run before it is abandoned. */
  commitTimeoutMs: number;
  /** The clock, so the drained timestamp is testable. */
  now: () => number;
  /** The id an operation is known by; a repeat of it is a duplicate. */
  opId: (op: Op | SideOp) => string;
  /** The key a group of operations is filed under. */
  groupKey: (op: Op) => string;
  /**
   * Files an operation in its group: folds it into an entry already held, or offers a new one. The hook must not
   * change the group when it offers a new entry, since the group bound is checked after it returns.
   */
  admit: (op: Op, group: G | undefined) => Admission<Op, G>;
  /** One view per operation an entry stands for, so the hooks stay per operation. */
  members: (entry: QueueEntry<Op>) => Op[];
  /** Whether the id of an admitted operation is remembered for dedupe. */
  rememberId?: (group: G) => boolean;
  /** Whether an operation being committed still counts as a duplicate. */
  dedupeInFlight?: boolean;
  /** Writes one group: fills `outcomes` (null = committed) and the per-entry results. */
  commitGroup: (group: G, signal: AbortSignal, outcomes: Array<QueueDropReason | null>, results: Array<Result | null>) => Promise<void>;
  /** Called for every operation a committed entry stands for. */
  onCommitted?: (op: Op, result: Result | null) => void;
  /** Called for every dropped operation. */
  onDrop?: (op: Op | SideOp, reason: QueueDropReason) => void;
  /** Called with the time the queue emptied, so the owner of the policy can prune tombstones older than it. */
  onDrained?: (drainedThrough: string) => void;
  /** The side list: operations that belong to no group (the map counters). */
  side?: {
    /** The bound on the side list. */
    limit: number;
    /** Writes the side list. */
    commit: (ops: SideOp[]) => Promise<void>;
  };
}

/**
 * A bounded, single-writer queue between the browser call path and a store.
 *
 * `enqueue` never waits and never throws; commits run one at a time after the
 * call that produced them. A commit that runs longer than the timeout is
 * abandoned: its signal is aborted, so the store removes the temp file instead
 * of renaming it. An abandoned write that had already reached the rename may
 * still land; it is reported as `timeout`, never as committed.
 *
 * Operations fold per group as they arrive: a profile decides what may fold
 * into what. The bound is on distinct groups held, so memory stays bounded by
 * MAX_PENDING_OPERATIONS × MAX_GROUP_ENTRIES entries while a burst on one
 * group is never dropped.
 */
export class BoundedQueue<Op, SideOp = never, G extends QueueGroup<Op> = QueueGroup<Op>, Result = unknown> {
  private readonly options: BoundedQueueOptions<Op, SideOp, G, Result>;
  private readonly maxPending: number;
  private readonly commitTimeoutMs: number;
  private readonly dedupeEntries: number;
  /** Waiting work by group key; Map order is arrival order of each key's first operation. */
  private readonly pending = new Map<string, G>();
  private readonly pendingIds = new Set<string>();
  private readonly inFlightIds = new Set<string>();
  private readonly committedIds = new Map<string, true>();
  private readonly dropped = Object.fromEntries(QUEUE_DROP_REASONS.map((reason) => [reason, 0])) as Record<QueueDropReason, number>;
  private readonly waiters: Array<() => void> = [];
  /** Operations that belong to no group (the map counters). */
  private side: Array<QueueEntry<SideOp>> = [];
  /** The group being written right now. */
  private inFlight: QueueEntry<Op>[] = [];
  private current: { key: string; origin: string; done: Promise<void> } | null = null;
  private running = false;
  private scheduled = false;
  private committed = 0;

  constructor(options: BoundedQueueOptions<Op, SideOp, G, Result>) {
    this.options = options;
    this.maxPending = options.maxPending;
    this.commitTimeoutMs = options.commitTimeoutMs;
    this.dedupeEntries = options.dedupeEntries;
  }

  /** Never waits and never throws. */
  enqueue(op: Op): { accepted: boolean; reason?: QueueDropReason } {
    const opId = this.options.opId(op);
    if (this.isDuplicate(opId)) {
      this.dropOperation(op, 'duplicate');
      return { accepted: false, reason: 'duplicate' };
    }
    const key = this.options.groupKey(op);
    let group = this.pending.get(key);
    if (!group && key !== this.current?.key && this.heldGroups() >= this.maxPending) {
      this.dropOperation(op, 'queue_full');
      return { accepted: false, reason: 'queue_full' };
    }
    const admission = this.options.admit(op, group);
    if (admission.added && admission.group.entries.length >= this.options.maxGroupEntries) {
      this.dropOperation(op, 'queue_full');
      return { accepted: false, reason: 'queue_full' };
    }
    if (admission.added) admission.group.entries.push(admission.entry);
    if (this.options.rememberId?.(admission.group) ?? true) {
      admission.entry.opIds.push(opId);
      this.pendingIds.add(opId);
      admission.group.ids += 1;
    }
    this.pending.set(admission.group.key, admission.group);
    this.schedule();
    return { accepted: true };
  }

  /**
   * Files an operation in the side list: the operations that belong to no group (the map counters). The side list
   * is bounded on its own and is written after every group has been written.
   */
  enqueueSide(op: SideOp): { accepted: boolean; reason?: QueueDropReason } {
    const side = this.options.side;
    const opId = this.options.opId(op);
    if (this.isDuplicate(opId)) {
      this.dropOperation(op, 'duplicate');
      return { accepted: false, reason: 'duplicate' };
    }
    if (!side || this.side.length >= side.limit) {
      this.dropOperation(op, 'queue_full');
      return { accepted: false, reason: 'queue_full' };
    }
    this.side.push({ op, count: 1, opIds: [opId] });
    this.pendingIds.add(opId);
    this.schedule();
    return { accepted: true };
  }

  /**
   * Files an operation in the side list without the dedupe and bound checks: the writer's own derived changes
   * (the counters a decided use adds) are written as they come, never as a replay of something held.
   */
  pushSide(op: SideOp): void {
    this.side.push({ op, count: 1, opIds: [this.options.opId(op)] });
  }

  /** Drops queued operations that have not started. The operation being committed is checked against the policy again just before its write. */
  dropPending(reason: QueueDropReason, filter: (op: Op | SideOp) => boolean = () => true): number {
    let count = 0;
    for (const [key, group] of this.pending) {
      group.entries = group.entries.filter((entry) => {
        if (!filter(entry.op)) return true;
        for (const id of entry.opIds) this.pendingIds.delete(id);
        group.ids -= entry.opIds.length;
        this.dropEntry(entry, reason);
        count += entry.count;
        return false;
      });
      if (group.entries.length === 0) this.pending.delete(key);
    }
    this.side = this.side.filter((entry) => {
      if (!filter(entry.op)) return true;
      for (const id of entry.opIds) this.pendingIds.delete(id);
      this.dropped[reason] += entry.count;
      this.report(entry.op, reason);
      count += entry.count;
      return false;
    });
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

  stats(): BoundedQueueStats {
    let pending = 0;
    let maxGroupEntries = this.inFlight.length;
    for (const entry of this.inFlight) pending += entry.count;
    for (const group of this.pending.values()) {
      maxGroupEntries = Math.max(maxGroupEntries, group.entries.length);
      for (const entry of group.entries) pending += entry.count;
    }
    pending += this.side.length;
    return {
      pending,
      groups: this.heldGroups(),
      maxGroupEntries,
      inFlight: this.current !== null,
      committed: this.committed,
      dropped: { ...this.dropped },
      maxPending: this.maxPending,
      commitTimeoutMs: this.commitTimeoutMs,
    };
  }

  /** Remembers a committed id, so a replay of it is a duplicate and not a second write. */
  rememberCommitted(opId: string): void {
    this.committedIds.delete(opId);
    this.committedIds.set(opId, true);
    while (this.committedIds.size > this.dedupeEntries) {
      const oldest = this.committedIds.keys().next().value;
      if (oldest === undefined) break;
      this.committedIds.delete(oldest);
    }
  }

  /** Counts a drop the profile made itself (a write it refused) and reports it, so every drop is counted once. */
  countDrop(op: Op | SideOp, reason: QueueDropReason): void {
    this.dropOperation(op, reason);
  }

  private heldGroups(): number {
    return this.pending.size + (this.current && !this.pending.has(this.current.key) ? 1 : 0);
  }

  private isDuplicate(opId: string): boolean {
    if (this.committedIds.has(opId) || this.pendingIds.has(opId)) return true;
    return this.options.dedupeInFlight === true && this.inFlightIds.has(opId);
  }

  private dropOperation(op: Op | SideOp, reason: QueueDropReason): void {
    this.dropped[reason] += 1;
    this.report(op, reason);
  }

  private dropEntry(entry: QueueEntry<Op>, reason: QueueDropReason): void {
    this.dropped[reason] += entry.count;
    for (const op of this.options.members(entry)) this.report(op, reason);
  }

  private report(op: Op | SideOp, reason: QueueDropReason): void {
    try {
      this.options.onDrop?.(op, reason);
    } catch {
      // A reporting hook must not disturb the writer.
    }
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
          if (this.side.length === 0) break;
          await this.commitSide();
          continue;
        }
        const group = next.value;
        this.pending.delete(group.key);
        for (const entry of group.entries) {
          for (const id of entry.opIds) {
            this.pendingIds.delete(id);
            if (this.options.dedupeInFlight === true) this.inFlightIds.add(id);
          }
        }
        this.inFlight = group.entries;
        const done = this.commitGroup(group);
        this.current = { key: group.key, origin: group.origin, done };
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
      this.options.onDrained?.(new Date(this.options.now()).toISOString());
    } catch {
      // Same as onDrop.
    }
    for (const resolve of this.waiters.splice(0)) resolve();
  }

  /**
   * The commit of one group: the profile writes it, and the engine accounts for what was committed and what was
   * dropped. A commit that runs past the timeout is abandoned and reported as `timeout`, never as committed.
   */
  private async commitGroup(group: G): Promise<void> {
    const entries = group.entries;
    const outcomes: Array<QueueDropReason | null> = entries.map(() => 'timeout');
    const results: Array<Result | null> = entries.map(() => null);
    const timedOut = await this.withTimeout((signal) => this.options.commitGroup(group, signal, outcomes, results));
    // After a timeout the write may still be filling `outcomes`; take the values as they stand now.
    const settled = timedOut ? [...outcomes] : outcomes;
    entries.forEach((entry, index) => {
      const outcome = settled[index];
      if (outcome !== null) {
        this.dropEntry(entry, outcome);
        return;
      }
      this.committed += entry.count;
      for (const id of entry.opIds) this.rememberCommitted(id);
      const result = results[index];
      for (const op of this.options.members(entry)) {
        try {
          this.options.onCommitted?.(op, result);
        } catch {
          // Same as onDrop.
        }
      }
    });
  }

  /** The side list is written once, after every group has been written. */
  private async commitSide(): Promise<void> {
    const side = this.options.side;
    if (!side) return;
    const ops = this.side.splice(0);
    for (const entry of ops) {
      for (const id of entry.opIds) this.pendingIds.delete(id);
    }
    await side.commit(ops.map((entry) => entry.op));
  }

  /** Runs the write under the commit timeout; the signal is aborted when the timeout wins. */
  private async withTimeout(run: (signal: AbortSignal) => Promise<void>): Promise<boolean> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve('timeout');
      }, this.commitTimeoutMs);
    });
    const finished = await Promise.race([run(controller.signal).then(() => 'done' as const), timeout]);
    clearTimeout(timer);
    return finished === 'timeout';
  }
}
