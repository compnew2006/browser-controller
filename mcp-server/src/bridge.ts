import http from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import { isIdempotent, toolTimeoutMs } from './tools/index.js';
import { APP_VERSION } from './daemon-config.js';
import {
  DAEMON_INSTANCE_ID,
  buildExtensionHello,
  OLDER_EXTENSION_REASON,
  validateExtensionHelloAck,
} from './protocol.js';
import {
  AUTH_PROTOCOL_PREFIX,
  corsHeaders,
  extractToken,
  isAllowedOrigin,
  isDaemonResponsiveOnPort,
  tokensMatch,
} from './bridge-security.js';
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

/** Handler for daemon-owned HTTP endpoints served on the bridge port. */
export type HttpRequestHandler = (
  req: http.IncomingMessage,
  url: URL,
) => unknown | void | Promise<unknown | void>;

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
  /** Auth token the extension must present in the bc-auth subprotocol (task 3.1). Empty = open. */
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
  maxWsPayloadBytes?: number;
  /** How long a peer may take to answer our hello with its helloAck before it is refused. */
  handshakeGraceMs?: number;
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
  private maxRetries: number;
  private pingIntervalMs: number;
  private defaultTimeoutMs: number;
  private maxWsPayloadBytes: number;
  private handshakeGraceMs: number;
  /** Reason of the latest failed extension handshake, until some browser connects fine. */
  private handshakeError: string | null = null;
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
    this.token = options.token ?? '';
    this.enrollmentSecret = options.enrollmentSecret ?? '';
    this.maxRetries = options.maxRetries ?? 2;
    this.pingIntervalMs = options.pingIntervalMs ?? 10_000;
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 30_000;
    this.maxWsPayloadBytes = options.maxWsPayloadBytes ?? MAX_WS_MESSAGE_BYTES;
    this.handshakeGraceMs = options.handshakeGraceMs ?? 3_000;
  }

  private markExtensionReady(conn: ExtensionConnection, info?: { browserId?: unknown; browserLabel?: unknown; capabilities?: unknown }): void {
    this.conns.markReady(conn, info);
    // A reconnect of the same browser replaces its old socket.
    for (const other of this.conns.siblingsOf(conn)) {
      this.dropConn(other, 'Extension reconnected');
      try { other.ws.close(); } catch { /* already closing */ }
    }
    this.handshakeError = null;
    this.startPingLoop();
    this.connectionWaiters.forEach((waiter) => waiter.resolve());
    this.connectionWaiters = [];
    console.error(`[Bridge] Extension connected (browser ${conn.label})`);
  }

  private rejectExtensionHandshake(conn: ExtensionConnection, reason: string): void {
    if (conn.handshakeTimer) clearTimeout(conn.handshakeTimer);
    conn.handshakeTimer = null;
    conn.state = 'incompatible';
    this.handshakeError = reason;
    try { conn.ws.close(1002, 'incompatible protocol'); } catch { /* already closing */ }
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
      // One http.Server serves BOTH the WebSocket (extension) and short HTTP
      // requests (popup fetching the token / agent list). Attaching the WS
      // server with noServer lets us run auth on the upgrade ourselves.
      const server = http.createServer(async (req, res) => {
        // Origin gate (exact-match on the pinned extension ID). Computed first
        // so the OPTIONS preflight also respects it and so the pinned origin
        // propagates to corsHeaders() for ACAO reflection.
        const decision = isAllowedOrigin(req, this.pinnedExtensionOrigin);
        // Preflight proves only browser origin, not enrollment. Reflect a valid
        // candidate for CORS, but pin it only after the authenticated GET.
        if (req.method === 'OPTIONS') {
          res.writeHead(204, corsHeaders(req, decision.origin)).end();
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
        // out-of-band via MCP-client terminal output + manual popup
        // entry). Without this, the Origin gate alone would leave /pair open to
        // whoever wins the first-contact race. Constant-time compare to avoid a
        // timing oracle on the secret.
        if (!this.enrollmentSecret) {
          // Fail closed: without a configured enrollment secret the whole HTTP
          // surface is refused — /pair hands out the raw auth token, and every
          // legitimate client (popup + extension) always sends the header. An
          // empty secret means the embedder skipped loadOrCreateEnrollment();
          // silently serving open-gated HTTP is never the right recovery.
          res.writeHead(503).end('Enrollment secret not configured — refusing HTTP request');
          return;
        }
        const presented = req.headers['x-bc-enrollment'];
        const presentedStr = Array.isArray(presented) ? presented[0] : presented;
        if (typeof presentedStr !== 'string' || !tokensMatch(presentedStr, this.enrollmentSecret)) {
          res.writeHead(403).end('Forbidden: invalid enrollment');
          return;
        }
        if (decision.origin && !this.pinnedExtensionOrigin) {
          this.pinnedExtensionOrigin = decision.origin;
        }
        if (req.method !== 'GET' || !this.httpHandler) {
          res.writeHead(404, corsHeaders(req, this.pinnedExtensionOrigin)).end('Not found');
          return;
        }
        try {
          const url = new URL(req.url || '/', `http://${this.host}`);
          const out = await this.httpHandler(req, url);
          if (out === undefined) {
            // No handler claimed this path — answer 404 instead of leaving the
            // response open (the client would hang until its own timeout).
            res.writeHead(404, corsHeaders(req, this.pinnedExtensionOrigin)).end('Not found');
            return;
          }
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

      this.wss = new WebSocketServer({
        noServer: true,
        handleProtocols: pickAuthProtocol,
        maxPayload: Math.max(this.maxWsPayloadBytes, WS_HARD_MAX_PAYLOAD_BYTES),
      });

      server.on('upgrade', (req, socket, head) => {
        // Authenticate BEFORE completing the WebSocket handshake. This way a bad
        // token never produces an open socket the extension would treat as live.
        // Origin gate: same exact-match-on-pinned-extension-ID policy as the HTTP
        // endpoints (a co-installed hostile extension would carry its OWN origin
        // and can't forge ours). WS upgrades carry the browser-set Origin too, so
        // the gate works identically here.
        const wsDecision = isAllowedOrigin(req, this.pinnedExtensionOrigin);
        if (!wsDecision.ok) {
          socket.destroy();
          return;
        }
        if (this.token) {
          // Only the Sec-WebSocket-Protocol subprotocol carries the token (never logged, never in the URL).
          const presented = extractToken(req);
          if (!tokensMatch(presented, this.token)) {
            console.error('[Bridge] Extension rejected: missing/invalid token');
            socket.destroy();
            return;
          }
        }
        if (wsDecision.origin && !this.pinnedExtensionOrigin) {
          this.pinnedExtensionOrigin = wsDecision.origin;
        }
        this.wss!.handleUpgrade(req, socket, head, (ws) => {
          this.wss!.emit('connection', ws, req);
        });
      });

      this.wss.on('connection', (ws: WebSocket, _req) => {
        // Every socket is its own connection (browser). A reconnect of the same
        // browser replaces the old socket once the new one finished its handshake.
        const conn = newConnection(ws);
        this.conns.add(conn);

        ws.on('message', (data: Buffer) => {
          if (rejectOversizedFrame(data, this.maxWsPayloadBytes, this.pendingRequests, conn, (f) => this.handleResponse(f, conn))) return;
          try {
            const msg = JSON.parse(data.toString());
            if (msg.type === 'helloAck') {
              // No legacy acceptance: an explicit protocolVersion and the 3.0 capabilities, or refuse.
              const check = validateExtensionHelloAck(msg);
              if (check.ok) this.markExtensionReady(conn, msg);
              else this.rejectExtensionHandshake(conn, check.reason ?? 'Extension protocol handshake failed.');
              return;
            }
            if (msg.type === 'pong') {
              conn.missedPongs = 0;
              return;
            }
            if (this.vaultTransport.handleMessage(msg, conn)) return;
            this.handleResponse(msg, conn);
          } catch (err) {
            console.error('[Bridge] Parse error:', err);
          }
        });

        ws.on('close', () => {
          if (!this.conns.has(conn)) return; // replaced or already dropped
          console.error(`[Bridge] Extension disconnected (browser ${conn.label})`);
          this.dropConn(conn, 'Extension disconnected');
        });

        ws.on('error', (err: Error) => {
          console.error('[Bridge] Socket error:', err.message);
        });

        // The extension must answer the hello with its 3.0 helloAck in time. A silent peer
        // (a pre-3.0 build) is refused: it never gets tool calls.
        setTimeout(() => {
          if (!this.conns.has(conn) || ws.readyState !== WebSocket.OPEN) return;
          ws.send(JSON.stringify(buildExtensionHello(APP_VERSION, DAEMON_INSTANCE_ID)));
          conn.handshakeTimer = setTimeout(() => {
            if (this.conns.has(conn) && conn.state === 'pending') this.rejectExtensionHandshake(conn, OLDER_EXTENSION_REASON);
          }, this.handshakeGraceMs);
        }, 0);
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
      for (const conn of this.conns.live()) {
        conn.missedPongs++;
        if (conn.missedPongs >= 3) {
          console.error(`[Bridge] Extension unresponsive (3 missed pongs), closing (browser ${conn.label})`);
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
        reject(new Error(`NOT_CONNECTED: no Browser Controller extension connected within ${timeoutMs / 1000} s; check that it is installed and enabled`));
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
        await this.waitForConnection(5_000);
      } catch (error) {
        // Every "no extension" failure reads with the NOT_CONNECTED code the agent acts on.
        const wait = error instanceof Error ? error.message : String(error);
        if (this.handshakeError) throw new Error(`NOT_CONNECTED: ${this.handshakeError}`, { cause: error });
        if (wait.startsWith('NOT_CONNECTED: ')) throw error;
        throw new Error(/protocol|capabilit/i.test(wait)
          ? `NOT_CONNECTED: ${wait}`
          : 'NOT_CONNECTED: Chrome extension not connected. Make sure the Browser Controller extension is installed and enabled.', { cause: error });
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
    let conn: ExtensionConnection;
    try {
      conn = this.conns.forSession(sessionId);
    } catch (err) {
      return Promise.reject(err);
    }
    return new Promise((resolve, reject) => {
      const id = String(++this.requestId);
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
        // Notify the extension to abort this id's in-flight handler. This id is
        // being abandoned (retry gets a new id, or the call is rejected), so the
        // old handler must stop to free the tab mutex. Without this a timed-out
        // navigate pins its tab for up to 55s.
        this.sendControl('cancel', { id });
        if (canRetry && retryCount < this.maxRetries) {
          console.error(`[Bridge] Timeout on ${tool}, retry ${retryCount + 1}/${this.maxRetries}`);
          this.sendToolCall(tool, params, retryCount + 1, sessionId, signal, agentName).then(resolve, reject);
        } else if (!canRetry) {
          reject(new Error(`TIMEOUT: ${tool} did not answer in ${timeoutMs} ms; it may still have run — check the page (browser_snapshot) before repeating it`));
        } else {
          reject(new Error(`TIMEOUT: ${tool} did not answer in ${timeoutMs} ms (${retryCount + 1} attempts)`));
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
          this.sendToolCall(tool, params, retryCount + 1, sessionId, signal, agentName).then(resolve, reject);
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
      pending.reject(new Error(`NOT_CONNECTED: ${reason}; the call may still have run, so check the page before repeating it`));
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
