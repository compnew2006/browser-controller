import net from 'node:net';
import http from 'node:http';
import crypto from 'node:crypto';
import { execSync } from 'node:child_process';
import { WebSocket, WebSocketServer } from 'ws';
import { isIdempotent, toolTimeoutMs } from './tools/index.js';

/**
 * Signature of an HTTP request handler the daemon can register so it can serve
 * `/pair` (token bootstrap) and `/status` (connected agents) on the SAME port
 * as the WebSocket. Returning a value serializes it as JSON; returning undefined
 * means the handler already wrote the response.
 */
export type HttpRequestHandler = (
  req: http.IncomingMessage,
  url: URL,
) => unknown | void | Promise<unknown | void>;

/**
 * CORS headers for the daemon's HTTP endpoints (/pair, /status, /kill).
 *
 * These endpoints are ONLY for the extension popup (origin
 * `chrome-extension://<id>`). The previous `Access-Control-Allow-Origin: '*'`
 * let ANY web page open in the browser fetch `/pair` and read the auth token,
 * or `/kill` to disconnect agents — because the browser happily served a
 * `*`-CORS response to any origin. We now reflect the requesting origin ONLY
 * when it is a chrome-extension origin; for any other origin we emit no
 * `Access-Control-Allow-Origin` header, so the browser blocks the caller from
 * reading the body (defense in depth on top of the Origin reject in the
 * handler below).
 */
const ALLOWED_METHODS = 'GET, OPTIONS';
const EXT_ORIGIN_PREFIX = 'chrome-extension://';
function corsHeaders(req: http.IncomingMessage, pinnedOrigin: string | null): http.OutgoingHttpHeaders {
  const origin = req.headers.origin;
  if (typeof origin === 'string' && origin === pinnedOrigin) {
    return {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': ALLOWED_METHODS,
      'Access-Control-Allow-Headers': 'Content-Type',
      Vary: 'Origin',
    };
  }
  // No ACAO header → browser blocks cross-origin reads. (Preflight OPTIONS for
  // a non-extension origin also lands here and is rejected by the handler.)
  return {
    'Access-Control-Allow-Methods': ALLOWED_METHODS,
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

/**
 * Decide whether a request's Origin is permitted to reach the HTTP endpoints.
 *
 * Two cases pass:
 *   - no Origin header (local scripts / curl / the test suite — browsers always
 *     set Origin on cross-origin fetches, so a web page can't hide its origin),
 *   - an extension Origin: the FIRST extension origin we ever see is "pinned"
 *     (TOFU); every later extension Origin must match it EXACTLY. This closes
 *     the residual "another malicious extension on the same machine" gap that a
 *     substring check (`startsWith('chrome-extension://')`) leaves open — a
 *     co-installed hostile extension carries its OWN chrome-extension://<id>
 *     Origin (browsers will not let it spoof ours), so a strict equality check
 *     rejects it.
 *
 * The daemon has no compile-time way to know the extension ID: unpacked loads
 * get a random ID, and only the Web Store-published build gets a stable one
 * (manifest has no `key`). So we learn the ID on first contact and keep it for
 * the daemon's lifetime (re-learned on restart / reinstall — the popup always
 * sends its real ID, and a browser-asserted Origin can't be forged by JS).
 */
function isAllowedOrigin(req: http.IncomingMessage, pinnedOrigin: string | null): { ok: boolean; pinnedOrigin: string | null } {
  const origin = req.headers.origin;
  if (!origin) return { ok: true, pinnedOrigin };
  if (typeof origin !== 'string' || !origin.startsWith(EXT_ORIGIN_PREFIX)) {
    return { ok: false, pinnedOrigin };
  }
  // First extension Origin ever seen → pin it (TOFU). Any later request must
  // match exactly. A co-installed hostile extension surfaces its OWN ID here
  // and can't spoof ours, so equality is the right gate.
  if (!pinnedOrigin) return { ok: true, pinnedOrigin: origin };
  return { ok: origin === pinnedOrigin, pinnedOrigin };
}

/**
 * Subprotocol prefix the extension uses to carry the auth token out of the URL
 * query string (which leaks into access logs / browser history). The extension
 * sends `Sec-WebSocket-Protocol: bc-auth.<token>`; the daemon extracts the
 * token from there. The bare prefix `bc-auth` (no token) is echoed back so the
 * browser-side `new WebSocket(url, [subprotocol])` completes the handshake
 * without leaking anything to the page.
 *
 * `?token=` remains supported as a fallback for already-installed extensions
 * that have not yet shipped the subprotocol change (see wsTokenAuth fallback).
 */
const AUTH_PROTOCOL_PREFIX = 'bc-auth.';

/**
 * Extract the auth token from an upgrade request. Prefers the
 * `Sec-WebSocket-Protocol` header (post-hardening, not logged anywhere); falls
 * back to the legacy `?token=` query param so an old extension keeps working
 * against a new daemon (and vice-versa). Returns '' when neither is present.
 *
 * `req.headers['sec-websocket-protocol']` is a string for a single value or a
 * comma-separated list when the client offered several; we accept the token in
 * any position so callers don't have to order their subprotocol offers.
 */
function extractToken(req: http.IncomingMessage, url: URL): string {
  const header = req.headers['sec-websocket-protocol'];
  if (header) {
    const offers = Array.isArray(header) ? header : String(header).split(',');
    for (const raw of offers) {
      const proto = raw.trim();
      if (proto.startsWith(AUTH_PROTOCOL_PREFIX)) {
        return proto.slice(AUTH_PROTOCOL_PREFIX.length);
      }
    }
  }
  return url.searchParams.get('token') ?? '';
}

/**
 * Constant-time token compare (mirrors Daemon.checkToken in daemon.ts). The
 * previous `presented !== this.token` leaked the token length via short-circuit
 * string comparison. We pad both to a fixed size so timingSafeEqual always runs
 * on equal-length buffers, then re-check equality explicitly (timingSafeEqual
 * can return true for distinct strings that happen to share a padded buffer).
 */
function tokensMatch(presented: string, expected: string): boolean {
  if (!presented || !expected) return false;
  const FIXED = 128;
  const a = Buffer.alloc(FIXED);
  const b = Buffer.alloc(FIXED);
  a.write(presented);
  b.write(expected);
  return crypto.timingSafeEqual(a, b) && presented === expected;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
  tool: string;
  retries: number;
  params: Record<string, unknown>;
  /** Abort listener registered for this request (audit C2); removed on settle. */
  onAbort?: (() => void) | null;
  signal?: AbortSignal | null;
}

interface BridgeOptions {
  port: number;
  host?: string;
  /** Auth token the extension must present via ?token= (task 3.1). Empty = open. */
  token?: string;
  /**
   * Enrollment secret the extension popup must present via the X-BC-Enrollment
   * header on EVERY HTTP endpoint. Gates /pair (which hands out the token) so a
   * co-installed hostile extension that wins the Origin-pinning race still
   * cannot obtain the token. Empty = no enrollment gate (for tests / opt-out).
   */
  enrollmentSecret?: string;
  maxRetries?: number;
  pingIntervalMs?: number;
  defaultTimeoutMs?: number;
}

const TOOL_TIMEOUTS: Record<string, number> = {
  browser_navigate: 60_000,
  browser_wait: 60_000,
  browser_screenshot: 10_000,
  browser_click: 10_000,
  browser_type: 15_000,
  browser_press_key: 5_000,
  browser_hover: 5_000,
  browser_select: 10_000,
  browser_console: 5_000,
  browser_network: 5_000,
  browser_tabs: 5_000,
  browser_scroll: 10_000,
  browser_upload_file: 15_000,
  browser_run_action: 30_000,
  browser_drag: 10_000,
  browser_fill_form: 15_000,
  browser_evaluate: 15_000,
  browser_snapshot: 15_000,
  browser_text: 15_000,
  browser_find: 15_000,
  browser_click_text: 10_000,
  browser_handle_dialog: 5_000,
};

/**
 * Cross-platform (no `lsof`) probe: returns true if something is listening on
 * host:port. Replaces the macOS/Linux-only `lsof` call (plan task 1.6).
 */
export async function isPortInUse(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const tester = net.createServer();
    tester.once('error', () => resolve(true));
    tester.once('listening', () => {
      tester.close(() => resolve(false));
    });
    tester.listen(port, host);
  });
}

/**
 * Find PIDs of processes LISTENing on `port`. Cross-platform:
 *   - macOS/Linux: `lsof -ti :PORT -sTCP:LISTEN`
 *   - Windows:     PowerShell `Get-NetTCPConnection -LocalPort PORT`
 * Returns [] on any failure (best-effort; callers handle the empty case).
 */
export function findListenersOnPort(port: number): number[] {
  const cmd =
    process.platform === 'win32'
      ? `powershell -NoProfile -Command "(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue).OwningProcess"`
      : `lsof -ti :${port} -sTCP:LISTEN`;
  try {
    const out = execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      .split('\n')
      .map((s) => parseInt(s.trim(), 10))
      .filter((n) => Number.isFinite(n) && n > 0);
    return Array.from(new Set(out));
  } catch {
    return [];
  }
}

/**
 * Probe whether the process listening on `host:port` is a RESPONSIVE daemon
 * (vs a hung/crashed process still holding the port, or a totally unrelated
 * server). GETs `/pair` with a short timeout: our daemon answers with the
 * token JSON; anything else (reset, timeout, non-JSON, or a server that
 * doesn't speak our protocol) means the holder is NOT a healthy daemon we
 * should preserve.
 *
 * Used by `killStaleProcess` so a second MCP client that hits EADDRINUSE
 * does NOT SIGTERM a perfectly healthy daemon just because it couldn't
 * listen — the documented stale-kill is only for a port wedged by a
 * CRASHED previous daemon. Without this gate, N concurrent MCP clients
 * would each kill the others' daemon on startup (a destructive race).
 */
export async function isDaemonResponsiveOnPort(host: string, port: number, timeoutMs = 1200): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // Use 127.0.0.1 explicitly (the daemon only listens there).
    const res = await fetch(`http://${host}:${port}/pair`, { signal: controller.signal });
    if (!res.ok) return false;
    const body = (await res.json()) as { token?: unknown };
    // /pair returns { token: "<hex>" }. A 403 (wrong enrollment) would not be ok,
    // and an unrelated server would not return this shape.
    return typeof body?.token === 'string' && body.token.length > 0;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export class ExtensionBridge {
  private httpServer: http.Server | null = null;
  private wss: WebSocketServer | null = null;
  private client: WebSocket | null = null;
  private pendingRequests = new Map<string, PendingRequest>();
  private requestId = 0;
  private port: number;
  private host: string;
  private token: string;
  private enrollmentSecret: string;
  private maxRetries: number;
  private pingIntervalMs: number;
  private defaultTimeoutMs: number;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private missedPongs = 0;
  private connectionWaiters: Array<{ resolve: () => void; reject: (err: Error) => void }> = [];
  /** Optional HTTP handler (set by the daemon) for /pair, /status, etc. */
  private httpHandler: HttpRequestHandler | null = null;
  /**
   * The extension Origin (`chrome-extension://<id>`) we pin on first contact,
   * used by the exact-match origin gate. null until the first extension-origin
   * request lands (TOFU). See isAllowedOrigin() for why this is per-process.
   */
  private pinnedExtensionOrigin: string | null = null;

  constructor(options: BridgeOptions) {
    this.port = options.port;
    // Bind 127.0.0.1 deterministically. (Earlier we tried 'localhost', but on
    // macOS that resolves to IPv6 ::1 only, which then refuses IPv4 127.0.0.1
    // clients. The extension + popup both use 127.0.0.1, so bind that stack.)
    this.host = options.host ?? '127.0.0.1';
    this.token = options.token ?? '';
    this.enrollmentSecret = options.enrollmentSecret ?? '';
    this.maxRetries = options.maxRetries ?? 2;
    this.pingIntervalMs = options.pingIntervalMs ?? 10_000;
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 30_000;
  }

  /**
   * Register an HTTP handler so the daemon can serve `/pair` and `/status` on
   * the same port as the WebSocket (the extension can then auto-discover the
   * token and poll connected agents without a second server/port).
   */
  registerHttpHandler(handler: HttpRequestHandler): void {
    this.httpHandler = handler;
  }

  async start(): Promise<void> {
    try {
      await this.tryListen();
    } catch (err: unknown) {
      if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'EADDRINUSE') {
        console.error(`[Bridge] ${this.host}:${this.port} in use — killing stale process`);
        await this.killStaleProcess();
        await new Promise(r => setTimeout(r, 500));
        await this.tryListen();
      } else {
        throw err;
      }
    }
  }

  /**
   * Cross-platform stale-process eviction (plan task 1.6). If the port is still
   * held after the first EADDRINUSE, find and SIGTERM the owning PID so the
   * daemon can recover when a previous instance crashed without releasing 7225.
   *   - macOS/Linux: `lsof -ti :PORT -sTCP:LISTEN`
   *   - Windows:     `Get-NetTCPConnection -LocalPort PORT` (via powershell)
   * Best-effort: if the owner can't be attributed (permission/odd platform),
   * the listen retry will surface EADDRINUSE again with a clear message.
   */
  private async killStaleProcess(): Promise<void> {
    const inUse = await isPortInUse(this.host, this.port);
    if (!inUse) return;
    // CRITICAL: before SIGTERMing, confirm the holder is actually unresponsive.
    // A second MCP client that hits EADDRINUSE must NOT kill a healthy daemon
    // that's serving the extension — only one wedged by a crashed previous
    // daemon. Without this gate, N concurrent clients each kill the others'
    // daemon on startup (destructive race: the extension disconnects every time
    // a new client spawns). If /pair responds with a token, the holder is one of
    // our daemons and alive → back off and let the existing daemon keep running.
    if (await isDaemonResponsiveOnPort(this.host, this.port)) {
      console.error(`[Bridge] ${this.host}:${this.port} held by a RESPONSIVE daemon — not killing (this client will attach as an IPC client instead of listening)`);
      return;
    }
    const pids = findListenersOnPort(this.port);
    if (pids.length === 0) {
      console.error(`[Bridge] Port ${this.port} still occupied but no PID found (permission/platform). Manual cleanup may be needed.`);
      return;
    }
    for (const pid of pids) {
      if (pid === process.pid) continue;
      console.error(`[Bridge] Killing UNRESPONSIVE stale listener PID ${pid} on port ${this.port}`);
      try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ }
    }
    // give the OS a moment to release the socket
    await new Promise((r) => setTimeout(r, 400));
  }

  private tryListen(): Promise<void> {
    return new Promise((resolve, reject) => {
      // One http.Server serves BOTH the WebSocket (extension) and short HTTP
      // requests (popup fetching the token / agent list). Attaching the WS
      // server with noServer lets us run auth on the upgrade ourselves.
      const server = http.createServer(async (req, res) => {
        // Origin gate (exact-match on the pinned extension ID). Computed first
        // so the OPTIONS preflight also respects it and so the pinned origin
        // propagates to corsHeaders() for ACAO reflection.
        const decision = isAllowedOrigin(req, this.pinnedExtensionOrigin);
        if (decision.pinnedOrigin && decision.pinnedOrigin !== this.pinnedExtensionOrigin) {
          this.pinnedExtensionOrigin = decision.pinnedOrigin;
        }
        // Preflight for the popup's fetch(). Answer and stop; no handler.
        if (req.method === 'OPTIONS') {
          res.writeHead(204, corsHeaders(req, this.pinnedExtensionOrigin)).end();
          return;
        }
        if (!decision.ok) {
          res.writeHead(403).end('Forbidden');
          return;
        }
        // Enrollment gate (closes first-contact TOFU race). When an enrollment
        // secret is configured, EVERY HTTP request must carry it in the
        // X-BC-Enrollment header. This is the layer that stops a co-installed
        // hostile extension — even one that won the Origin pin — from fetching
        // /pair and obtaining the auth token: it cannot know the secret (delivered
        // out-of-band via `npx browser-controller` terminal output + manual popup
        // entry). Without this, the Origin gate alone would leave /pair open to
        // whoever wins the first-contact race. Constant-time compare to avoid a
        // timing oracle on the secret.
        if (this.enrollmentSecret) {
          const presented = req.headers['x-bc-enrollment'];
          const presentedStr = Array.isArray(presented) ? presented[0] : presented;
          if (typeof presentedStr !== 'string' || !tokensMatch(presentedStr, this.enrollmentSecret)) {
            res.writeHead(403).end('Forbidden: invalid enrollment');
            return;
          }
        }
        if (req.method !== 'GET' || !this.httpHandler) {
          res.writeHead(404, corsHeaders(req, this.pinnedExtensionOrigin)).end('Not found');
          return;
        }
        try {
          const url = new URL(req.url || '/', `http://${this.host}`);
          const out = await this.httpHandler(req, url);
          if (out === undefined) return; // handler wrote the response itself
          const body = typeof out === 'string' ? out : JSON.stringify(out);
          res.writeHead(200, { 'Content-Type': typeof out === 'string' ? 'text/plain' : 'application/json', ...corsHeaders(req, this.pinnedExtensionOrigin) });
          res.end(body);
        } catch (err) {
          res.writeHead(500, corsHeaders(req, this.pinnedExtensionOrigin)).end(String(err instanceof Error ? err.message : err));
        }
      });
      this.httpServer = server;

      // handleProtocols picks the subprotocol to ACK in the handshake. The
      // extension offers `bc-auth.<token>`; we answer with the bare `bc-auth`
      // prefix (token stripped) so the browser completes the handshake cleanly
      // without the token reaching its protocol list. If the client offered no
      // bc-auth variant (legacy query-token flow), we return false and let ws
      // fall back to no subprotocol. The actual TOKEN auth still happens in the
      // upgrade handler below — handleProtocols only shapes the response.
      const pickAuthProtocol = (protocols: Set<string>): string | false => {
        for (const p of protocols) {
          if (p.startsWith(AUTH_PROTOCOL_PREFIX) || p === 'bc-auth') return 'bc-auth';
        }
        return false;
      };

      this.wss = new WebSocketServer({ noServer: true, handleProtocols: pickAuthProtocol });

      server.on('upgrade', (req, socket, head) => {
        // Authenticate BEFORE completing the WebSocket handshake. This way a bad
        // token never produces an open socket the extension would treat as live.
        // Origin gate: same exact-match-on-pinned-extension-ID policy as the HTTP
        // endpoints (a co-installed hostile extension would carry its OWN origin
        // and can't forge ours). WS upgrades carry the browser-set Origin too, so
        // the gate works identically here.
        const wsDecision = isAllowedOrigin(req, this.pinnedExtensionOrigin);
        if (wsDecision.pinnedOrigin && wsDecision.pinnedOrigin !== this.pinnedExtensionOrigin) {
          this.pinnedExtensionOrigin = wsDecision.pinnedOrigin;
        }
        if (!wsDecision.ok) {
          socket.destroy();
          return;
        }
        if (this.token) {
          const url = new URL(req.url || '/', `http://${this.host}`);
          // Token may arrive via Sec-WebSocket-Protocol (preferred — not logged)
          // or the legacy ?token= query (fallback for old extensions).
          const presented = extractToken(req, url);
          if (!tokensMatch(presented, this.token)) {
            console.error('[Bridge] Extension rejected: missing/invalid token');
            socket.destroy();
            return;
          }
        }
        this.wss!.handleUpgrade(req, socket, head, (ws) => {
          this.wss!.emit('connection', ws, req);
        });
      });

      this.wss.on('connection', (ws: WebSocket, req) => {
        if (this.client && this.client.readyState === WebSocket.OPEN) {
          this.client.close();
        }

        this.client = ws;
        this.missedPongs = 0;
        this.startPingLoop();

        this.connectionWaiters.forEach(w => w.resolve());
        this.connectionWaiters = [];

        console.error('[Bridge] Extension connected');

        ws.on('message', (data: Buffer) => {
          try {
            const msg = JSON.parse(data.toString());
            if (msg.type === 'pong') {
              this.missedPongs = 0;
              return;
            }
            this.handleResponse(msg);
          } catch (err) {
            console.error('[Bridge] Parse error:', err);
          }
        });

        ws.on('close', () => {
          console.error('[Bridge] Extension disconnected');
          this.client = null;
          this.stopPingLoop();
          this.rejectAllPending('Extension disconnected');
        });

        ws.on('error', (err: Error) => {
          console.error('[Bridge] Socket error:', err.message);
        });
      });

      server.on('listening', () => {
        console.error(`[Bridge] Listening on http/ws://${this.host}:${this.port}`);
        resolve();
      });

      server.on('error', (err: Error) => {
        console.error('[Bridge] Server error:', err.message);
        reject(err);
      });

      server.listen(this.port, this.host);
    });
  }

  private startPingLoop(): void {
    this.stopPingLoop();
    this.pingTimer = setInterval(() => {
      if (!this.isConnected()) return;
      this.missedPongs++;
      if (this.missedPongs >= 3) {
        console.error('[Bridge] Extension unresponsive (3 missed pongs), closing');
        this.client?.close();
        return;
      }
      this.client?.send(JSON.stringify({ type: 'ping' }));
    }, this.pingIntervalMs);
  }

  private stopPingLoop(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  private handleResponse(msg: { id: string; success: boolean; result?: unknown; error?: string }): void {
    const pending = this.pendingRequests.get(msg.id);
    if (!pending) return;

    clearTimeout(pending.timeout);
    // Detach the abort listener — the call settled normally (audit C2).
    if (pending.onAbort && pending.signal) pending.signal.removeEventListener('abort', pending.onAbort);
    this.pendingRequests.delete(msg.id);

    if (msg.success) {
      pending.resolve(msg.result);
    } else {
      pending.reject(new Error(msg.error || 'Unknown error from extension'));
    }
  }

  isConnected(): boolean {
    return this.client !== null && this.client.readyState === WebSocket.OPEN;
  }

  /**
   * Send a non-tool control message to the extension (e.g. notify it that an
   * agent disconnected, so it can release that session's tab locks). Fire-and-
   * forget: control messages carry no reply. Used by the daemon's close handler.
   */
  sendControl(type: string, payload: Record<string, unknown> = {}): void {
    if (!this.isConnected()) return; // extension gone — nothing to notify
    try {
      this.client!.send(JSON.stringify({ type, ...payload }));
    } catch {
      // socket gone — close path will fire
    }
  }

  waitForConnection(timeoutMs = 10_000): Promise<void> {
    if (this.isConnected()) return Promise.resolve();

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.connectionWaiters = this.connectionWaiters.filter(
          w => w.resolve !== resolve,
        );
        reject(new Error('Timed out waiting for extension connection'));
      }, timeoutMs);

      this.connectionWaiters.push({
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });
    });
  }

  async callTool(tool: string, params: Record<string, unknown>, sessionId?: string, signal?: AbortSignal, agentName?: string): Promise<unknown> {
    if (!this.isConnected()) {
      try {
        await this.waitForConnection(5_000);
      } catch {
        throw new Error(
          'Chrome extension not connected. Make sure the Real Browser MCP extension is installed and enabled.',
        );
      }
    }

    return this.sendToolCall(tool, params, 0, sessionId, signal, agentName);
  }

  private sendToolCall(tool: string, params: Record<string, unknown>, retryCount: number, sessionId?: string, signal?: AbortSignal, agentName?: string): Promise<unknown> {
    // If the caller already aborted (e.g. client evicted before we even sent),
    // reject immediately rather than firing the action into the void.
    if (signal?.aborted) {
      return Promise.reject(new Error(`Call aborted before send: ${tool}`));
    }
    return new Promise((resolve, reject) => {
      const id = String(++this.requestId);
      // Timeout policy: the tool registry is the source of truth (audit M3).
      // A tool's `timeoutMs` wins; otherwise the legacy TOOL_TIMEOUTS table;
      // otherwise the bridge default (30s). New tools should set `timeoutMs`
      // rather than adding to TOOL_TIMEOUTS.
      const timeoutMs = toolTimeoutMs(tool) ?? TOOL_TIMEOUTS[tool] ?? this.defaultTimeoutMs;

      // Task 2.3: non-idempotent tools (click, type, navigate, …) must never be
      // retried on timeout — re-sending could double-fire the action. Only
      // read-only tools (snapshot/screenshot/text/…) are retried.
      const canRetry = isIdempotent(tool);

      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        // Notify the extension to abort this id's in-flight handler. This id is
        // being abandoned (retry gets a new id, or the call is rejected), so the
        // old handler must stop to free the tab mutex. Without this a timed-out
        // navigate pins its tab for up to 55s.
        this.sendControl('cancel', { id });
        if (canRetry && retryCount < this.maxRetries) {
          console.error(`[Bridge] Timeout on ${tool}, retry ${retryCount + 1}/${this.maxRetries}`);
          this.sendToolCall(tool, params, retryCount + 1, sessionId, signal, agentName).then(resolve, reject);
        } else if (!canRetry) {
          reject(new Error(`Tool call timed out (no retry: non-idempotent): ${tool}`));
        } else {
          reject(new Error(`Tool call timed out after ${retryCount + 1} attempts: ${tool}`));
        }
      }, timeoutMs);

      // Cancellation (audit C2): if the caller aborts (daemon evicted the
      // client mid-call), tear down this pending entry and reject — otherwise
      // a non-idempotent action (click/type) would keep running after the
      // originating agent was declared dead.
      const onAbort = () => {
        clearTimeout(timeout);
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          // Forward the cancellation to the extension so its in-flight handler
          // short-circuits via its AbortSignal. Without this the handler runs to
          // completion (up to 55s for navigate) and keeps the tab mutex pinned,
          // blocking every later call on the same tab even though the caller is
          // already gone. Opt-in: old extensions simply ignore the message.
          this.sendControl('cancel', { id });
          reject(new Error(`Call aborted: ${tool} (originating client gone)`));
        }
      };
      if (signal) {
        signal.addEventListener('abort', onAbort, { once: true });
      }

      this.pendingRequests.set(id, { resolve, reject, timeout, tool, retries: retryCount, params, onAbort, signal });

      try {
        // sessionId + agentName travel as top-level WS fields (audit M1), not
        // injected into params — the daemon stays a pure {tool, params} multiplexer.
        // agentName is the STABLE identity for tab locks (survives reconnects);
        // sessionId is transient (s3→s4) and used only for logging/UI.
        this.client!.send(JSON.stringify({ id, tool, params, sessionId, agentName }));
      } catch (err) {
        clearTimeout(timeout);
        if (signal) signal.removeEventListener('abort', onAbort);
        this.pendingRequests.delete(id);
        if (canRetry && retryCount < this.maxRetries && this.isConnected()) {
          this.sendToolCall(tool, params, retryCount + 1, sessionId, signal, agentName).then(resolve, reject);
        } else {
          reject(err instanceof Error ? err : new Error('Send failed'));
        }
      }
    });
  }

  private rejectAllPending(reason: string): void {
    for (const [id, pending] of this.pendingRequests) {
      clearTimeout(pending.timeout);
      if (pending.onAbort && pending.signal) pending.signal.removeEventListener('abort', pending.onAbort);
      pending.reject(new Error(reason));
      this.pendingRequests.delete(id);
    }
  }

  stop(): void {
    this.stopPingLoop();
    this.rejectAllPending('Server shutting down');
    this.connectionWaiters.forEach(w => w.reject(new Error('Server shutting down')));
    this.connectionWaiters = [];
    this.client?.close();
    this.client = null;
    this.wss?.close();
    this.wss = null;
    this.httpServer?.close();
    this.httpServer = null;
  }
}
