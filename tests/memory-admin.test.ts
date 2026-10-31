import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildIpcWelcome } from '../mcp-server/src/protocol/index.js';
import { MemoryService, type MemoryCall } from '../mcp-server/src/memory/service.js';
import { enablePolicy, defaultPolicy, readPolicy as readPolicyFile, writePolicy as writePolicyFile } from '../mcp-server/src/memory/policy.js';
import { JsonMemoryStore, siteFileName, type MemoryStore, type SiteRecord } from '../mcp-server/src/memory/store.js';
import {
  connectIpcClient,
  mkIsolatedStateDir,
  restartIsolatedDaemon,
  rmStateDir,
  siteRecordPath,
  startIsolatedDaemon,
  stopIsolatedDaemon,
  type DaemonHandle,
  type IpcClient,
} from './helpers/memory-fixtures.js';
import { freePort } from './helpers/free-port.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CLI = path.join(ROOT, 'scripts', 'memory.mjs');
const CONTRACT = JSON.parse(fs.readFileSync(path.join(ROOT, 'specs', '003-website-agent-memory', 'contracts', 'memory-admin-ipc.schema.json'), 'utf8'));

const ORIGIN_A = 'https://a.example';
const ORIGIN_B = 'https://b.example';

function site(origin: string): SiteRecord {
  return {
    schemaVersion: 1,
    origin,
    facts: [
      {
        factId: 'site.language',
        kind: 'site.language',
        value: { lang: 'ar', dir: 'rtl' },
        firstObserved: '2026-10-01T08:00:00.000Z',
        lastObserved: '2026-10-01T08:00:00.000Z',
        status: 'current',
      },
    ],
    profiles: { 'profile-1': { visit: { firstAt: '2026-10-01T08:00:00.000Z', lastAt: '2026-10-02T08:00:00.000Z', count: 2 } } },
    commitSeq: 1,
    updatedAt: '2026-10-02T08:00:00.000Z',
  };
}

async function seed(stateDir: string, origins: string[]): Promise<void> {
  const store = new JsonMemoryStore(path.join(stateDir, 'memory'));
  for (const origin of origins) await store.putSite(site(origin));
}

interface CliRun {
  code: number | null;
  stdout: string;
  stderr: string;
  json: any;
}

function runCli(args: string[], stateDir: string): Promise<CliRun> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      env: { ...process.env, BC_STATE_DIR: stateDir },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    const timer = setTimeout(() => child.kill('SIGKILL'), 15_000);
    child.once('close', (code) => {
      clearTimeout(timer);
      let json: unknown = null;
      try { json = JSON.parse(stdout); } catch { /* not JSON */ }
      resolve({ code, stdout, stderr, json });
    });
  });
}

/** The contract's response shape: only declared properties, correct types, `CODE: message` errors. */
function expectContractResponse(response: any, id?: string): void {
  const top = CONTRACT.$defs.response.properties;
  expect(Object.keys(response).filter((key) => !(key in top))).toEqual([]);
  expect(response.kind).toBe('memory-admin-result');
  expect(typeof response.id).toBe('string');
  if (id !== undefined) expect(response.id).toBe(id);
  expect(typeof response.success).toBe('boolean');
  if (response.success === false) expect(response.error).toMatch(/^[A-Z_]+: /u);
  if (response.error !== undefined) expect(typeof response.error).toBe('string');
  if (response.records !== undefined) expect(Array.isArray(response.records)).toBe(true);
  if (response.status !== undefined) {
    const status = CONTRACT.$defs.response.properties.status.properties;
    expect(Object.keys(response.status).filter((key) => !(key in status))).toEqual([]);
    expect(typeof response.status.enabled).toBe('boolean');
    for (const key of ['origins', 'bytes', 'queueDepth', 'quarantined']) expect(Number.isInteger(response.status[key])).toBe(true);
    expect(typeof response.status.dropped).toBe('object');
    expect(response.status.lastError === null || (typeof response.status.lastError.code === 'string' && typeof response.status.lastError.at === 'string')).toBe(true);
  }
}

let stateDir: string;
let daemon: DaemonHandle | null;
let client: IpcClient | null;
const extraDirs: string[] = [];

async function boot(): Promise<void> {
  daemon = await startIsolatedDaemon(stateDir, { wsPort: await freePort() });
}

/** One memory-admin request on the daemon's own authenticated IPC socket. */
async function rawAdmin(request: Record<string, unknown>): Promise<any> {
  const link = await connectIpcClient(daemon!.sockPath, daemon!.token, 'admin-test');
  client = link;
  return new Promise((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => reject(new Error('no memory-admin answer')), 5000);
    link.socket.on('data', (chunk: string) => {
      buffer += chunk;
      for (const line of buffer.split('\n')) {
        try {
          const message = JSON.parse(line);
          if (message.kind === 'memory-admin-result') {
            clearTimeout(timer);
            resolve(message);
          }
        } catch { /* partial line */ }
      }
    });
    link.socket.write(`${JSON.stringify(request)}\n`);
  });
}

beforeEach(() => {
  stateDir = mkIsolatedStateDir('bc-memadmin-');
  daemon = null;
  client = null;
});

afterEach(async () => {
  client?.close();
  if (daemon) await stopIsolatedDaemon(daemon);
  rmStateDir(stateDir);
  for (const dir of extraDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('owner CLI over IPC (US2)', () => {
  it('status prints the contract shape, and the token appears nowhere', async () => {
    await boot();
    const out = await runCli(['status'], stateDir);
    expect(out.code).toBe(0);
    expectContractResponse(out.json);
    expect(out.json).toMatchObject({ success: true, status: { enabled: false, origins: 0, queueDepth: 0, quarantined: 0, lastError: null } });
    expect(out.stdout + out.stderr).not.toContain(daemon!.token);
  });

  it('enable and disable change policy.json and report the new state', async () => {
    await boot();
    const enabled = await runCli(['enable'], stateDir);
    expect(enabled.code).toBe(0);
    expectContractResponse(enabled.json);
    expect(enabled.json.status.enabled).toBe(true);
    expect(readPolicyFile(path.join(stateDir, 'memory')).enabled).toBe(true);

    const disabled = await runCli(['disable'], stateDir);
    expect(disabled.json.status.enabled).toBe(false);
    expect(readPolicyFile(path.join(stateDir, 'memory')).enabled).toBe(false);
  });

  it('exclude and include take a canonical origin; the CLI normalizes the one it is given', async () => {
    await boot();
    const excluded = await runCli(['exclude', 'HTTPS://A.Example:443/some/path?q=1'], stateDir);
    expect(excluded.code).toBe(0);
    expectContractResponse(excluded.json);
    expect(readPolicyFile(path.join(stateDir, 'memory')).excluded).toEqual([ORIGIN_A]);

    const included = await runCli(['include', ORIGIN_A], stateDir);
    expect(included.code).toBe(0);
    expect(readPolicyFile(path.join(stateDir, 'memory')).excluded).toEqual([]);
  });

  it.each([['not a url'], ['ftp://a.example'], ['file:///etc/passwd'], ['javascript:alert(1)']])('refuses the origin %s without changing anything', async (origin) => {
    await boot();
    const before = fs.existsSync(path.join(stateDir, 'memory', 'policy.json'));
    const out = await runCli(['exclude', origin], stateDir);
    expect(out.code).toBe(2);
    expect(fs.existsSync(path.join(stateDir, 'memory', 'policy.json'))).toBe(before);
  });

  it('inspect returns one origin as stored, and an unknown origin gives no records', async () => {
    await seed(stateDir, [ORIGIN_A, ORIGIN_B]);
    await boot();
    const known = await runCli(['inspect', ORIGIN_A], stateDir);
    expect(known.code).toBe(0);
    expectContractResponse(known.json);
    expect(known.json.records).toHaveLength(1);
    expect(known.json.records[0]).toMatchObject({ origin: ORIGIN_A, schemaVersion: 1 });

    const unknown = await runCli(['inspect', 'https://nowhere.example'], stateDir);
    expect(unknown.code).toBe(0);
    expect(unknown.json.records).toEqual([]);
  });

  it('export returns every origin, and status counts them with bytes', async () => {
    await seed(stateDir, [ORIGIN_A, ORIGIN_B]);
    await boot();
    const exported = await runCli(['export'], stateDir);
    expect(exported.code).toBe(0);
    expectContractResponse(exported.json);
    expect(exported.json.records.map((record: SiteRecord) => record.origin).sort()).toEqual([ORIGIN_A, ORIGIN_B]);

    const status = await runCli(['status'], stateDir);
    expect(status.json.status.origins).toBe(2);
    expect(status.json.status.bytes).toBeGreaterThan(0);
  });

  it('AC-11: delete <origin> removes that origin only, and it stays absent after a restart', async () => {
    await seed(stateDir, [ORIGIN_A, ORIGIN_B]);
    await boot();
    const out = await runCli(['delete', ORIGIN_A], stateDir);
    expect(out.code).toBe(0);
    expectContractResponse(out.json);
    expect(fs.existsSync(siteRecordPath(stateDir, ORIGIN_A))).toBe(false);
    expect(fs.existsSync(siteRecordPath(stateDir, ORIGIN_B))).toBe(true);

    daemon = await restartIsolatedDaemon(daemon!);
    const inspected = await runCli(['inspect', ORIGIN_A], stateDir);
    expect(inspected.json.records).toEqual([]);
    expect((await runCli(['inspect', ORIGIN_B], stateDir)).json.records).toHaveLength(1);
  });

  it('delete --all empties the store, and a bare delete is a usage error that changes nothing', async () => {
    await seed(stateDir, [ORIGIN_A, ORIGIN_B]);
    await boot();
    const bare = await runCli(['delete'], stateDir);
    expect(bare.code).toBe(2);
    expect(fs.existsSync(siteRecordPath(stateDir, ORIGIN_A))).toBe(true);

    const all = await runCli(['delete', '--all'], stateDir);
    expect(all.code).toBe(0);
    expectContractResponse(all.json);
    expect(fs.existsSync(siteRecordPath(stateDir, ORIGIN_A))).toBe(false);
    expect(fs.existsSync(siteRecordPath(stateDir, ORIGIN_B))).toBe(false);

    daemon = await restartIsolatedDaemon(daemon!);
    expect((await runCli(['export'], stateDir)).json.records).toEqual([]);
  });

  it('an unknown command is a usage error', async () => {
    await boot();
    const out = await runCli(['frobnicate'], stateDir);
    expect(out.code).toBe(2);
    expect(out.stdout).toBe('');
  });

  it('with the daemon stopped it exits non-zero and changes nothing', async () => {
    await seed(stateDir, [ORIGIN_A]);
    fs.writeFileSync(path.join(stateDir, 'token.json'), JSON.stringify({ token: 'stopped-daemon-token' }), { mode: 0o600 });
    const before = fs.readdirSync(path.join(stateDir, 'memory')).sort();
    for (const args of [['enable'], ['delete', '--all'], ['status']]) {
      const out = await runCli(args, stateDir);
      expect(out.code).toBe(3);
      expect(out.stdout + out.stderr).not.toContain('stopped-daemon-token');
    }
    expect(fs.readdirSync(path.join(stateDir, 'memory')).sort()).toEqual(before);
    expect(fs.existsSync(siteRecordPath(stateDir, ORIGIN_A))).toBe(true);
  });

  describe('against a daemon that cannot serve memory-admin', () => {
    async function fakeDaemon(reply: (line: any) => unknown): Promise<{ received: any[]; close(): Promise<void>; dir: string }> {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-oldd-'));
      extraDirs.push(dir);
      fs.writeFileSync(path.join(dir, 'token.json'), JSON.stringify({ token: 'old-daemon-token' }), { mode: 0o600 });
      const received: any[] = [];
      const server = net.createServer((socket) => {
        socket.setEncoding('utf8');
        let buffer = '';
        socket.on('data', (chunk: string) => {
          buffer += chunk;
          let newline: number;
          while ((newline = buffer.indexOf('\n')) >= 0) {
            const line = JSON.parse(buffer.slice(0, newline));
            buffer = buffer.slice(newline + 1);
            received.push(line);
            const answer = reply(line);
            if (answer) socket.write(`${JSON.stringify(answer)}\n`);
          }
        });
      });
      await new Promise<void>((resolve) => server.listen(path.join(dir, 'daemon.sock'), resolve));
      return { received, dir, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
    }

    it('an older daemon without the memory-admin capability stops the CLI before any request is sent', async () => {
      const old = await fakeDaemon((line) => (line.kind === 'hello' ? buildIpcWelcome('old-session') : null));
      try {
        const out = await runCli(['enable'], old.dir);
        expect(out.code).toBe(4);
        expect(old.received.map((line) => line.kind)).toEqual(['hello']);
        expect(out.stdout + out.stderr).not.toContain('old-daemon-token');
      } finally {
        await old.close();
      }
    });

    it('a daemon that denies the hello stops the CLI, and the token is not echoed', async () => {
      const denying = await fakeDaemon((line) => (line.kind === 'hello' ? { kind: 'denied', reason: 'bad token' } : null));
      try {
        const out = await runCli(['status'], denying.dir);
        expect(out.code).toBe(3);
        expect(denying.received.map((line) => line.kind)).toEqual(['hello']);
        expect(out.stdout + out.stderr).not.toContain('old-daemon-token');
      } finally {
        await denying.close();
      }
    });
  });
});

describe('memory-admin on the IPC socket', () => {
  it('rejects unknown fields, bad origins and unknown commands with INVALID_ARGUMENT', async () => {
    await boot();
    for (const bad of [
      { kind: 'memory-admin', id: 'b1', command: 'enable', extra: true },
      { kind: 'memory-admin', id: 'b2', command: 'exclude', origin: 'https://a.example/path' },
      { kind: 'memory-admin', id: 'b3', command: 'exclude' },
      { kind: 'memory-admin', id: 'b4', command: 'wipe' },
    ]) {
      const answer = await rawAdmin(bad);
      expectContractResponse(answer, bad.id);
      expect(answer.success).toBe(false);
      expect(answer.error).toMatch(/^INVALID_ARGUMENT:/u);
    }
    expect(fs.existsSync(path.join(stateDir, 'memory', 'policy.json'))).toBe(false);
  });
});

describe('AC-11: queued captures stop at disable, exclude and delete', () => {
  /** A real JSON store whose commits take a few milliseconds, so work is still queued when the command arrives. */
  class SlowStore implements MemoryStore {
    readonly inner: JsonMemoryStore;
    constructor(dir: string) { this.inner = new JsonMemoryStore(dir); }
    async putSite(record: SiteRecord, options?: { signal?: AbortSignal }): Promise<void> {
      await new Promise((resolve) => setTimeout(resolve, 8));
      await this.inner.putSite(record, options);
    }
    getSite(origin: string) { return this.inner.getSite(origin); }
    deleteSite(origin: string) { return this.inner.deleteSite(origin); }
    deleteAll() { return this.inner.deleteAll(); }
    listSites() { return this.inner.listSites(); }
    status() { return this.inner.status(); }
  }

  let dir: string;
  let memoryDir: string;
  let store: SlowStore;
  let service: MemoryService;
  let clock: number;

  const context = (origin: string) => ({ url: `${origin}/`, incognito: false, topLevel: true, stable: true, lang: 'ar', dir: 'rtl', passwordField: false, anonymous: true, anonymityReason: 'ok' });
  const call: MemoryCall = { observe: true, browserId: 'profile-a', connectionIdBefore: 'conn-1' };

  function visit(origin: string, n: number): void {
    service.afterCall(call, {
      sessionId: 's1',
      tool: 'browser_navigate',
      params: { url: `${origin}/` },
      daemonCallId: `${origin}-${n}`,
      result: { success: true, url: `${origin}/`, tabId: 7, text: `navigated to ${origin}/` },
      observation: { siteContext: context(origin), digestBefore: 'a', digestAfter: 'a', sanitizedUnchanged: true },
    });
  }

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-memq-'));
    memoryDir = path.join(dir, 'memory');
    clock = Date.parse('2026-10-27T10:00:00.000Z');
    store = new SlowStore(memoryDir);
    service = new MemoryService({
      memoryDir,
      vault: { memoryEligibility: () => 'clear' },
      connection: () => ({ browserId: 'profile-a', connectionId: 'conn-1', ambiguous: false, supportsSiteContext: true }),
      now: () => clock,
      store,
    });
    await writePolicyFile(memoryDir, enablePolicy(defaultPolicy(), new Date(clock).toISOString()));
    clock += 1000;
  });

  afterEach(async () => {
    await service.flush().catch(() => undefined);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const queue = (a: number, b: number) => {
    for (let n = 0; n < a; n++) visit(ORIGIN_A, n);
    for (let n = 0; n < b; n++) visit(ORIGIN_B, n);
  };

  /** What is really on disk: origin and commit sequence. A discarded write changes nothing here. */
  const onDisk = async () => JSON.stringify((await store.listSites()).map((record) => [record.origin, record.commitSeq]).sort());

  it('delete: nothing for the deleted origin is written afterwards, even with 50 captures queued', async () => {
    queue(50, 5);
    const answer = await service.admin({ kind: 'memory-admin', id: 'd1', command: 'delete', origin: ORIGIN_A });
    expect(answer.success).toBe(true);
    await service.flush();
    expect(await store.getSite(ORIGIN_A)).toBeNull();
    expect(fs.existsSync(path.join(memoryDir, 'sites', siteFileName(ORIGIN_A)))).toBe(false);
  });

  it('disable: nothing is written after the command', async () => {
    queue(25, 25);
    await service.admin({ kind: 'memory-admin', id: 'x1', command: 'disable' });
    const atCommand = await onDisk();
    await service.flush();
    expect(await onDisk()).toBe(atCommand);
  });

  it('exclude: nothing is written for that origin afterwards, other origins keep working', async () => {
    queue(25, 5);
    await service.admin({ kind: 'memory-admin', id: 'e1', command: 'exclude', origin: ORIGIN_A });
    const atCommand = JSON.parse(await onDisk()) as Array<[string, number]>;
    await service.flush();
    const after = JSON.parse(await onDisk()) as Array<[string, number]>;
    expect(after.find(([origin]) => origin === ORIGIN_A)).toEqual(atCommand.find(([origin]) => origin === ORIGIN_A));
    expect(after.some(([origin]) => origin === ORIGIN_B)).toBe(true);
  });
});

describe('007: the owner\'s controls over the form shape facts', () => {
  /** A site that holds one shape fact and a counter for each of two profiles. */
  function shapeSite(origin: string): SiteRecord {
    return {
      schemaVersion: 1,
      origin,
      facts: [
        {
          factId: 'ui.form.shape:/login',
          kind: 'ui.form.shape',
          value: { shape: { fields: 3, required: 1, types: ['checkbox', 'password', 'text'], hidden: true }, commit: 'unknown' },
          firstObserved: '2026-10-01T08:00:00.000Z',
          lastObserved: '2026-10-01T08:00:00.000Z',
          status: 'current',
        },
      ],
      profiles: {
        'profile-1': { visit: { firstAt: '2026-10-01T08:00:00.000Z', lastAt: '2026-10-02T08:00:00.000Z', count: 2 }, hidden: { count: 3 } },
        'profile-2': { hidden: { count: 1 } },
      },
      commitSeq: 1,
      updatedAt: '2026-10-02T08:00:00.000Z',
    };
  }

  let dir: string;
  let memoryDir: string;
  let store: JsonMemoryStore;
  let service: MemoryService;
  let clock: number;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-shape-admin-'));
    memoryDir = path.join(dir, 'memory');
    clock = Date.parse('2026-10-27T10:00:00.000Z');
    store = new JsonMemoryStore(memoryDir);
    service = new MemoryService({
      memoryDir,
      vault: { memoryEligibility: () => 'clear' },
      connection: () => ({ browserId: 'profile-a', connectionId: 'conn-1', ambiguous: false, supportsSiteContext: true }),
      now: () => clock,
      store,
    });
    await writePolicyFile(memoryDir, enablePolicy(defaultPolicy(), new Date(clock).toISOString()));
  });

  afterEach(async () => {
    await service.flush().catch(() => undefined);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('export lists the shape fact and the counter of every profile', async () => {
    await store.putSite(shapeSite(ORIGIN_A));
    const answer = await service.admin({ kind: 'memory-admin', id: 'e1', command: 'export' });
    expect(answer.success).toBe(true);
    const records = (answer as { records?: SiteRecord[] }).records ?? [];
    expect(records[0].facts.map((fact) => fact.factId)).toEqual(['ui.form.shape:/login']);
    expect(records[0].profiles['profile-1'].hidden).toEqual({ count: 3 });
    expect(records[0].profiles['profile-2'].hidden).toEqual({ count: 1 });
  });

  it('inspect shows the shape fact and the counters as they are stored', async () => {
    await store.putSite(shapeSite(ORIGIN_A));
    const answer = await service.admin({ kind: 'memory-admin', id: 'i1', command: 'inspect', origin: ORIGIN_A });
    const records = (answer as { records?: SiteRecord[] }).records ?? [];
    expect(records[0].facts[0].kind).toBe('ui.form.shape');
    expect(records[0].profiles['profile-1'].hidden?.count).toBe(3);
    expect(records[0].profiles['profile-2'].hidden?.count).toBe(1);
  });

  it('delete <origin> removes the shape fact and the counter of every profile', async () => {
    await store.putSite(shapeSite(ORIGIN_A));
    await store.putSite(shapeSite(ORIGIN_B));
    const answer = await service.admin({ kind: 'memory-admin', id: 'd1', command: 'delete', origin: ORIGIN_A });
    expect(answer.success).toBe(true);
    expect(await store.getSite(ORIGIN_A)).toBeNull();
    expect(fs.existsSync(path.join(memoryDir, 'sites', siteFileName(ORIGIN_A)))).toBe(false);
    // The other origin keeps its shape fact and its counters.
    const kept = await store.getSite(ORIGIN_B);
    expect(kept?.facts[0].kind).toBe('ui.form.shape');
    expect(kept?.profiles['profile-2'].hidden?.count).toBe(1);
  });

  it('delete --all leaves no shape fact and no counter anywhere', async () => {
    await store.putSite(shapeSite(ORIGIN_A));
    await store.putSite(shapeSite(ORIGIN_B));
    const answer = await service.admin({ kind: 'memory-admin', id: 'd2', command: 'delete', all: true });
    expect(answer.success).toBe(true);
    expect(await store.listSites()).toEqual([]);
  });

  it('exclude stops the collection and delete removes what was stored (003 FR-004)', async () => {
    await store.putSite(shapeSite(ORIGIN_A));
    const excluded = await service.admin({ kind: 'memory-admin', id: 'x1', command: 'exclude', origin: ORIGIN_A });
    expect(excluded.success).toBe(true);
    expect(readPolicyFile(memoryDir).excluded).toEqual([ORIGIN_A]);
    // Excluding stops the collection; the stored record stays until the owner deletes it.
    expect(await store.getSite(ORIGIN_A)).not.toBeNull();
    const deleted = await service.admin({ kind: 'memory-admin', id: 'd3', command: 'delete', origin: ORIGIN_A });
    expect(deleted.success).toBe(true);
    expect(await store.getSite(ORIGIN_A)).toBeNull();
  });
});
