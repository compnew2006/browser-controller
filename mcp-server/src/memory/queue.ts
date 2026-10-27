import type { CandidateFact } from './allowlist.js';
import { MemoryPolicyError, readPolicy as readPolicyFile, type MemoryPolicy } from './policy.js';
import {
  MAX_FACTS,
  MAX_PROFILES,
  MemoryStoreError,
  SITE_SCHEMA_VERSION,
  type MemoryStore,
  type ProfileSiteState,
  type ProfileVerification,
  type SiteFact,
  type SiteRecord,
} from './store.js';

export const MAX_PENDING_OPERATIONS = 256;
export const DEDUPE_ENTRIES = 1_024;
export const COMMIT_TIMEOUT_MS = 2_000;
const MAX_PATH = 120;
const UNSAFE_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

export const DROP_REASONS = ['disabled', 'excluded', 'deleted', 'duplicate', 'queue_full', 'timeout', 'capacity', 'io_error', 'corrupt'] as const;
export type DropReason = (typeof DROP_REASONS)[number];

/** One capture waiting to be committed. `opId` is the daemon call id. */
export interface CaptureOp {
  opId: string;
  type: 'visit' | 'facts';
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
}

export type EnqueueResult = { accepted: true } | { accepted: false; reason: 'queue_full' | 'duplicate'; code?: 'MEMORY_QUEUE_FULL' };

export interface QueueStats {
  /** Waiting operations plus the one being committed. */
  pending: number;
  inFlight: boolean;
  committed: number;
  dropped: Record<DropReason, number>;
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

function validPath(value: unknown): value is string {
  return typeof value === 'string' && value.length <= MAX_PATH && /^\/[^?#]*$/u.test(value);
}

function sameValue(a: unknown, b: unknown): boolean {
  const canon = (value: unknown): string =>
    JSON.stringify(Object.entries(value as Record<string, unknown>).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)));
  return canon(a) === canon(b);
}

function later(a: string, b: string): string {
  return Date.parse(a) >= Date.parse(b) ? a : b;
}

function earlier(a: string, b: string): string {
  return Date.parse(a) <= Date.parse(b) ? a : b;
}

/**
 * Reconcile one operation into a site record (R-10). Pure: the input record is
 * not changed. Throws MEMORY_FULL when the result would exceed the fact or
 * profile cap, so a rejected operation leaves no partial state.
 *
 * - Same identity and value: refresh `lastObserved`, keep `firstObserved`.
 * - Same identity, new value: the new value replaces the old one with fresh
 *   provenance, unless it is strictly older than the current observation.
 *   Equal times resolve by commit order.
 * - A verification is kept only when its path can be stored (<= 120
 *   characters, no query or fragment); the fact is kept either way.
 */
export function applyOp(record: SiteRecord | null, op: CaptureOp, now: string): SiteRecord {
  if (record && record.origin !== op.origin) throw new MemoryStoreError('INVALID_ARGUMENT', 'operation origin does not match the record');
  if (UNSAFE_KEYS.has(op.profileId) || op.profileId === '') throw new MemoryStoreError('INVALID_ARGUMENT', 'profile id is invalid');
  const next: SiteRecord = record
    ? structuredClone(record)
    : { schemaVersion: SITE_SCHEMA_VERSION, origin: op.origin, facts: [], profiles: {}, commitSeq: 0, updatedAt: now };

  const profile = (): ProfileSiteState => {
    if (!Object.hasOwn(next.profiles, op.profileId)) {
      if (Object.keys(next.profiles).length >= MAX_PROFILES) throw new MemoryStoreError('MEMORY_FULL', `a site holds at most ${MAX_PROFILES} profiles`);
      next.profiles[op.profileId] = {};
    }
    return next.profiles[op.profileId];
  };

  if (op.type === 'visit') {
    const state = profile();
    state.visit = state.visit
      ? { firstAt: earlier(state.visit.firstAt, op.at), lastAt: later(state.visit.lastAt, op.at), count: state.visit.count + 1 }
      : { firstAt: op.at, lastAt: op.at, count: 1 };
  } else {
    const verify = op.tool !== undefined && validPath(op.path);
    for (const candidate of op.facts) {
      const current = next.facts.find((entry) => entry.factId === candidate.factId);
      let applied = true;
      if (!current) {
        if (next.facts.length >= MAX_FACTS) throw new MemoryStoreError('MEMORY_FULL', `a site holds at most ${MAX_FACTS} facts`);
        const created: SiteFact = {
          factId: candidate.factId,
          kind: candidate.kind,
          value: candidate.value,
          firstObserved: op.at,
          lastObserved: op.at,
          status: 'current',
        };
        next.facts.push(created);
      } else if (sameValue(current.value, candidate.value)) {
        current.firstObserved = earlier(current.firstObserved, op.at);
        current.lastObserved = later(current.lastObserved, op.at);
      } else if (Date.parse(op.at) >= Date.parse(current.lastObserved)) {
        current.value = candidate.value;
        current.firstObserved = op.at;
        current.lastObserved = op.at;
      } else {
        applied = false;
      }
      if (applied && verify) {
        const verifications = (profile().verifications ??= {});
        const existing = Object.hasOwn(verifications, candidate.factId) ? verifications[candidate.factId] : undefined;
        if (!existing || Date.parse(existing.at) <= Date.parse(op.at)) {
          verifications[candidate.factId] = { at: op.at, tool: op.tool as ProfileVerification['tool'], path: op.path as string };
        }
      }
    }
  }

  next.commitSeq = (record?.commitSeq ?? 0) + 1;
  next.updatedAt = now;
  return next;
}

function mapStoreError(error: unknown): DropReason {
  if (error instanceof MemoryStoreError) {
    if (error.code === 'MEMORY_CORRUPT') return 'corrupt';
    if (error.code === 'MEMORY_FULL') return 'capacity';
  }
  return 'io_error';
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
 */
export class MemoryQueue {
  private readonly store: MemoryStore;
  private readonly readPolicy: () => MemoryPolicy;
  private readonly now: () => number;
  private readonly maxPending: number;
  private readonly commitTimeoutMs: number;
  private readonly dedupeEntries: number;
  private readonly options: MemoryQueueOptions;
  private readonly pending: CaptureOp[] = [];
  private readonly pendingIds = new Set<string>();
  private readonly committedIds = new Map<string, true>();
  private readonly dropped = Object.fromEntries(DROP_REASONS.map((reason) => [reason, 0])) as Record<DropReason, number>;
  private readonly waiters: Array<() => void> = [];
  private inFlight: CaptureOp | null = null;
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
    if (this.committedIds.has(op.opId) || this.pendingIds.has(op.opId) || this.inFlight?.opId === op.opId) {
      this.drop(op, 'duplicate');
      return { accepted: false, reason: 'duplicate' };
    }
    if (this.pending.length + (this.inFlight ? 1 : 0) >= this.maxPending) {
      this.drop(op, 'queue_full');
      return { accepted: false, reason: 'queue_full', code: 'MEMORY_QUEUE_FULL' };
    }
    this.pending.push(op);
    this.pendingIds.add(op.opId);
    if (!this.running && !this.scheduled) {
      this.scheduled = true;
      setImmediate(() => void this.pump());
    }
    return { accepted: true };
  }

  /** Drop queued operations that have not started (all of them without a filter). The operation being committed is checked against the policy again just before its write. */
  dropPending(reason: DropReason, filter: (op: CaptureOp) => boolean = () => true): number {
    let count = 0;
    for (let index = 0; index < this.pending.length; ) {
      const op = this.pending[index];
      if (!filter(op)) {
        index += 1;
        continue;
      }
      this.pending.splice(index, 1);
      this.pendingIds.delete(op.opId);
      this.drop(op, reason);
      count += 1;
    }
    return count;
  }

  /** Resolves when nothing is queued or being committed. Never rejects. */
  drain(): Promise<void> {
    if (!this.running && !this.scheduled) return Promise.resolve();
    return new Promise<void>((resolve) => this.waiters.push(resolve));
  }

  stats(): QueueStats {
    return {
      pending: this.pending.length + (this.inFlight ? 1 : 0),
      inFlight: this.inFlight !== null,
      committed: this.committed,
      dropped: { ...this.dropped },
      maxPending: this.maxPending,
      commitTimeoutMs: this.commitTimeoutMs,
    };
  }

  private drop(op: CaptureOp, reason: DropReason): void {
    this.dropped[reason] += 1;
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
      while (this.pending.length > 0) {
        const op = this.pending.shift() as CaptureOp;
        this.pendingIds.delete(op.opId);
        this.inFlight = op;
        await this.commit(op);
        this.inFlight = null;
      }
    } finally {
      this.inFlight = null;
      this.running = false;
    }
    try {
      this.options.onDrained?.(new Date(this.now()).toISOString());
    } catch {
      // Same as onDrop.
    }
    for (const resolve of this.waiters.splice(0)) resolve();
  }

  private async commit(op: CaptureOp): Promise<void> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve('timeout');
      }, this.commitTimeoutMs);
    });
    const outcome = await Promise.race([this.run(op, controller.signal), timeout]);
    clearTimeout(timer);
    if (outcome === null) {
      this.committed += 1;
      this.committedIds.delete(op.opId);
      this.committedIds.set(op.opId, true);
      while (this.committedIds.size > this.dedupeEntries) {
        const oldest = this.committedIds.keys().next().value;
        if (oldest === undefined) break;
        this.committedIds.delete(oldest);
      }
      try {
        this.options.onCommit?.(op);
      } catch {
        // Same as onDrop.
      }
      return;
    }
    this.drop(op, outcome);
  }

  /** Why an operation must not commit under the current policy, or null. */
  private policyDrop(op: CaptureOp): DropReason | null {
    let policy: MemoryPolicy;
    try {
      policy = this.readPolicy();
    } catch (error) {
      return error instanceof MemoryPolicyError && error.code === 'MEMORY_CORRUPT' ? 'corrupt' : 'io_error';
    }
    const queuedAt = Date.parse(op.enqueuedAt);
    if (!policy.enabled || !policy.enabledAt || queuedAt < Date.parse(policy.enabledAt)) return 'disabled';
    if (policy.excluded.includes(op.origin)) return 'excluded';
    for (const key of [op.origin, '*']) {
      const deletedAt = Object.hasOwn(policy.deletions, key) ? policy.deletions[key] : undefined;
      if (deletedAt !== undefined && queuedAt <= Date.parse(deletedAt)) return 'deleted';
    }
    return null;
  }

  /** The commit itself. Resolves to null when committed, else the drop reason. Never rejects. */
  private async run(op: CaptureOp, signal: AbortSignal): Promise<DropReason | null> {
    try {
      const blocked = this.policyDrop(op);
      if (blocked) return blocked;
      const site = await this.store.getSite(op.origin);
      const next = applyOp(site, op, new Date(this.now()).toISOString());
      if (signal.aborted) return 'timeout';
      const stillBlocked = this.policyDrop(op);
      if (stillBlocked) return stillBlocked;
      await this.store.putSite(next, { signal });
      return null;
    } catch (error) {
      return mapStoreError(error);
    }
  }
}
