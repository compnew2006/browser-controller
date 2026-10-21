/**
 * How the thin MCP client (index.ts) gets back to the daemon after its IPC
 * connection drops (a `npm run daemon:restart`, a crash, a heartbeat
 * eviction). Every drop starts one reconnect cycle; a drop during a cycle
 * joins it. A cycle makes up to MAX_RECONNECT_ATTEMPTS tries,
 * RECONNECT_BACKOFF_MS apart (the last delay repeats). Each try:
 *   - connects to the daemon that answers on the IPC socket;
 *   - or waits for one that is starting (its daemon.lock names a live pid),
 *     instead of starting a competitor that would only lose the lock;
 *   - or, when none is alive, starts one (never in connect-only mode, where a
 *     supervisor owns the daemon and the try waits for it).
 *
 * Anti-loop: a daemon that cannot stay up is started at most MAX_RESPAWNS
 * times per RESPAWN_WINDOW_MS. Past that the cycle stops. A later tool call
 * starts a new cycle, which starts a daemon again once the window has room.
 */

/** 'up': answers on the IPC socket; 'starting': its lock is held by a live pid; 'down': neither. */
export type DaemonState = 'up' | 'starting' | 'down';

export interface ReconnectDeps {
  daemonState(): Promise<DaemonState>;
  /** Open the IPC connection and finish the hello/welcome handshake. */
  connect(): Promise<void>;
  /** Start a detached daemon; does not wait for it. */
  spawnDaemon(): void;
  /** Resolve once the IPC socket accepts a connection; reject after maxMs. */
  waitForDaemon(maxMs: number): Promise<void>;
  /** BROWSER_CONTROLLER_DAEMON_MODE=connect: never start a daemon, wait for the managed one. */
  connectOnly: boolean;
  /** Where the daemon writes its output, named when it cannot stay up. */
  daemonLog: string;
  log(line: string): void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export const RECONNECT_BACKOFF_MS = [250, 500, 1_000, 2_000, 5_000] as const;
export const MAX_RECONNECT_ATTEMPTS = 8;
export const MAX_RESPAWNS = 3;
export const RESPAWN_WINDOW_MS = 60_000;
/** A daemon that holds the lock is given this long per try to open its socket. */
export const STARTING_WAIT_MS = 2_000;
/** A daemon this client started (or a managed one) is given this long per try. */
export const DAEMON_START_WAIT_MS = 8_000;

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

export class Reconnector {
  private cycle: Promise<boolean> | null = null;
  /** When this client started a daemon, within RESPAWN_WINDOW_MS. */
  private respawns: number[] = [];
  /** Why the last try or cycle failed; null after a successful connect. */
  private failure: string | null = null;
  private readonly deps: ReconnectDeps;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;

  constructor(deps: ReconnectDeps) {
    this.deps = deps;
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = deps.now ?? Date.now;
  }

  /** Start a reconnect cycle, or join the running one. Resolves true once connected. */
  reconnect(): Promise<boolean> {
    this.cycle ??= this.run().finally(() => { this.cycle = null; });
    return this.cycle;
  }

  /**
   * For a tool call made while disconnected: join (or start) a cycle and wait
   * up to timeoutMs. Resolves null once connected, otherwise why not.
   */
  async waitFor(timeoutMs: number): Promise<string | null> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<'timeout'>((r) => { timer = setTimeout(() => r('timeout'), timeoutMs); });
    const outcome = await Promise.race([this.reconnect(), timedOut]);
    clearTimeout(timer);
    if (outcome === true) return null;
    if (outcome === 'timeout') return `still reconnecting after ${timeoutMs / 1000} s${this.failure ? ` (last try: ${this.failure})` : ''}; try again shortly`;
    return this.failure ?? 'reconnect failed';
  }

  private async run(): Promise<boolean> {
    for (let attempt = 0; attempt < MAX_RECONNECT_ATTEMPTS; attempt++) {
      if (attempt > 0) await this.sleep(RECONNECT_BACKOFF_MS[Math.min(attempt - 1, RECONNECT_BACKOFF_MS.length - 1)]);
      try {
        const state = await this.deps.daemonState();
        if (state === 'starting') {
          await this.deps.waitForDaemon(STARTING_WAIT_MS);
        } else if (state === 'down' && this.deps.connectOnly) {
          await this.deps.waitForDaemon(DAEMON_START_WAIT_MS);
        } else if (state === 'down') {
          if (!this.takeRespawn()) {
            this.failure = `the daemon was started ${MAX_RESPAWNS} times in ${RESPAWN_WINDOW_MS / 1000} s and did not stay up; see ${this.deps.daemonLog}`;
            this.deps.log(`${this.failure}; not starting it again until a tool call after that window`);
            return false;
          }
          this.deps.log('no live daemon: starting one');
          this.deps.spawnDaemon();
          await this.deps.waitForDaemon(DAEMON_START_WAIT_MS);
        }
        await this.deps.connect();
        this.failure = null;
        return true;
      } catch (err) {
        this.failure = message(err);
        this.deps.log(`reconnect try ${attempt + 1}/${MAX_RECONNECT_ATTEMPTS} failed: ${this.failure}`);
      }
    }
    this.deps.log(`gave up reconnecting after ${MAX_RECONNECT_ATTEMPTS} tries; the next tool call tries again`);
    return false;
  }

  /** Record a daemon start, unless MAX_RESPAWNS already happened in the window. */
  private takeRespawn(): boolean {
    const now = this.now();
    this.respawns = this.respawns.filter((t) => now - t < RESPAWN_WINDOW_MS);
    if (this.respawns.length >= MAX_RESPAWNS) return false;
    this.respawns.push(now);
    return true;
  }
}
