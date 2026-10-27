import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { controlFact, languageFact, loginFact, searchFact, type CandidateFact } from '../mcp-server/src/memory/allowlist.js';
import { MemoryPolicyError, defaultPolicy, policyPath, writePolicy, type MemoryPolicy } from '../mcp-server/src/memory/policy.js';
import {
  DROP_REASONS,
  MAX_PENDING_OPERATIONS,
  MemoryQueue,
  applyOp,
  type CaptureOp,
  type DropReason,
  type MemoryQueueOptions,
} from '../mcp-server/src/memory/queue.js';
import {
  JsonMemoryStore,
  MemoryStoreError,
  siteFileName,
  type MemoryStore,
  type MemoryStoreStatus,
  type PutSiteOptions,
  type SiteRecord,
} from '../mcp-server/src/memory/store.js';

const T0 = '2026-10-27T09:00:00.000Z';
const T1 = '2026-10-27T10:00:00.000Z';
const T2 = '2026-10-27T11:00:00.000Z';
const T3 = '2026-10-27T12:00:00.000Z';
const ORIGIN = 'https://example.com';
const OTHER = 'https://example.org';

let root: string;
let memoryDir: string;
let counter: number;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-queue-'));
  memoryDir = path.join(root, 'memory');
  counter = 0;
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function fact(candidate: CandidateFact | null): CandidateFact {
  if (!candidate) throw new Error('fixture fact rejected by the allowlist');
  return candidate;
}

function op(over: Partial<CaptureOp> = {}): CaptureOp {
  counter += 1;
  return { opId: `call-${counter}`, type: 'visit', profileId: 'profile-a', origin: ORIGIN, at: T1, facts: [], enqueuedAt: T1, ...over };
}

function enabledPolicy(over: Partial<MemoryPolicy> = {}): MemoryPolicy {
  return { ...defaultPolicy(), enabled: true, enabledAt: T0, updatedAt: T0, ...over };
}

async function setPolicy(over: Partial<MemoryPolicy> = {}): Promise<void> {
  await writePolicy(memoryDir, enabledPolicy(over));
}

function realQueue(store: MemoryStore, over: Partial<MemoryQueueOptions> = {}): MemoryQueue {
  return new MemoryQueue({ store, memoryDir, now: () => Date.parse(T3), ...over });
}

class FakeStore implements MemoryStore {
  records = new Map<string, SiteRecord>();
  gate: Promise<void> = Promise.resolve();
  putCalls: SiteRecord[] = [];
  signals: Array<AbortSignal | undefined> = [];
  active = 0;
  maxActive = 0;
  putImpl: ((record: SiteRecord, options?: PutSiteOptions) => Promise<void>) | null = null;
  getCalls = 0;

  async getSite(origin: string): Promise<SiteRecord | null> {
    this.getCalls += 1;
    await this.gate;
    const found = this.records.get(origin);
    return found ? structuredClone(found) : null;
  }

  async putSite(record: SiteRecord, options?: PutSiteOptions): Promise<void> {
    this.active += 1;
    this.maxActive = Math.max(this.maxActive, this.active);
    this.signals.push(options?.signal);
    try {
      if (this.putImpl) await this.putImpl(record, options);
      await new Promise<void>((resolve) => setImmediate(resolve));
      this.putCalls.push(structuredClone(record));
      this.records.set(record.origin, structuredClone(record));
    } finally {
      this.active -= 1;
    }
  }

  async deleteSite(): Promise<boolean> {
    return false;
  }

  async deleteAll(): Promise<number> {
    return 0;
  }

  async listSites(): Promise<SiteRecord[]> {
    return [...this.records.values()];
  }

  async status(): Promise<MemoryStoreStatus> {
    return { origins: this.records.size, totalBytes: 0, corrupt: [] };
  }
}

function holdGate(store: FakeStore): () => void {
  let release!: () => void;
  store.gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  return release;
}

function fakeQueue(store: FakeStore, over: Partial<MemoryQueueOptions> = {}): { queue: MemoryQueue; policy: { current: MemoryPolicy } } {
  const policy = { current: enabledPolicy() };
  const queue = new MemoryQueue({ store, memoryDir, readPolicy: () => policy.current, now: () => Date.parse(T3), ...over });
  return { queue, policy };
}

function drops(queue: MemoryQueue): Partial<Record<DropReason, number>> {
  return Object.fromEntries(Object.entries(queue.stats().dropped).filter(([, count]) => count > 0));
}

describe('constants', () => {
  it('names exactly the nine drop reasons', () => {
    expect([...DROP_REASONS].sort()).toEqual(
      ['capacity', 'corrupt', 'deleted', 'disabled', 'duplicate', 'excluded', 'io_error', 'queue_full', 'timeout'].sort(),
    );
    expect(MAX_PENDING_OPERATIONS).toBe(256);
  });

  it('starts with every reason counted as zero', () => {
    const { queue } = fakeQueue(new FakeStore());
    expect(Object.keys(queue.stats().dropped).sort()).toEqual([...DROP_REASONS].sort());
    expect(Object.values(queue.stats().dropped).every((count) => count === 0)).toBe(true);
  });
});

describe('bound of 256 operations', () => {
  it('accepts 256 operations, drops the 257th with MEMORY_QUEUE_FULL, and keeps the 256 intact', async () => {
    const store = new FakeStore();
    const release = holdGate(store);
    const dropped: Array<[string, DropReason]> = [];
    const { queue } = fakeQueue(store, { onDrop: (dropped_op, reason) => dropped.push([dropped_op.opId, reason]) });
    const results = Array.from({ length: 256 }, (_, i) => queue.enqueue(op({ origin: `https://site-${i}.example` })));
    expect(results.every((result) => result.accepted)).toBe(true);
    const extra = op({ opId: 'overflow' });
    expect(queue.enqueue(extra)).toEqual({ accepted: false, reason: 'queue_full', code: 'MEMORY_QUEUE_FULL' });
    expect(dropped).toEqual([['overflow', 'queue_full']]);
    release();
    await queue.drain();
    expect(queue.stats().committed).toBe(256);
    expect(store.putCalls).toHaveLength(256);
    expect(drops(queue)).toEqual({ queue_full: 1 });
  });

  it('frees a slot once an operation commits', async () => {
    const store = new FakeStore();
    const { queue } = fakeQueue(store, { maxPending: 2 });
    expect(queue.enqueue(op()).accepted).toBe(true);
    expect(queue.enqueue(op()).accepted).toBe(true);
    expect(queue.enqueue(op()).accepted).toBe(false);
    await queue.drain();
    expect(queue.enqueue(op()).accepted).toBe(true);
    await queue.drain();
  });

  it('enqueue returns at once and never throws, even when the store is broken', async () => {
    const store = new FakeStore();
    store.getSite = async () => {
      throw new Error('disk on fire');
    };
    const { queue } = fakeQueue(store);
    const result = queue.enqueue(op());
    expect(result).toEqual({ accepted: true });
    expect(typeof (result as unknown as { then?: unknown }).then).toBe('undefined');
    await queue.drain();
    expect(drops(queue)).toEqual({ io_error: 1 });
  });
});

describe('operation identity (AC-19)', () => {
  it('drops a repeated opId as duplicate, both while pending and after commit', async () => {
    const store = new FakeStore();
    const release = holdGate(store);
    const { queue } = fakeQueue(store);
    expect(queue.enqueue(op({ opId: 'same' })).accepted).toBe(true);
    expect(queue.enqueue(op({ opId: 'same' }))).toEqual({ accepted: false, reason: 'duplicate' });
    release();
    await queue.drain();
    expect(queue.enqueue(op({ opId: 'same' }))).toEqual({ accepted: false, reason: 'duplicate' });
    expect(drops(queue)).toEqual({ duplicate: 2 });
    expect(store.putCalls).toHaveLength(1);
  });

  it('keeps the newest 1,024 committed opIds and forgets older ones', async () => {
    const store = new FakeStore();
    const { queue } = fakeQueue(store);
    for (let i = 0; i <= 1024; i += 1) {
      queue.enqueue(op({ opId: `id-${i}`, origin: `https://site-${i % 50}.example` }));
      if (i % 200 === 199) await queue.drain();
    }
    await queue.drain();
    expect(queue.stats().committed).toBe(1025);
    expect(queue.enqueue(op({ opId: 'id-1' })).accepted).toBe(false);
    expect(queue.enqueue(op({ opId: 'id-0' })).accepted).toBe(true);
    await queue.drain();
  });

  it('applies a retried visit once: the same opId never counts twice', async () => {
    await setPolicy();
    const store = new JsonMemoryStore(memoryDir);
    const queue = realQueue(store);
    queue.enqueue(op({ opId: 'retry-me', type: 'visit' }));
    queue.enqueue(op({ opId: 'retry-me', type: 'visit' }));
    await queue.drain();
    expect((await store.getSite(ORIGIN))!.profiles['profile-a'].visit).toEqual({ firstAt: T1, lastAt: T1, count: 1 });
  });

  it('does not duplicate a current fact when a different opId repeats the same observation (AC-17)', async () => {
    await setPolicy();
    const store = new JsonMemoryStore(memoryDir);
    const queue = realQueue(store);
    const language = fact(languageFact('ar', 'rtl'));
    queue.enqueue(op({ type: 'facts', facts: [language], at: T1 }));
    queue.enqueue(op({ type: 'facts', facts: [language], at: T2 }));
    await queue.drain();
    const site = (await store.getSite(ORIGIN))!;
    expect(site.facts).toHaveLength(1);
    expect(site.facts[0].firstObserved).toBe(T1);
    expect(site.facts[0].lastObserved).toBe(T2);
    expect(site.commitSeq).toBe(2);
  });
});

describe('commit-time policy checks (AC-06, AC-11)', () => {
  it('drops everything while memory is disabled or the policy file is missing, and writes nothing', async () => {
    const store = new JsonMemoryStore(memoryDir);
    const queue = realQueue(store);
    queue.enqueue(op());
    await queue.drain();
    expect(drops(queue)).toEqual({ disabled: 1 });
    expect(fs.existsSync(path.join(memoryDir, 'sites'))).toBe(false);

    await writePolicy(memoryDir, { ...defaultPolicy(), enabled: false, enabledAt: null });
    queue.enqueue(op());
    await queue.drain();
    expect(drops(queue)).toEqual({ disabled: 2 });
  });

  it('drops work queued before enabledAt: no backfill (AC-06)', async () => {
    await setPolicy({ enabledAt: T2 });
    const store = new JsonMemoryStore(memoryDir);
    const queue = realQueue(store);
    queue.enqueue(op({ enqueuedAt: T1 }));
    queue.enqueue(op({ enqueuedAt: T3 }));
    await queue.drain();
    expect(drops(queue)).toEqual({ disabled: 1 });
    expect(queue.stats().committed).toBe(1);
  });

  it('drops an excluded origin but commits other origins', async () => {
    await setPolicy({ excluded: [ORIGIN] });
    const store = new JsonMemoryStore(memoryDir);
    const queue = realQueue(store);
    queue.enqueue(op({ origin: ORIGIN }));
    queue.enqueue(op({ origin: OTHER }));
    await queue.drain();
    expect(drops(queue)).toEqual({ excluded: 1 });
    expect(await store.getSite(ORIGIN)).toBeNull();
    expect(await store.getSite(OTHER)).not.toBeNull();
  });

  it('drops work queued before a deletion tombstone, for one origin or for "*"', async () => {
    await setPolicy({ deletions: { [ORIGIN]: T2 } });
    const store = new JsonMemoryStore(memoryDir);
    const queue = realQueue(store);
    queue.enqueue(op({ origin: ORIGIN, enqueuedAt: T1 }));
    queue.enqueue(op({ origin: ORIGIN, enqueuedAt: T3 }));
    queue.enqueue(op({ origin: OTHER, enqueuedAt: T1 }));
    await queue.drain();
    expect(drops(queue)).toEqual({ deleted: 1 });
    expect(queue.stats().committed).toBe(2);

    await setPolicy({ deletions: { '*': T2 } });
    queue.enqueue(op({ origin: OTHER, enqueuedAt: T1 }));
    queue.enqueue(op({ origin: OTHER, enqueuedAt: T3 }));
    await queue.drain();
    expect(drops(queue)).toEqual({ deleted: 2 });
  });

  it('re-reads the policy on every commit: a disable between two commits drops the second (AC-11)', async () => {
    await setPolicy();
    const store = new JsonMemoryStore(memoryDir);
    let first = true;
    const queue = realQueue(store, {
      onCommit: () => {
        if (!first) return;
        first = false;
        fs.writeFileSync(policyPath(memoryDir), JSON.stringify({ ...enabledPolicy(), enabled: false, enabledAt: null }));
      },
    });
    queue.enqueue(op({ origin: ORIGIN }));
    queue.enqueue(op({ origin: OTHER }));
    await queue.drain();
    expect(queue.stats().committed).toBe(1);
    expect(drops(queue)).toEqual({ disabled: 1 });
    expect(await store.getSite(OTHER)).toBeNull();
  });

  it('checks again right before the write: a policy change while the site loads still wins', async () => {
    const store = new FakeStore();
    const release = holdGate(store);
    const { queue, policy } = fakeQueue(store);
    queue.enqueue(op());
    await new Promise<void>((resolve) => setImmediate(resolve));
    policy.current = enabledPolicy({ excluded: [ORIGIN] });
    release();
    await queue.drain();
    expect(store.putCalls).toHaveLength(0);
    expect(drops(queue)).toEqual({ excluded: 1 });
  });

  it('maps a corrupt policy to "corrupt" and an unreadable one to "io_error", writing nothing', async () => {
    const store = new FakeStore();
    const corrupt = new MemoryQueue({
      store,
      memoryDir,
      readPolicy: () => {
        throw new MemoryPolicyError('MEMORY_CORRUPT', 'bad');
      },
      now: () => Date.parse(T3),
    });
    corrupt.enqueue(op());
    await corrupt.drain();
    expect(drops(corrupt)).toEqual({ corrupt: 1 });

    const unreadable = new MemoryQueue({
      store,
      memoryDir,
      readPolicy: () => {
        throw new MemoryPolicyError('MEMORY_UNAVAILABLE', 'io');
      },
      now: () => Date.parse(T3),
    });
    unreadable.enqueue(op());
    await unreadable.drain();
    expect(drops(unreadable)).toEqual({ io_error: 1 });
    expect(store.putCalls).toHaveLength(0);
  });

  it('treats a corrupt policy.json on disk as "corrupt" with the default policy reader', async () => {
    fs.mkdirSync(memoryDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(policyPath(memoryDir), '{"schemaVersion": 9}');
    const queue = realQueue(new JsonMemoryStore(memoryDir));
    queue.enqueue(op());
    await queue.drain();
    expect(drops(queue)).toEqual({ corrupt: 1 });
  });
});

describe('dropPending (disable, exclude, delete)', () => {
  it('drops queued work that has not started, filtered by origin or all, and keeps the in-flight operation', async () => {
    const store = new FakeStore();
    const release = holdGate(store);
    const seen: Array<[string, DropReason]> = [];
    const { queue } = fakeQueue(store, { onDrop: (dropped, reason) => seen.push([dropped.opId, reason]) });
    queue.enqueue(op({ opId: 'running', origin: ORIGIN }));
    await new Promise<void>((resolve) => setImmediate(resolve));
    queue.enqueue(op({ opId: 'a', origin: ORIGIN }));
    queue.enqueue(op({ opId: 'b', origin: OTHER }));
    queue.enqueue(op({ opId: 'c', origin: OTHER }));

    expect(queue.dropPending('excluded', (candidate) => candidate.origin === OTHER)).toBe(2);
    expect(queue.dropPending('deleted', () => true)).toBe(1);
    expect(seen).toEqual([
      ['b', 'excluded'],
      ['c', 'excluded'],
      ['a', 'deleted'],
    ]);
    expect(queue.stats().pending).toBe(1);
    release();
    await queue.drain();
    expect(store.putCalls.map((record) => record.origin)).toEqual([ORIGIN]);
    expect(drops(queue)).toEqual({ excluded: 2, deleted: 1 });
  });

  it('drops all queued work on disable', async () => {
    const store = new FakeStore();
    const release = holdGate(store);
    const { queue } = fakeQueue(store);
    queue.enqueue(op());
    for (let i = 0; i < 4; i += 1) queue.enqueue(op({ origin: OTHER }));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(queue.dropPending('disabled')).toBe(4);
    release();
    await queue.drain();
    expect(drops(queue)).toEqual({ disabled: 4 });
  });

  it('does nothing and returns 0 when nothing matches', () => {
    const { queue } = fakeQueue(new FakeStore());
    expect(queue.dropPending('deleted')).toBe(0);
  });

  it('lets a dropped opId be enqueued again later', async () => {
    const store = new FakeStore();
    const release = holdGate(store);
    const { queue } = fakeQueue(store);
    queue.enqueue(op({ opId: 'x' }));
    await new Promise<void>((resolve) => setImmediate(resolve));
    queue.enqueue(op({ opId: 'y' }));
    queue.dropPending('disabled');
    release();
    await queue.drain();
    expect(queue.enqueue(op({ opId: 'y' })).accepted).toBe(true);
    await queue.drain();
  });
});

describe('single writer and drain notification', () => {
  it('never runs two commits at once', async () => {
    const store = new FakeStore();
    const { queue } = fakeQueue(store);
    for (let i = 0; i < 60; i += 1) queue.enqueue(op({ origin: `https://site-${i % 7}.example` }));
    await queue.drain();
    expect(store.maxActive).toBe(1);
    expect(queue.stats().committed).toBe(60);
  });

  it('commits in arrival order', async () => {
    const store = new FakeStore();
    const { queue } = fakeQueue(store);
    for (let i = 0; i < 10; i += 1) queue.enqueue(op({ origin: `https://site-${i}.example` }));
    await queue.drain();
    expect(store.putCalls.map((record) => record.origin)).toEqual(Array.from({ length: 10 }, (_, i) => `https://site-${i}.example`));
  });

  it('reports each committed operation and the time the queue drained', async () => {
    const store = new FakeStore();
    const committed: string[] = [];
    const drained: string[] = [];
    const { queue } = fakeQueue(store, { onCommit: (done) => committed.push(done.opId), onDrained: (through) => drained.push(through) });
    queue.enqueue(op({ opId: 'one' }));
    queue.enqueue(op({ opId: 'two' }));
    expect(drained).toEqual([]);
    await queue.drain();
    expect(committed).toEqual(['one', 'two']);
    expect(drained).toEqual([T3]);
  });

  it('resolves drain at once when idle', async () => {
    const { queue } = fakeQueue(new FakeStore());
    await queue.drain();
  });
});

describe('commit timeout of 2 s', () => {
  it('uses 2,000 ms by default', () => {
    const { queue } = fakeQueue(new FakeStore());
    expect(queue.stats().commitTimeoutMs).toBe(2000);
  });

  it('abandons a stuck commit, aborts its signal, drops it as "timeout", and keeps going', async () => {
    const store = new FakeStore();
    let first = true;
    store.putImpl = async () => {
      if (!first) return;
      first = false;
      await new Promise<void>(() => undefined);
    };
    const { queue } = fakeQueue(store, { commitTimeoutMs: 30 });
    queue.enqueue(op({ opId: 'stuck', origin: ORIGIN }));
    queue.enqueue(op({ opId: 'next', origin: OTHER }));
    await queue.drain();
    expect(store.signals[0]?.aborted).toBe(true);
    expect(drops(queue)).toEqual({ timeout: 1 });
    expect(store.putCalls.map((record) => record.origin)).toEqual([OTHER]);
    expect(queue.stats().committed).toBe(1);
  });

  it('removes the temp file and leaves the previous record when the real store is abandoned mid-write', async () => {
    await setPolicy();
    let calls = 0;
    const store = new JsonMemoryStore(memoryDir, {
      afterTempWrite: async () => {
        calls += 1;
        if (calls === 1) await new Promise<void>((resolve) => setTimeout(resolve, 120));
      },
    });
    const queue = realQueue(store, { commitTimeoutMs: 30 });
    queue.enqueue(op({ opId: 'slow' }));
    await queue.drain();
    expect(drops(queue)).toEqual({ timeout: 1 });
    // Let the abandoned write finish its delay and discover the abort.
    await new Promise<void>((resolve) => setTimeout(resolve, 200));
    const files = fs.readdirSync(path.join(memoryDir, 'sites'));
    expect(files).toEqual([]);
    expect(await store.getSite(ORIGIN)).toBeNull();

    queue.enqueue(op({ opId: 'fast' }));
    await queue.drain();
    expect(queue.stats().committed).toBe(1);
    expect(fs.readdirSync(path.join(memoryDir, 'sites'))).toEqual([siteFileName(ORIGIN)]);
  });
});

describe('failure reasons', () => {
  it('maps MEMORY_FULL from the store to "capacity" and keeps existing data', async () => {
    await setPolicy();
    const store = new JsonMemoryStore(memoryDir, { limits: { maxOrigins: 1 } });
    const queue = realQueue(store);
    queue.enqueue(op({ origin: ORIGIN }));
    queue.enqueue(op({ origin: OTHER }));
    await queue.drain();
    expect(drops(queue)).toEqual({ capacity: 1 });
    expect(await store.getSite(OTHER)).toBeNull();
    expect(await store.getSite(ORIGIN)).not.toBeNull();
  });

  it('maps an operation that would exceed 64 facts to "capacity" and leaves the site unchanged', async () => {
    await setPolicy();
    const store = new JsonMemoryStore(memoryDir);
    const queue = realQueue(store);
    const names = ['accept all', 'accept', 'reject', 'reject all', 'decline', 'menu', 'close', 'next', 'previous', 'back', 'home', 'help', 'language', 'settings', 'cart', 'checkout', 'submit', 'continue', 'send', 'save', 'sign in', 'log in', 'login', 'sign up', 'register'];
    const roles = ['button', 'link', 'tab'];
    const many = roles.flatMap((role) => names.map((name) => fact(controlFact(role, name))));
    expect(many.length).toBeGreaterThan(64);
    queue.enqueue(op({ type: 'facts', facts: many.slice(0, 64) }));
    await queue.drain();
    queue.enqueue(op({ type: 'facts', facts: many.slice(0, 65) }));
    await queue.drain();
    expect(drops(queue)).toEqual({ capacity: 1 });
    expect((await store.getSite(ORIGIN))!.facts).toHaveLength(64);
  });

  it('maps a write failure to "io_error" and an unreadable site file to "corrupt"', async () => {
    await setPolicy();
    const failing = new JsonMemoryStore(memoryDir, {
      rename: async () => {
        throw Object.assign(new Error('EIO'), { code: 'EIO' });
      },
    });
    const queue = realQueue(failing);
    queue.enqueue(op());
    await queue.drain();
    expect(drops(queue)).toEqual({ io_error: 1 });
    expect(fs.readdirSync(path.join(memoryDir, 'sites'))).toEqual([]);

    fs.writeFileSync(path.join(memoryDir, 'sites', siteFileName(ORIGIN)), '{"truncated":', { mode: 0o600 });
    const healthy = new JsonMemoryStore(memoryDir);
    const second = realQueue(healthy);
    second.enqueue(op());
    await second.drain();
    expect(drops(second)).toEqual({ corrupt: 1 });
    // The origin starts empty afterwards, so the next observation commits.
    second.enqueue(op());
    await second.drain();
    expect(second.stats().committed).toBe(1);
  });

  it('counts an unexpected exception from the store as "io_error" and keeps draining', async () => {
    const store = new FakeStore();
    let first = true;
    store.putImpl = async () => {
      if (first) {
        first = false;
        throw new Error('boom');
      }
    };
    const { queue } = fakeQueue(store);
    queue.enqueue(op());
    queue.enqueue(op({ origin: OTHER }));
    await queue.drain();
    expect(drops(queue)).toEqual({ io_error: 1 });
    expect(queue.stats().committed).toBe(1);
  });

  it('never throws out of drain', async () => {
    const store = new FakeStore();
    store.getSite = async () => {
      throw new MemoryStoreError('MEMORY_UNAVAILABLE', 'gone');
    };
    const { queue } = fakeQueue(store);
    queue.enqueue(op());
    await expect(queue.drain()).resolves.toBeUndefined();
  });
});

describe('applyOp reconciliation (R-10)', () => {
  function visit(at: string, profileId = 'profile-a'): CaptureOp {
    return op({ type: 'visit', at, profileId });
  }

  it('creates a record for a first visit with commitSeq 1', () => {
    const next = applyOp(null, visit(T1), T3);
    expect(next).toEqual({
      schemaVersion: 1,
      origin: ORIGIN,
      facts: [],
      profiles: { 'profile-a': { visit: { firstAt: T1, lastAt: T1, count: 1 } } },
      commitSeq: 1,
      updatedAt: T3,
    });
  });

  it('counts later visits per profile and keeps firstAt', () => {
    let site = applyOp(null, visit(T1), T1);
    site = applyOp(site, visit(T2), T2);
    site = applyOp(site, visit(T3, 'profile-b'), T3);
    expect(site.profiles['profile-a'].visit).toEqual({ firstAt: T1, lastAt: T2, count: 2 });
    expect(site.profiles['profile-b'].visit).toEqual({ firstAt: T3, lastAt: T3, count: 1 });
    expect(site.commitSeq).toBe(3);
    expect(site.facts).toEqual([]);
  });

  it('adds facts with first and last observation and records the verification for the observing profile only', () => {
    const language = fact(languageFact('ar', 'rtl'));
    const search = fact(searchFact('searchbox', 'Search'));
    const site = applyOp(null, op({ type: 'facts', facts: [language, search], at: T1, tool: 'browser_snapshot', path: '/search' }), T1);
    expect(site.facts.map((entry) => entry.factId)).toEqual(['site.language', 'ui.search']);
    expect(site.facts[0]).toEqual({ factId: 'site.language', kind: 'site.language', value: { lang: 'ar', dir: 'rtl' }, firstObserved: T1, lastObserved: T1, status: 'current' });
    expect(site.profiles['profile-a'].verifications).toEqual({
      'site.language': { at: T1, tool: 'browser_snapshot', path: '/search' },
      'ui.search': { at: T1, tool: 'browser_snapshot', path: '/search' },
    });
    expect(site.profiles['profile-a'].visit ?? null).toBeNull();
  });

  it('refreshes an identical fact instead of duplicating it, keeping firstObserved (AC-17)', () => {
    const language = fact(languageFact('ar', 'rtl'));
    let site = applyOp(null, op({ type: 'facts', facts: [language], at: T1, tool: 'browser_snapshot', path: '/login' }), T1);
    site = applyOp(site, op({ type: 'facts', facts: [language], at: T2, tool: 'browser_navigate', path: '/account' }), T2);
    expect(site.facts).toHaveLength(1);
    expect(site.facts[0].firstObserved).toBe(T1);
    expect(site.facts[0].lastObserved).toBe(T2);
    expect(site.profiles['profile-a'].verifications!['site.language']).toEqual({ at: T2, tool: 'browser_navigate', path: '/account' });
  });

  it('replaces a changed value with fresh provenance and keeps no history (AC-03, AC-24)', () => {
    let site = applyOp(null, op({ type: 'facts', facts: [fact(languageFact('ar', 'rtl'))], at: T1 }), T1);
    site = applyOp(site, op({ type: 'facts', facts: [fact(languageFact('en', 'ltr'))], at: T2 }), T2);
    expect(site.facts).toHaveLength(1);
    expect(site.facts[0].value).toEqual({ lang: 'en', dir: 'ltr' });
    expect(site.facts[0].firstObserved).toBe(T2);
    expect(JSON.stringify(site)).not.toContain('"ar"');
  });

  it('ignores a stale observation with a different value and never moves lastObserved backwards', () => {
    let site = applyOp(null, op({ type: 'facts', facts: [fact(languageFact('en', 'ltr'))], at: T2 }), T2);
    site = applyOp(site, op({ type: 'facts', facts: [fact(languageFact('ar', 'rtl'))], at: T1 }), T3);
    expect(site.facts[0].value).toEqual({ lang: 'en', dir: 'ltr' });
    site = applyOp(site, op({ type: 'facts', facts: [fact(languageFact('en', 'ltr'))], at: T1 }), T3);
    expect(site.facts[0].lastObserved).toBe(T2);
  });

  it('resolves an equal-time tie by commit order', () => {
    let site = applyOp(null, op({ type: 'facts', facts: [fact(languageFact('en', 'ltr'))], at: T1 }), T1);
    site = applyOp(site, op({ type: 'facts', facts: [fact(languageFact('ar', 'rtl'))], at: T1 }), T1);
    expect(site.facts[0].value).toEqual({ lang: 'ar', dir: 'rtl' });
  });

  it('keeps one verification per profile for the same fact', () => {
    const login = fact(loginFact(true, '/login'));
    let site = applyOp(null, op({ type: 'facts', facts: [login], profileId: 'profile-a', at: T1, tool: 'browser_snapshot', path: '/login' }), T1);
    site = applyOp(site, op({ type: 'facts', facts: [login], profileId: 'profile-b', at: T2, tool: 'browser_navigate', path: '/account/login' }), T2);
    expect(site.facts).toHaveLength(1);
    expect(site.profiles['profile-a'].verifications!['ui.login'].path).toBe('/login');
    expect(site.profiles['profile-b'].verifications!['ui.login'].path).toBe('/account/login');
  });

  it('keeps the fact and the verification time but stores no path when the path is not on the allowlist', () => {
    const language = fact(languageFact('ar', 'rtl'));
    for (const path of ['/' + 'a'.repeat(130), '/x?q=1', '/x#frag', 'relative', '/', '/not-a-segment', undefined]) {
      const site = applyOp(null, op({ type: 'facts', facts: [language], tool: 'browser_snapshot', path }), T1);
      expect(site.facts).toHaveLength(1);
      expect(site.profiles['profile-a'].verifications).toEqual({ 'site.language': { at: T1, tool: 'browser_snapshot' } });
    }
  });

  it('fails with MEMORY_FULL on a 65th fact or a 17th profile and does not touch the input', () => {
    const roles = ['button', 'link', 'tab', 'menuitem'];
    const names = ['accept all', 'accept', 'reject', 'reject all', 'decline', 'menu', 'close', 'next', 'previous', 'back', 'home', 'help', 'language', 'settings', 'cart', 'checkout'];
    const many = roles.flatMap((role) => names.map((name) => fact(controlFact(role, name))));
    expect(many).toHaveLength(64);
    const base = applyOp(null, op({ type: 'facts', facts: many }), T1);
    const before = structuredClone(base);
    expect(() => applyOp(base, op({ type: 'facts', facts: [fact(controlFact('button', 'save'))] }), T2)).toThrowError(
      expect.objectContaining({ code: 'MEMORY_FULL' }),
    );
    expect(base).toEqual(before);

    let site = applyOp(null, visit(T1, 'profile-0'), T1);
    for (let i = 1; i < 16; i += 1) site = applyOp(site, visit(T1, `profile-${i}`), T1);
    expect(Object.keys(site.profiles)).toHaveLength(16);
    expect(() => applyOp(site, visit(T1, 'profile-16'), T2)).toThrowError(expect.objectContaining({ code: 'MEMORY_FULL' }));
    expect(() => applyOp(site, visit(T2, 'profile-3'), T2)).not.toThrow();
  });
});

describe('concurrent captures and a writer killed mid-commit (AC-17, AC-19)', () => {
  const clients = ['profile-a', 'profile-b', 'profile-c', 'profile-d'];

  function captureOps(round: number): CaptureOp[] {
    return clients.map((profileId) =>
      op({
        type: 'facts',
        profileId,
        origin: ORIGIN,
        at: T2,
        enqueuedAt: T2,
        path: '/login',
        tool: 'browser_snapshot',
        facts: [
          fact(languageFact('ar', 'rtl')),
          fact(searchFact('searchbox', 'Search')),
          fact(controlFact('link', 'Sign in')),
        ],
        opId: `round-${round}-${profileId}`,
      }),
    );
  }

  it('leaves every file parseable with one current fact per id after 4 clients and a kill between temp write and rename', async () => {
    await setPolicy();
    let renames = 0;
    const dying = new JsonMemoryStore(memoryDir, {
      rename: async (from, to) => {
        renames += 1;
        if (renames === 2) throw new Error('killed between temp write and rename');
        fs.renameSync(from, to);
      },
    });
    const queue = realQueue(dying);
    for (const captured of captureOps(1)) queue.enqueue(captured);
    await queue.drain();
    for (const captured of captureOps(2)) queue.enqueue(captured);
    await queue.drain();
    // Each round is one group: one write. The second write dies between the temp write and the rename.
    expect(renames).toBe(2);
    expect(drops(queue)).toEqual({ io_error: 4 });
    expect(queue.stats().committed).toBe(4);

    // A restart sees only whole files and removes any temp file.
    const reopened = new JsonMemoryStore(memoryDir);
    const sitesDir = path.join(memoryDir, 'sites');
    for (const name of fs.readdirSync(sitesDir)) {
      expect(name.endsWith('.tmp'), name).toBe(false);
      expect(() => JSON.parse(fs.readFileSync(path.join(sitesDir, name), 'utf8')), name).not.toThrow();
    }
    const site = (await reopened.getSite(ORIGIN))!;
    const ids = site.facts.map((current) => current.factId);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual(['site.language', 'ui.control:link:sign in', 'ui.search']);
    expect(site.facts.every((current) => current.status === 'current')).toBe(true);
    // The killed commit is not half applied: no profile is recorded unless its commit landed.
    expect(Object.keys(site.profiles).length).toBeLessThanOrEqual(4);
  });

  it('applies one opId delivered twice exactly once (AC-19)', async () => {
    await setPolicy();
    const store = new JsonMemoryStore(memoryDir);
    const queue = realQueue(store);
    const visit = op({ opId: 'same-call' });
    expect(queue.enqueue(visit).accepted).toBe(true);
    expect(queue.enqueue({ ...visit }).accepted).toBe(false);
    await queue.drain();
    expect(queue.enqueue({ ...visit }).accepted).toBe(false);
    await queue.drain();
    expect((await store.getSite(ORIGIN))!.profiles['profile-a'].visit!.count).toBe(1);
    expect(drops(queue)).toEqual({ duplicate: 2 });
  });
});
