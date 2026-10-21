import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DAEMON_START_WAIT_MS,
  MAX_RECONNECT_ATTEMPTS,
  MAX_RESPAWNS,
  RECONNECT_BACKOFF_MS,
  RESPAWN_WINDOW_MS,
  Reconnector,
  STARTING_WAIT_MS,
  type DaemonState,
  type ReconnectDeps,
} from '../mcp-server/src/daemon-reconnect.js';
import { openDaemonLog } from '../mcp-server/src/daemon-config.js';

/**
 * The thin client's reconnect policy (index.ts wires it to the real socket).
 * Before 3.0.5 a client reconnected exactly once: after a second daemon
 * restart every call failed NOT_CONNECTED until the MCP host restarted it.
 */

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

interface Fake {
  deps: ReconnectDeps;
  calls: { connect: number; spawn: number; waits: number[]; sleeps: number[] };
  logs: string[];
  clock: { now: number };
}

function fake(opts: {
  state?: () => DaemonState;
  connect?: () => Promise<void>;
  waitForDaemon?: (ms: number) => Promise<void>;
  connectOnly?: boolean;
} = {}): Fake {
  const calls = { connect: 0, spawn: 0, waits: [] as number[], sleeps: [] as number[] };
  const logs: string[] = [];
  const clock = { now: 1_000_000 };
  const deps: ReconnectDeps = {
    daemonState: async () => (opts.state ? opts.state() : 'up'),
    connect: async () => { calls.connect++; await opts.connect?.(); },
    spawnDaemon: () => { calls.spawn++; },
    waitForDaemon: async (ms) => { calls.waits.push(ms); await opts.waitForDaemon?.(ms); },
    connectOnly: opts.connectOnly ?? false,
    daemonLog: '/state/daemon.log',
    log: (line) => logs.push(line),
    sleep: async (ms) => { calls.sleeps.push(ms); },
    now: () => clock.now,
  };
  return { deps, calls, logs, clock };
}

describe('Reconnector: every drop reconnects', () => {
  it('reconnects after each of many drops, not only the first', async () => {
    const f = fake();
    const r = new Reconnector(f.deps);
    for (let drop = 1; drop <= 5; drop++) {
      await expect(r.reconnect()).resolves.toBe(true);
      expect(f.calls.connect).toBe(drop);
    }
  });

  it('drops that arrive during a cycle join it (one connect, not one per close event)', async () => {
    let release: (() => void) | undefined;
    // Only the first connect is held open; later ones answer at once.
    const f = fake({ connect: () => (release ? Promise.resolve() : new Promise<void>((r) => { release = r; })) });
    const r = new Reconnector(f.deps);
    const first = r.reconnect();
    const second = r.reconnect();
    expect(second).toBe(first);
    await sleep(10);
    release!();
    await expect(first).resolves.toBe(true);
    expect(f.calls.connect).toBe(1);
    // The cycle is over: the next drop starts a new one.
    await expect(r.reconnect()).resolves.toBe(true);
    expect(f.calls.connect).toBe(2);
  });

  it('starts a daemon on each drop when none is alive (a daemon:restart that only stopped it)', async () => {
    let up = false;
    const f = fake({ state: () => (up ? 'up' : 'down'), waitForDaemon: async () => { up = true; } });
    const r = new Reconnector(f.deps);
    for (let drop = 1; drop <= 2; drop++) {
      up = false;
      await expect(r.reconnect()).resolves.toBe(true);
      expect(f.calls.spawn).toBe(drop);
      expect(f.calls.waits.at(-1)).toBe(DAEMON_START_WAIT_MS);
    }
  });

  it('waits for a daemon whose lock is held instead of starting a competitor', async () => {
    const f = fake({ state: () => 'starting' });
    await expect(new Reconnector(f.deps).reconnect()).resolves.toBe(true);
    expect(f.calls.spawn).toBe(0);
    expect(f.calls.waits).toEqual([STARTING_WAIT_MS]);
  });

  it('connect-only mode never starts a daemon: it waits for the managed one', async () => {
    const f = fake({ state: () => 'down', connectOnly: true });
    await expect(new Reconnector(f.deps).reconnect()).resolves.toBe(true);
    expect(f.calls.spawn).toBe(0);
    expect(f.calls.waits).toEqual([DAEMON_START_WAIT_MS]);
  });
});

describe('Reconnector: bounded backoff and the anti-loop cap', () => {
  it('backs off between failed tries, never longer than the last delay, then gives up', async () => {
    const f = fake({ connect: async () => { throw new Error('connect ECONNREFUSED'); } });
    const r = new Reconnector(f.deps);
    await expect(r.reconnect()).resolves.toBe(false);
    expect(f.calls.connect).toBe(MAX_RECONNECT_ATTEMPTS);
    expect(f.calls.sleeps).toHaveLength(MAX_RECONNECT_ATTEMPTS - 1);
    const cap = RECONNECT_BACKOFF_MS[RECONNECT_BACKOFF_MS.length - 1];
    expect(Math.max(...f.calls.sleeps)).toBe(cap);
    expect(f.calls.sleeps).toEqual([...f.calls.sleeps].sort((a, b) => a - b));
    expect(f.logs.at(-1)).toMatch(/gave up reconnecting .* the next tool call tries again/);
  });

  it('a try that fails is retried in the same cycle: a later try connects', async () => {
    let tries = 0;
    const f = fake({ connect: async () => { if (++tries < 3) throw new Error('daemon closed before welcome'); } });
    await expect(new Reconnector(f.deps).reconnect()).resolves.toBe(true);
    expect(f.calls.connect).toBe(3);
    expect(f.calls.sleeps).toEqual([RECONNECT_BACKOFF_MS[0], RECONNECT_BACKOFF_MS[1]]);
  });

  it(`starts a daemon that cannot stay up at most ${MAX_RESPAWNS} times per window, then again once the window has room`, async () => {
    // Every connect succeeds, but the daemon dies right after: each drop finds none alive.
    const f = fake({ state: () => 'down' });
    const r = new Reconnector(f.deps);
    for (let i = 0; i < MAX_RESPAWNS; i++) await expect(r.reconnect()).resolves.toBe(true);
    expect(f.calls.spawn).toBe(MAX_RESPAWNS);

    await expect(r.reconnect()).resolves.toBe(false);
    expect(f.calls.spawn).toBe(MAX_RESPAWNS);
    expect(f.logs.at(-1)).toContain(`started ${MAX_RESPAWNS} times`);
    await expect(r.waitFor(1_000)).resolves.toMatch(/did not stay up; see \/state\/daemon\.log/);

    f.clock.now += RESPAWN_WINDOW_MS;
    await expect(r.reconnect()).resolves.toBe(true);
    expect(f.calls.spawn).toBe(MAX_RESPAWNS + 1);
  });

  it('a live daemon is always reconnected to: the cap counts only daemons this client started', async () => {
    const f = fake({ state: () => 'up' });
    const r = new Reconnector(f.deps);
    for (let i = 0; i < MAX_RESPAWNS * 3; i++) await expect(r.reconnect()).resolves.toBe(true);
    expect(f.calls.spawn).toBe(0);
  });
});

describe('Reconnector.waitFor: a call made during a reconnect', () => {
  it('waits for the running cycle and resolves null once connected', async () => {
    let release!: () => void;
    const f = fake({ connect: () => new Promise<void>((r) => { release = r; }) });
    const r = new Reconnector(f.deps);
    void r.reconnect();
    const waiting = r.waitFor(5_000);
    setTimeout(() => release(), 20);
    await expect(waiting).resolves.toBeNull();
    expect(f.calls.connect).toBe(1);
  });

  it('starts a cycle when none runs (the previous one gave up)', async () => {
    const f = fake();
    await expect(new Reconnector(f.deps).waitFor(5_000)).resolves.toBeNull();
    expect(f.calls.connect).toBe(1);
  });

  it('gives up waiting after its timeout and says the reconnect is still running', async () => {
    const f = fake({ connect: () => new Promise<void>(() => { /* never answers */ }) });
    await expect(new Reconnector(f.deps).waitFor(30)).resolves.toMatch(/^still reconnecting after 0\.03 s; try again shortly$/);
  });
});

describe('openDaemonLog: daemon.log cannot grow without bound', () => {
  it('rotates a log past the cap to <file>.1 and keeps one old copy', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-log-'));
    const file = path.join(dir, 'daemon.log');
    try {
      fs.writeFileSync(file, 'a'.repeat(200));
      fs.closeSync(openDaemonLog(file, 100));
      expect(fs.readFileSync(`${file}.1`, 'utf8')).toBe('a'.repeat(200));
      expect(fs.statSync(file).size).toBe(0);

      // Under the cap: appended to, not rotated.
      const fd = openDaemonLog(file, 100);
      fs.writeSync(fd, 'line\n');
      fs.closeSync(fd);
      fs.closeSync(openDaemonLog(file, 100));
      expect(fs.readFileSync(file, 'utf8')).toBe('line\n');

      // A second rotation replaces the old copy.
      fs.writeFileSync(file, 'b'.repeat(150));
      fs.closeSync(openDaemonLog(file, 100));
      expect(fs.readFileSync(`${file}.1`, 'utf8')).toBe('b'.repeat(150));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('creates the folder and the log when neither exists', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-log-'));
    const file = path.join(dir, 'nested', 'daemon.log');
    try {
      fs.closeSync(openDaemonLog(file, 100));
      expect(fs.existsSync(file)).toBe(true);
      expect(fs.existsSync(`${file}.1`)).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
