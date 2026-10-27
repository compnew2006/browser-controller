/**
 * Regressions for the /code-review findings on website memory (daemon side): #1 no tab read while memory is
 * off, #5 connection change during the browser_memory context read, #8 bounded owner commands under load,
 * #9 recovery from a corrupt policy.json, #10 startup temp cleanup vs an in-flight policy write, #11 the
 * internal context action's timeout, #12 the queue cap counts every op held.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MemoryService, type MemoryConnection } from '../mcp-server/src/memory/service.js';
import { defaultPolicy, readPolicy, writePolicy, type MemoryPolicy } from '../mcp-server/src/memory/policy.js';
import { JsonMemoryStore, type MemoryStore, type PutSiteOptions, type SiteRecord, type MemoryStoreStatus } from '../mcp-server/src/memory/store.js';
import { MAX_GROUP_ENTRIES, MemoryQueue, type CaptureOp } from '../mcp-server/src/memory/queue.js';
import { runAdminCommand, type AdminContext } from '../mcp-server/src/memory/admin.js';
import { routeMemoryTool, CONTEXT_ACTION, type MemoryToolBridge } from '../mcp-server/src/memory/tool-route.js';
import { routeMemoryPolicyTool } from '../mcp-server/src/memory/policy-tool-route.js';
import { toolTimeoutMs } from '../mcp-server/src/tools/index.js';
import { isKnownWireTool } from '../mcp-server/src/wire-tools.js';
import type { MemoryAdminStatus } from '../mcp-server/src/daemon-config.js';

const ORIGIN = 'https://example.com';
const T0 = '2026-10-27T09:00:00.000Z';

let root: string;
let memoryDir: string;
let conn: MemoryConnection;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-cr-'));
  memoryDir = path.join(root, 'memory');
  conn = { browserId: 'profile-a', connectionId: 'conn-1', ambiguous: false, supportsSiteContext: true };
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const signal = new AbortController().signal;
const siteContext = { url: `${ORIGIN}/`, incognito: false, topLevel: true, stable: true, anonymous: true, anonymityReason: 'ok', lang: 'en', dir: 'ltr', passwordField: false };

function makeService(store?: MemoryStore): MemoryService {
  return new MemoryService({ memoryDir, vault: { memoryEligibility: () => 'clear' }, connection: () => ({ ...conn }), store });
}

async function enable(over: Partial<MemoryPolicy> = {}): Promise<void> {
  await writePolicy(memoryDir, { ...defaultPolicy(), enabled: true, enabledAt: T0, updatedAt: T0, ...over });
}

function spyBridge(onCall: () => unknown = () => ({ success: true, siteContext })): MemoryToolBridge & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async callTool(tool) {
      calls.push(tool);
      return onCall();
    },
  };
}

describe('#1 browser_memory reads nothing from the tab while memory is off', () => {
  it('memory off (no policy file): MEMORY_DISABLED with no extension call at all', async () => {
    const service = makeService();
    const bridge = spyBridge();
    const out = await routeMemoryTool(service, bridge, 's1', 'agent', { tabId: 7 }, signal);
    expect(out).toMatchObject({ success: false });
    expect(out.error).toMatch(/^MEMORY_DISABLED:/);
    expect(bridge.calls).toEqual([]);
  });

  it('an extension without site-context: MEMORY_NOT_SUPPORTED with no extension call', async () => {
    await enable();
    conn.supportsSiteContext = false;
    const bridge = spyBridge();
    const out = await routeMemoryTool(makeService(), bridge, 's1', 'agent', { tabId: 7 }, signal);
    expect(out.error).toMatch(/^MEMORY_NOT_SUPPORTED:/);
    expect(bridge.calls).toEqual([]);
  });

  it('memory on: the tab is read under the tab lock, and a locked tab still answers TAB_LOCKED', async () => {
    await enable();
    const locked = spyBridge(() => { throw new Error('TAB_LOCKED: tab 7 is controlled by another session'); });
    const out = await routeMemoryTool(makeService(), locked, 's1', 'agent', { tabId: 7 }, signal);
    expect(locked.calls).toEqual([CONTEXT_ACTION]);
    expect(out.error).toMatch(/^TAB_LOCKED:/);
    const open = spyBridge();
    expect(await routeMemoryTool(makeService(), open, 's1', 'agent', { tabId: 7 }, signal)).toMatchObject({ success: true });
  });

  it('browser_memory_policy is unchanged: a scoped request still resolves the tab while memory is off', async () => {
    const bridge = spyBridge();
    const out = await routeMemoryPolicyTool(makeService(), bridge, 's1', 'agent', { action: 'exclude', tabId: 7 }, signal);
    expect(bridge.calls).toEqual([CONTEXT_ACTION]);
    expect(out.error).toMatch(/^ACTION_NOT_CONFIRMED:/);
  });
});

describe('#5 browser_memory: a connection change during the context read fails closed', () => {
  it('the connection is taken before the read and compared after it', async () => {
    await enable();
    const bridge = spyBridge(() => {
      conn = { ...conn, browserId: 'profile-b', connectionId: 'conn-2' };
      return { success: true, siteContext };
    });
    const out = await routeMemoryTool(makeService(), bridge, 's1', 'agent', { tabId: 7 }, signal);
    expect(out.error).toMatch(/^MEMORY_SCOPE_UNKNOWN:/);
  });

  it('the same for a confirmed browser_memory_policy inspect', async () => {
    await enable();
    const bridge = spyBridge(() => {
      conn = { ...conn, connectionId: `conn-${bridge.calls.length + 1}` };
      return { success: true, siteContext };
    });
    const out = await routeMemoryPolicyTool(makeService(), bridge, 's1', 'agent', { action: 'inspect', tabId: 7, ownerConfirmed: true, confirmedOrigin: ORIGIN }, signal);
    expect(out.error).toMatch(/^MEMORY_SCOPE_UNKNOWN:/);
  });
});

describe('routeMemoryPolicyTool refusal payload', () => {
  it('the unconfirmed refusal says success:false in its payload too', async () => {
    const out = await routeMemoryPolicyTool(makeService(), spyBridge(), 's1', 'agent', { action: 'enable' }, signal);
    expect(out.success).toBe(false);
    expect(out.result).toMatchObject({ success: false, ownerConfirmationRequired: true });
  });
});

describe('#11 the internal context action has a bounded timeout', () => {
  it('uses 10 s like browser_memory, never the 30 s bridge default', () => {
    expect(toolTimeoutMs(CONTEXT_ACTION)).toBe(10_000);
    expect(toolTimeoutMs('browser_memory')).toBe(10_000);
  });

  it('stays unreachable for IPC clients', () => {
    expect(isKnownWireTool(CONTEXT_ACTION)).toBe(false);
  });
});

class GatedStore implements MemoryStore {
  records = new Map<string, SiteRecord>();
  gate: Promise<void> = Promise.resolve();
  writeMs = 0;
  puts: Array<{ origin: string; at: number }> = [];

  async getSite(origin: string): Promise<SiteRecord | null> {
    await this.gate;
    const found = this.records.get(origin);
    return found ? structuredClone(found) : null;
  }

  async putSite(record: SiteRecord, _options?: PutSiteOptions): Promise<void> {
    if (this.writeMs) await new Promise((resolve) => setTimeout(resolve, this.writeMs));
    this.records.set(record.origin, structuredClone(record));
    this.puts.push({ origin: record.origin, at: Date.now() });
  }

  async deleteSite(origin: string): Promise<boolean> { return this.records.delete(origin); }
  async deleteAll(): Promise<number> { const n = this.records.size; this.records.clear(); return n; }
  async listSites(): Promise<SiteRecord[]> { return [...this.records.values()]; }
  async status(): Promise<MemoryStoreStatus> { return { origins: this.records.size, totalBytes: 0, corrupt: [] }; }
}

let opCounter = 0;
function op(origin: string, over: Partial<CaptureOp> = {}): CaptureOp {
  opCounter += 1;
  const at = new Date().toISOString();
  return { opId: `op-${opCounter}`, type: 'visit', profileId: 'profile-a', origin, at, enqueuedAt: at, facts: [], ...over };
}

describe('#12 the queue cap bounds distinct origins held, in flight included', () => {
  it('a held origin folds without limit, a new origin past the cap is queue_full, and stats agree', async () => {
    await enable();
    const store = new GatedStore();
    let release!: () => void;
    store.gate = new Promise<void>((resolve) => { release = resolve; });
    const queue = new MemoryQueue({ store, memoryDir });
    for (let i = 0; i < 256; i += 1) expect(queue.enqueue(op(ORIGIN)).accepted).toBe(true);
    await new Promise((resolve) => setImmediate(resolve));
    expect(queue.stats().inFlight).toBe(true);
    for (let i = 1; i < 256; i += 1) expect(queue.enqueue(op(`https://site-${i}.example`)).accepted).toBe(true);
    expect(queue.enqueue(op('https://one-too-many.example'))).toMatchObject({ accepted: false, reason: 'queue_full' });
    for (let i = 0; i < 256; i += 1) expect(queue.enqueue(op(ORIGIN)).accepted).toBe(true);
    const stats = queue.stats();
    expect(stats.groups).toBeLessThanOrEqual(stats.maxPending);
    expect(stats.maxGroupEntries).toBeLessThanOrEqual(MAX_GROUP_ENTRIES);
    expect(stats.pending).toBe(256 + 255 + 256);
    expect(stats.dropped.queue_full).toBe(1);
    release();
    await queue.drain();
    expect(queue.stats().committed).toBe(256 + 255 + 256);
  });
});

function adminContext(queue: MemoryQueue, store: MemoryStore): AdminContext {
  let tail: Promise<unknown> = Promise.resolve();
  return {
    iso: () => new Date().toISOString(),
    store,
    queue,
    mutatePolicy(change) {
      const run = tail.then(async () => {
        const next = change(readPolicy(memoryDir));
        await writePolicy(memoryDir, next);
        return next;
      });
      tail = run.catch(() => undefined);
      return run;
    },
    status: async () => ({ enabled: readPolicy(memoryDir).enabled } as MemoryAdminStatus),
  };
}

describe('#8 owner commands wait only for work that could still write the affected origin', () => {
  it('a steady stream of other-origin captures does not hold exclude past the bound, and AC-11 still holds', async () => {
    await enable();
    const store = new GatedStore();
    store.writeMs = 15;
    const queue = new MemoryQueue({ store, memoryDir, commitTimeoutMs: 500 });
    const target = 'https://a.example';
    for (let i = 0; i < 3; i += 1) queue.enqueue(op(target));
    let streaming = true;
    let n = 0;
    const stream = (async () => {
      while (streaming) {
        n += 1;
        queue.enqueue(op(`https://other${n % 5}.example`));
        await new Promise((resolve) => setTimeout(resolve, 2));
      }
    })();
    await new Promise((resolve) => setTimeout(resolve, 5));
    const started = Date.now();
    const answer = await runAdminCommand(adminContext(queue, store), { kind: 'memory-admin', id: 'x', command: 'exclude', origin: target });
    const answeredAt = Date.now();
    expect(answer.success).toBe(true);
    // Bound: one commit timeout plus margin, never "until the queue is empty".
    expect(answeredAt - started).toBeLessThan(1_500);
    await new Promise((resolve) => setTimeout(resolve, 200));
    streaming = false;
    await stream;
    await queue.drain();
    expect(store.puts.filter((put) => put.origin === target && put.at > answeredAt)).toEqual([]);
  }, 10_000);
});

describe('#9 a corrupt policy.json can be reset by the owner', () => {
  async function corrupt(): Promise<void> {
    await enable();
    fs.writeFileSync(path.join(memoryDir, 'policy.json'), '{"schemaVersion": 1, "enab', { mode: 0o600 });
  }
  const corruptCopies = () => fs.readdirSync(memoryDir).filter((name) => name.startsWith('policy.json.corrupt-'));

  it('disable quarantines the corrupt file and writes a fresh, disabled policy', async () => {
    await corrupt();
    const service = makeService();
    const answer = await service.admin({ kind: 'memory-admin', id: 'd', command: 'disable' });
    expect(answer.success).toBe(true);
    expect(readPolicy(memoryDir).enabled).toBe(false);
    expect(corruptCopies()).toHaveLength(1);
    expect((await service.status()).quarantined).toBeGreaterThanOrEqual(1);
  });

  it('delete --all also recovers, and leaves memory disabled', async () => {
    await corrupt();
    const answer = await makeService().admin({ kind: 'memory-admin', id: 'a', command: 'delete', all: true });
    expect(answer.success).toBe(true);
    const policy = readPolicy(memoryDir);
    expect(policy.enabled).toBe(false);
    expect(Object.keys(policy.deletions)).toEqual(['*']);
    expect(corruptCopies()).toHaveLength(1);
  });

  it('enable refuses on a corrupt file and names the reset; capture stays off', async () => {
    await corrupt();
    const service = makeService();
    const answer = await service.admin({ kind: 'memory-admin', id: 'e', command: 'enable' });
    expect(answer.success).toBe(false);
    expect(answer.error).toMatch(/^MEMORY_CORRUPT:.*disable/);
    expect(service.beginCall('s1', 'browser_navigate').observe).toBe(false);
    expect(corruptCopies()).toHaveLength(0);
  });
});

describe('#10 store start-up never removes the temp file of a policy write in flight', () => {
  it('a policy write racing store.warm() succeeds', async () => {
    const store = new JsonMemoryStore(memoryDir);
    await writePolicy(memoryDir, defaultPolicy(), {
      rename: async (from, to) => {
        await store.warm();
        await fsp.rename(from, to);
      },
    });
    expect(readPolicy(memoryDir).enabled).toBe(false);
  });

  it('a stale policy temp file left by a crash is still removed', async () => {
    fs.mkdirSync(memoryDir, { recursive: true, mode: 0o700 });
    const stale = path.join(memoryDir, 'policy.json.123.abcdef.tmp');
    fs.writeFileSync(stale, '{}', { mode: 0o600 });
    const old = new Date(Date.now() - 10 * 60_000);
    fs.utimesSync(stale, old, old);
    await new JsonMemoryStore(memoryDir).warm();
    expect(fs.existsSync(stale)).toBe(false);
  });
});
