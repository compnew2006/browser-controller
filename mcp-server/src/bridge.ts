import http from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import { isIdempotent, toolTimeoutMs } from './tools/index.js';
import { APP_VERSION } from './daemon-config.js';
import {
  DAEMON_INSTANCE_ID,
  buildExtensionHello,
  HANDSHAKE_TIMEOUT_REASON,
  validateExtensionHelloAck,
} from './protocol/index.js';
import {
  isDaemonResponsiveOnPort,
  isAllowedOrigin,
} from './bridge-security.js';
import { createBridgeHttpHandler, type HttpRequestHandler } from './bridge-http.js';
import { ERROR_CODES, formatError } from './core/error-codes.js';
import { createLogger, currentCorrelationId, newCorrelationId } from './core/logger.js';
export type { HttpRequestHandler } from './bridge-http.js';
import {
  BridgeHttpAuthenticator,
  isValidAuthNonce,
  newAuthNonce,
  verifyWebSocketClientProof,
} from './bridge-auth.js';
import {
  ExtensionConnections,
  newConnection,
  type ExtensionConnection,
} from './bridge-connections.js';
import { MAX_WS_MESSAGE_BYTES, WS_HARD_MAX_PAYLOAD_BYTES, rejectOversizedFrame } from './bridge-frames.js';
import { tabsAcrossBrowsers } from './bridge-tabs.js';
import { VaultBridgeTransport } from './vault/bridge-transport.js';

export { isDaemonResponsiveOnPort } from './bridge-security.js';
export { MAX_WS_MESSAGE_BYTES } from './bridge-frames.js';

const log = createLogger('Bridge');

/**
 * Outbound backpressure limit: a tool call is refused while more than this many
 * bytes wait unsent on the extension socket (the browser is not reading).
 * 4 MiB is several large tool frames, far above a healthy socket's few KiB.
 */
export const MAX_WS_BUFFERED_BYTES = 4 * 1024 * 1024;

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
  /** The extension connection (browser) this call was sent to. */
  conn?: ExtensionConnection;
}

interface BridgeOptions {
  port: number;
  host?: string;
  /** Auth token used to verify the extension proof after daemon identity is established. */
  token: string;
  /**
   * Enrollment secret used to prove daemon identity and authenticate HTTP
   * challenges without sending the secret to the extension or port owner.
   */
  enrollmentSecret: string;
  maxRetries?: number;
  pingIntervalMs?: number;
  defaultTimeoutMs?: number;
  maxWsPayloadBytes?: number;
  /** How long a peer may take to answer our hello with its helloAck before it is refused. */
  handshakeGraceMs?: number;
  /** How long callTool waits for an extension to connect before failing with NOT_CONNECTED. */
  connectionWaitMs?: number;
  /** Within `windowMs` (60 s) of the start or of an extension drop one is likely reconnecting: wait `ms` instead. */
  reconnectWait?: { ms: number; windowMs?: number };
}


export class ExtensionBridge {
  private httpServer: http.Server | null = null;
  private wss: WebSocketServer | null = null;
  private conns = new ExtensionConnections();
  readonly vaultTransport = new VaultBridgeTransport(this.conns);
  private pendingRequests = new Map<string, PendingRequest>();
  private requestId = 0;
  private port: number;
  private host: string;
  private token: string;
  private enrollmentSecret: string;
  private httpAuthenticator: BridgeHttpAuthenticator;
  private maxRetries: number;
  private pingIntervalMs: number;
  private defaultTimeoutMs: number;
  private maxWsPayloadBytes: number;
  private handshakeGraceMs: number;
  private connectionWaitMs: number;
  private reconnectWait: { ms: number; windowMs: number };
  /** When an extension last dropped; the start counts too, since the daemon may have just restarted. */
  private lastExtensionAt = Date.now();
  /** Reason a connection that had been ready was refused, until some browser connects fine. Fails calls fast. */
  private handshakeError: string | null = null;
  /**
   * Reason a connection was refused before it proved itself. Any local process can open the
   * socket, so this is only a diagnostic for a timed-out wait: it never fails a call early.
   */
  private lastRefusal: string | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
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
    this.token = options.token;
    this.enrollmentSecret = options.enrollmentSecret;
    this.httpAuthenticator = new BridgeHttpAuthenticator(this.enrollmentSecret, DAEMON_INSTANCE_ID);
    this.maxRetries = options.maxRetries ?? 2;
    this.pingIntervalMs = options.pingIntervalMs ?? 10_000;
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 30_000;
    this.maxWsPayloadBytes = options.maxWsPayloadBytes ?? MAX_WS_MESSAGE_BYTES;
    this.handshakeGraceMs = options.handshakeGraceMs ?? 3_000;
    this.connectionWaitMs = options.connectionWaitMs ?? 5_000;
    this.reconnectWait = { ms: Math.max(options.reconnectWait?.ms ?? 0, this.connectionWaitMs), windowMs: options.reconnectWait?.windowMs ?? 60_000 };
  }

  /** The daemon's live session ids, sent to each extension connection when it becomes ready. */
  private sessionRoster: (() => string[]) | null = null;

  /** Set by the daemon: lets a reconnecting extension free the locks of sessions that left while it was away. */
  setSessionRoster(provider: () => string[]): void {
    this.sessionRoster = provider;
  }

  private markExtensionReady(conn: ExtensionConnection, info?: { browserId?: unknown; browserLabel?: unknown; capabilities?: unknown }): void {
    this.conns.markReady(conn, info);
    // A reconnect of the same browser replaces its old socket.
    for (const other of this.conns.siblingsOf(conn)) {
      this.dropConn(other, 'Extension reconnected');
      try { other.ws.close(); } catch { /* already closing */ }
    }
    this.handshakeError = null;
    this.lastRefusal = null;
    this.startPingLoop();
    this.connectionWaiters.forEach((waiter) => waiter.resolve());
    this.connectionWaiters = [];
    log.info(`Extension connected (browser ${conn.label})`);
    // Only this connection: it alone may have missed releaseSession frames (F4-2).
    if (this.sessionRoster) {
      try {
        conn.ws.send(JSON.stringify({ type: 'sessionRoster', sessionIds: this.sessionRoster() }));
      } catch {
        // socket gone — close path will fire
      }
    }
  }

  private rejectExtensionHandshake(conn: ExtensionConnection, reason: string, peerSentFrame = true): void {
    if (conn.handshakeTimer) clearTimeout(conn.handshakeTimer);
    conn.handshakeTimer = null;
    const wasReady = conn.state === 'ready';
    conn.state = 'incompatible';
    try { conn.ws.close(1002, 'incompatible protocol'); } catch { /* already closing */ }
    if (!wasReady) {
      // An unproven peer cannot be told from an attacker: keep the reason, fail nobody early.
      // A silent peer sent no frame: its timeout never replaces a reason a peer actually sent.
      if (peerSentFrame) this.lastRefusal = reason;
      else this.lastRefusal ??= reason;
      this.rejectAllPending(reason, conn);
      return;
    }
    this.handshakeError = reason;
    if (this.conns.live().length === 0) {
      const error = new Error(reason);
      this.connectionWaiters.forEach((waiter) => waiter.reject(error));
      this.connectionWaiters = [];
    }
    this.rejectAllPending(reason, conn);
  }

  /** Forget a connection and fail the calls that were waiting on it. */
  private dropConn(conn: ExtensionConnection, reason: string): void {
    if (!this.conns.has(conn)) return;
    if (conn.state === 'ready') this.lastExtensionAt = Date.now();
    this.conns.delete(conn);
    this.vaultTransport.connectionDropped(conn, reason);
    if (conn.handshakeTimer) clearTimeout(conn.handshakeTimer);
    conn.handshakeTimer = null;
    this.rejectAllPending(reason, conn);
    if (this.conns.live().length === 0) this.stopPingLoop();
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
      const code = err instanceof Error && 'code' in err
        ? (err as NodeJS.ErrnoException).code
        : undefined;
      if (code !== 'EADDRINUSE') throw err;

      const isDaemon = await isDaemonResponsiveOnPort(
        this.host,
        this.port,
        1200,
        this.enrollmentSecret,
      );
      const owner = isDaemon ? 'an authenticated Browser Controller daemon' : 'an unverified process';
      throw new Error(
        `Cannot listen on ${this.host}:${this.port}: ${owner} already owns the port. ` +
        'Refusing to terminate another process automatically.',
        { cause: err },
      );
    }
  }

  private tryListen(): Promise<void> {
    return new Promise((resolve, reject) => {
      // One server handles authenticated HTTP routes and the extension WebSocket.
      const server = http.createServer(createBridgeHttpHandler({
        host: this.host,
        authenticator: this.httpAuthenticator,
        getHandler: () => this.httpHandler,
        getPinnedOrigin: () => this.pinnedExtensionOrigin,
        pinOrigin: (origin) => { this.pinnedExtensionOrigin = origin; },
      }));
      this.httpServer = server;

      this.wss = new WebSocketServer({
        noServer: true,
        maxPayload: Math.max(this.maxWsPayloadBytes, WS_HARD_MAX_PAYLOAD_BYTES),
        // Never echo client-offered subprotocols. Authentication happens only
        // in the nonce-bound proof exchange after the upgrade.
        handleProtocols: () => false,
      });

      server.on('upgrade', (req, socket, head) => {
        // The WebSocket authentication proof is exchanged after opening, but no
        // credential is sent in the upgrade headers or URL.
        const wsDecision = isAllowedOrigin(req, this.pinnedExtensionOrigin);
        if (!wsDecision.ok) {
          socket.destroy();
          return;
        }
        this.wss!.handleUpgrade(req, socket, head, (ws) => {
          this.wss!.emit('connection', ws, req);
        });
      });

      this.wss.on('connection', (ws: WebSocket, req) => {
        // Every socket is its own connection (browser). A reconnect of the same
        // browser replaces the old socket once the new one finished its handshake.
        const conn = newConnection(ws);
        this.conns.add(conn);
        let clientNonce = '';
        let serverNonce = '';
        let helloSent = false;

        ws.on('message', (data: Buffer) => {
          if (rejectOversizedFrame(data, this.maxWsPayloadBytes, this.pendingRequests, conn, (f) => this.handleResponse(f, conn))) return;
          try {
            const msg = JSON.parse(data.toString());
            if (conn.state === 'pending') {
              if (!helloSent) {
                if (msg.type !== 'authInit' || !isValidAuthNonce(msg.clientNonce)) {
                  this.rejectExtensionHandshake(conn, 'Extension authentication initialization failed.');
                  return;
                }
                clientNonce = msg.clientNonce;
                serverNonce = newAuthNonce();
                helloSent = true;
                ws.send(JSON.stringify(buildExtensionHello(APP_VERSION, DAEMON_INSTANCE_ID, {
                  clientNonce,
                  serverNonce,
                  enrollmentSecret: this.enrollmentSecret,
                })));
                return;
              }
              if (msg.type !== 'helloAck') {
                this.rejectExtensionHandshake(conn, 'Extension authentication is required before using this connection.');
                return;
              }
              const check = validateExtensionHelloAck(msg);
              if (!check.ok) {
                this.rejectExtensionHandshake(conn, check.reason ?? 'Extension protocol handshake failed.');
                return;
              }
              if (!verifyWebSocketClientProof(this.token, msg, clientNonce, DAEMON_INSTANCE_ID, serverNonce)) {
                this.rejectExtensionHandshake(conn, 'Extension authentication proof is invalid.');
                return;
              }
              if (req.headers.origin && !this.pinnedExtensionOrigin) {
                this.pinnedExtensionOrigin = req.headers.origin;
              }
              this.markExtensionReady(conn, msg);
              return;
            }
            // Only a registered, ready socket exchanges tool, vault, ping, or result frames; a
            // refused or replaced one keeps delivering whatever it sent before the close completes.
            if (conn.state !== 'ready' || !this.conns.has(conn)) return;
            if (msg.type === 'helloAck') {
              this.rejectExtensionHandshake(conn, 'Extension authentication was already completed.');
              return;
            }
            if (msg.type === 'pong') {
              conn.missedPongs = 0;
              return;
            }
            if (this.vaultTransport.handleMessage(msg, conn)) return;
            this.handleResponse(msg, conn);
          } catch (err) {
            log.error('Parse error:', err);
          }
        });

        ws.on('close', () => {
          if (!this.conns.has(conn)) return; // replaced or already dropped
          log.info(`Extension disconnected (browser ${conn.label})`);
          this.dropConn(conn, 'Extension disconnected');
        });

        ws.on('error', (err: Error) => {
          log.error('Socket error:', err.message);
        });

        conn.handshakeTimer = setTimeout(() => {
          if (this.conns.has(conn) && conn.state === 'pending') this.rejectExtensionHandshake(conn, HANDSHAKE_TIMEOUT_REASON, false);
        }, this.handshakeGraceMs);
      });

      server.on('listening', () => {
        log.info(`Listening on http/ws://${this.host}:${this.port}`);
        resolve();
      });

      server.on('error', (err: Error) => {
        log.error('Server error:', err.message);
        reject(err);
      });

      server.listen(this.port, this.host);
    });
  }

  private startPingLoop(): void {
    this.stopPingLoop();
    this.pingTimer = setInterval(() => {
      for (const conn of this.conns.live()) {
        conn.missedPongs++;
        if (conn.missedPongs >= 3) {
          log.warn(`Extension unresponsive (3 missed pongs), closing (browser ${conn.label})`);
          conn.ws.close();
          continue;
        }
        try { conn.ws.send(JSON.stringify({ type: 'ping' })); } catch { /* close path handles it */ }
      }
    }, this.pingIntervalMs);
  }

  private stopPingLoop(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  private handleResponse(msg: { id: string; success: boolean; result?: unknown; error?: string }, conn: ExtensionConnection): void {
    const pending = this.pendingRequests.get(msg.id);
    // Only the browser this call was sent to may settle it.
    if (!pending || pending.conn !== conn) return;

    clearTimeout(pending.timeout);
    // Detach the abort listener — the call settled normally (audit C2).
    if (pending.onAbort && pending.signal) pending.signal.removeEventListener('abort', pending.onAbort);
    this.pendingRequests.delete(msg.id);

    if (msg.success) {
      pending.resolve(msg.result);
    } else {
      const err = new Error(msg.error || 'Unknown error from extension');
      // Unified error channel: keep the tool's in-band payload (e.g. REF_GONE
      // freshRefs) on the rejection so the tool layer can surface it verbatim.
      if (msg.result !== undefined) (err as Error & { result?: unknown }).result = msg.result;
      pending.reject(err);
    }
  }

  isConnected(): boolean {
    return this.conns.live().length > 0;
  }

  /**
   * Send a non-tool control message to the extension (e.g. notify it that an
   * agent disconnected, so it can release that session's tab locks). Fire-and-
   * forget: control messages carry no reply. Used by the daemon's close handler.
   */
  sendControl(type: string, payload: Record<string, unknown> = {}): void {
    // A gone session no longer has a browser choice.
    if (type === 'releaseSession' && typeof payload.sessionId === 'string') this.conns.releaseSession(payload.sessionId);
    // Every browser gets control messages (session release, cancel of an id it may own).
    for (const conn of this.conns.live()) {
      try {
        conn.ws.send(JSON.stringify({ type, ...payload }));
      } catch {
        // socket gone — close path will fire
      }
    }
  }

  waitForConnection(timeoutMs = 10_000): Promise<void> {
    if (this.isConnected()) return Promise.resolve();
    // A stale failure must not fail a call while a new browser is still negotiating.
    if (this.handshakeError && !this.conns.all().some((c) => c.state === 'pending')) return Promise.reject(new Error(this.handshakeError));

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.connectionWaiters = this.connectionWaiters.filter(
          w => w.resolve !== resolve,
        );
        reject(new Error(formatError(ERROR_CODES.NOT_CONNECTED, `no Browser Controller extension connected within ${timeoutMs / 1000} s; check that it is installed and enabled`)));
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

  async callTool(tool: string, params: Record<string, unknown>, sessionId?: string, signal?: AbortSignal, agentName?: string, skipTabs = false): Promise<unknown> {
    if (tool === 'browser_tabs' && !skipTabs) return tabsAcrossBrowsers(this.conns, params, sessionId, (p) => this.callTool(tool, p, sessionId, signal, agentName, true));
    if (!this.isConnected()) {
      try {
        const reconnecting = Date.now() - this.lastExtensionAt < this.reconnectWait.windowMs;
        await this.waitForConnection(reconnecting ? this.reconnectWait.ms : this.connectionWaitMs);
      } catch (error) {
        // Every "no extension" failure reads with the NOT_CONNECTED code the agent acts on.
        const wait = error instanceof Error ? error.message : String(error);
        const refusal = this.handshakeError ?? this.lastRefusal;
        if (refusal) throw new Error(formatError(ERROR_CODES.NOT_CONNECTED, refusal), { cause: error });
        if (wait.startsWith(`${ERROR_CODES.NOT_CONNECTED}: `)) throw error;
        throw new Error(/protocol|capabilit/i.test(wait)
          ? formatError(ERROR_CODES.NOT_CONNECTED, wait)
          : formatError(ERROR_CODES.NOT_CONNECTED, 'Chrome extension not connected. Make sure the Browser Controller extension is installed and enabled.'), { cause: error });
      }
    }

    return this.sendToolCall(tool, params, 0, sessionId, signal, agentName);
  }

  private sendToolCall(tool: string, params: Record<string, unknown>, retryCount: number, sessionId?: string, signal?: AbortSignal, agentName?: string, correlationId: string = currentCorrelationId() ?? newCorrelationId()): Promise<unknown> {
    // If the caller already aborted (e.g. client evicted before we even sent),
    // reject immediately rather than firing the action into the void.
    if (signal?.aborted) {
      return Promise.reject(new Error(`Call aborted before send: ${tool}`));
    }
    let conn: ExtensionConnection;
    try {
      conn = this.conns.forSession(sessionId);
    } catch (err) {
      return Promise.reject(err);
    }
    // Backpressure: fail fast instead of queueing frames for a browser that is not reading. Never retried.
    if (conn.ws.bufferedAmount > MAX_WS_BUFFERED_BYTES) {
      return Promise.reject(new Error(formatError(ERROR_CODES.BROWSER_BUSY, 'the browser is not reading its connection; try again shortly')));
    }
    return new Promise((resolve, reject) => {
      const id = String(++this.requestId);
      // One correlation id per call: the retries of the same call share it.
      const callLog = log.withCorrelationId(correlationId);
      // Timeout policy (audit M3): the tool registry is the single source of
      // truth — each tool declares its own `timeoutMs`. The bridge default
      // (30s) is only a backstop if a tool ever omits it; the registry guard
      // test (registry.test.ts) keeps every tool honest so this never silently
      // falls back.
      const timeoutMs = toolTimeoutMs(tool) ?? this.defaultTimeoutMs;

      // Task 2.3: non-idempotent tools (click, type, navigate, …) must never be
      // retried on timeout — re-sending could double-fire the action. Only
      // read-only tools (snapshot/screenshot/text/…) are retried.
      const canRetry = isIdempotent(tool);

      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        if (signal) signal.removeEventListener('abort', onAbort);
        // Notify the extension to abort this id's in-flight handler. This id is
        // being abandoned (retry gets a new id, or the call is rejected), so the
        // old handler must stop to free the tab mutex. Without this a timed-out
        // navigate pins its tab for up to 55s.
        this.sendControl('cancel', { id });
        if (canRetry && retryCount < this.maxRetries) {
          callLog.warn(`Timeout on ${tool}, retry ${retryCount + 1}/${this.maxRetries}`);
          this.sendToolCall(tool, params, retryCount + 1, sessionId, signal, agentName, correlationId).then(resolve, reject);
        } else if (!canRetry) {
          reject(new Error(formatError(ERROR_CODES.TIMEOUT, `${tool} did not answer in ${timeoutMs} ms; it may still have run — check the page (browser_snapshot) before repeating it`)));
        } else {
          reject(new Error(formatError(ERROR_CODES.TIMEOUT, `${tool} did not answer in ${timeoutMs} ms (${retryCount + 1} attempts)`)));
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

      this.pendingRequests.set(id, { resolve, reject, timeout, tool, retries: retryCount, params, onAbort, signal, conn });

      try {
        // sessionId + agentName travel as top-level WS fields (audit M1), not
        // injected into params — the daemon stays a pure {tool, params} multiplexer.
        // agentName is the STABLE identity for tab locks (survives reconnects);
        // sessionId is transient (s3→s4) and used only for logging/UI.
        conn.ws.send(JSON.stringify({ id, tool, params, sessionId, agentName }));
      } catch (err) {
        clearTimeout(timeout);
        if (signal) signal.removeEventListener('abort', onAbort);
        this.pendingRequests.delete(id);
        if (canRetry && retryCount < this.maxRetries && this.isConnected()) {
          this.sendToolCall(tool, params, retryCount + 1, sessionId, signal, agentName, correlationId).then(resolve, reject);
        } else {
          reject(err instanceof Error ? err : new Error('Send failed'));
        }
      }
    });
  }

  /** Fail waiting calls: all of them, or only those sent to one browser. They read NOT_CONNECTED. */
  private rejectAllPending(reason: string, onlyConn?: ExtensionConnection): void {
    for (const [id, pending] of this.pendingRequests) {
      if (onlyConn && pending.conn !== onlyConn) continue;
      clearTimeout(pending.timeout);
      if (pending.onAbort && pending.signal) pending.signal.removeEventListener('abort', pending.onAbort);
      // The call was already sent: it may have run in the page before the browser went away.
      pending.reject(new Error(formatError(ERROR_CODES.NOT_CONNECTED, `${reason}; the call may still have run, so check the page before repeating it`)));
      this.pendingRequests.delete(id);
    }
    this.vaultTransport.rejectPending(reason, onlyConn);
  }

  stop(): void {
    this.stopPingLoop();
    this.rejectAllPending('Server shutting down');
    this.connectionWaiters.forEach(w => w.reject(new Error('Server shutting down')));
    this.connectionWaiters = [];
    for (const conn of this.conns.all()) {
      if (conn.handshakeTimer) clearTimeout(conn.handshakeTimer);
      try { conn.ws.close(); } catch { /* already closed */ }
    }
    this.conns.clear();
    this.wss?.close();
    this.wss = null;
    this.httpServer?.close();
    this.httpServer = null;
  }
}
