#!/usr/bin/env node

/**
 * Daemon (plan task 1.0) — single long-running process.
 *
 * Owns two things:
 *   1. The extension-facing WebSocket server on 127.0.0.1:WS_PORT (only one
 *      process may own it — fixing the "two agents fighting over 7225" bug).
 *   2. An IPC socket (AF_UNIX / Windows named pipe) that any number of thin
 *      `npx real-browser-mcp` MCP clients connect to.
 *
 * The daemon does NOT speak MCP. It multiplexes {tool, params} calls between
 * clients and the single extension, tagging each with a per-client sessionId so
 * the extension can enforce per-agent tab locks (2.2) and per-tab mutex queues
 * (2.1).
 *
 * Auth (task 3.1): every IPC client must send the token from loadOrCreateToken()
 * in its `hello` frame; connections without a valid token are dropped.
 */
import net from 'node:net';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { WebSocket, WebSocketServer } from 'ws';
import {
  DEFAULT_WS_HOST,
  DEFAULT_WS_PORT,
  DAEMON_INFO_FILE,
  IPC_SOCKET_PATH,
  STATE_DIR,
  TOKEN_FILE,
  loadOrCreateToken,
  type IpcClientMessage,
  type IpcDaemonMessage,
} from './daemon-config.js';
import { ExtensionBridge } from './bridge.js';

const SERVER_NAME = 'real-browser-mcp-daemon';

interface IpcClient {
  socket: net.Socket;
  sessionId: string;
  /** Human-readable name of the connected agent (Cursor, Claude, …), for UI. */
  agentName: string;
  connectedAt: number;
  /** in-flight calls keyed by the client-local id the client sent. */
  pending: Map<string, { tool: string; daemonCallId: string }>;
  /** Missed heartbeat pongs — daemon evicts at HEARTBEAT_MAX_MISSED. */
  missedPongs: number;
}

/** Heartbeat cadence for IPC clients. Without this, half-open sockets (IDE
 *  killed without a graceful FIN) linger in `clients` for minutes until the OS
 *  finally delivers `close` — which is what produced the "14 zombie agents"
 *  symptom in the popup. Override via env for tests (fast eviction). */
const HEARTBEAT_INTERVAL_MS = parseInt(process.env.BC_HEARTBEAT_MS || '15000', 10);
const HEARTBEAT_MAX_MISSED = parseInt(process.env.BC_HEARTBEAT_MAX_MISSED || '3', 10);

class Daemon {
  private bridge: ExtensionBridge;
  private ipcServer: net.Server | null = null;
  private clients = new Map<net.Socket, IpcClient>();
  /** daemon-global call id counter -> { client, clientId } to route the reply. */
  private pendingCalls = new Map<string, { client: IpcClient; clientId: string }>();
  private sessionIdCounter = 0;
  private token: string;
  private startedAt = Date.now();
  /** Heartbeat timer — evicts half-open IPC sockets (see startHeartbeat). */
  private heartbeatTimer: NodeJS.Timeout | null = null;

  constructor() {
    this.token = loadOrCreateToken().token;
    // Forward the token to the bridge so the extension-facing WS server enforces
    // ?token= auth (plan 3.1). Without this the guard in bridge.ts is dead code
    // and any local process could drive the browser.
    this.bridge = new ExtensionBridge({ port: DEFAULT_WS_PORT, host: DEFAULT_WS_HOST, token: this.token });
  }

  async start(): Promise<void> {
    fs.mkdirSync(STATE_DIR, { recursive: true });

    // 1) extension-facing WS server (task 1.0). The bridge handles the stale-
    //    port eviction already (lsof replaced by net-based probe in bridge).
    await this.bridge.start();

    // 1b) HTTP endpoints on the SAME port (bridge shares it). The popup uses
    //     these to auto-pair the token and to show connected agents — without
    //     them the extension (no fs access) could never read the token.
    this.bridge.registerHttpHandler((req, url) => this.handleHttp(req, url));

    // 2) IPC server for thin MCP clients.
    this.ipcServer = this.createIpcServer();

    // 2b) heartbeat: evict half-open IPC sockets so the popup's "Connected
    //     Agents" list doesn't accumulate zombies from killed IDE processes.
    this.heartbeatTimer = this.startHeartbeat();

    // 3) write daemon info so thin clients can find / healthcheck us.
    this.writeDaemonInfo();

    console.error(`[${SERVER_NAME}] listening. WS=${DEFAULT_WS_HOST}:${DEFAULT_WS_PORT} IPC=${IPC_SOCKET_PATH}`);
    console.error(`[${SERVER_NAME}] auth token at ${TOKEN_FILE}`);

    // graceful shutdown
    const shutdown = (sig: string) => {
      console.error(`[${SERVER_NAME}] ${sig} received, shutting down`);
      this.stop();
      process.exit(0);
    };
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
  }

  private createIpcServer(): net.Server {
    const server = net.createServer((socket) => this.handleNewClient(socket));

    // Re-bind: remove any stale socket file first (daemon previously killed).
    if (process.platform !== 'win32') {
      try {
        fs.unlinkSync(IPC_SOCKET_PATH);
      } catch {
        // nonexistent is fine
      }
    }

    server.listen(IPC_SOCKET_PATH);
    server.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        console.error(`[${SERVER_NAME}] IPC socket in use (${IPC_SOCKET_PATH}). Another daemon running?`);
      } else {
        console.error(`[${SERVER_NAME}] IPC server error:`, err.message);
      }
      process.exit(1);
    });
    return server;
  }

  private handleNewClient(socket: net.Socket): void {
    let authed = false;
    let client: IpcClient | null = null;
    let buf = '';

    const safeSend = (msg: IpcDaemonMessage) => {
      try {
        socket.write(JSON.stringify(msg) + '\n');
      } catch {
        // socket gone — ignore
      }
    };

    socket.setEncoding('utf8');
    // Enable TCP keepalive so the kernel surfaces half-open sockets faster
    // (e.g. IDE killed mid-session). This complements the application-level
    // heartbeat below.
    socket.setKeepAlive(true, 30_000);
    socket.on('data', (chunk: string) => {
      buf += chunk;
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let msg: IpcClientMessage;
        try {
          msg = JSON.parse(line);
        } catch {
          safeSend({ kind: 'denied', ok: false, reason: 'malformed json line' });
          continue;
        }

        if (!authed) {
          if (msg.kind !== 'hello') {
            safeSend({ kind: 'denied', ok: false, reason: 'first frame must be hello' });
            socket.destroy();
            return;
          }
          if (!this.checkToken(msg.token)) {
            safeSend({ kind: 'denied', ok: false, reason: 'invalid token' });
            socket.destroy();
            return;
          }
          authed = true;
          const name = msg.agentName || 'agent';
          // Dedup by agentName: when an IDE respawns the MCP client (Cursor does
          // this on every reload), the old socket may not have delivered `close`
          // yet. Without this, N restarts produce N zombie rows with the same
          // name in the popup. Replace the stale entry rather than accumulating.
          for (const [existingSocket, existing] of this.clients) {
            if (existing.agentName === name) {
              console.error(`[${SERVER_NAME}] replacing stale client ${existing.sessionId} (${name})`);
              existingSocket.destroy();
              this.clients.delete(existingSocket);
            }
          }
          client = {
            socket,
            sessionId: `s${++this.sessionIdCounter}`,
            agentName: name,
            connectedAt: Date.now(),
            pending: new Map(),
            missedPongs: 0,
          };
          this.clients.set(socket, client);
          safeSend({ kind: 'welcome', sessionId: client.sessionId, ok: true });
          console.error(`[${SERVER_NAME}] client connected: ${client.sessionId} (${client.agentName})`);
          return;
        }

        // Heartbeat reply — reset the miss counter. No further action.
        if (msg.kind === 'pong' && client) {
          client.missedPongs = 0;
          continue;
        }

        if (msg.kind === 'call' && client) {
          this.routeCall(client, msg).catch((err) => {
            safeSend({ kind: 'result', id: msg.id, success: false, error: String(err) });
          });
        }
      }
    });

    socket.on('close', () => {
      if (client) {
        console.error(`[${SERVER_NAME}] client disconnected: ${client.sessionId} (${client.agentName})`);
        // fail any of this client's in-flight calls
        for (const [clientId, entry] of client.pending) {
          this.pendingCalls.delete(entry.daemonCallId);
          void clientId;
        }
        this.clients.delete(socket);
      }
    });

    socket.on('error', () => {
      // logged via close; swallow to avoid uncaught
    });
  }

  /**
   * Heartbeat loop: every HEARTBEAT_INTERVAL_MS, ping every IPC client and
   * count missed pongs. A client that hasn't replied HEARTBEAT_MAX_MISSED times
   * in a row is treated as dead (half-open socket — e.g. IDE killed without a
   * graceful FIN) and evicted. `socket.destroy()` fires the existing `close`
   * cleanup, so we don't duplicate the teardown logic.
   */
  private startHeartbeat(): NodeJS.Timeout {
    return setInterval(() => {
      for (const [socket, client] of this.clients) {
        client.missedPongs++;
        if (client.missedPongs >= HEARTBEAT_MAX_MISSED) {
          console.error(`[${SERVER_NAME}] evicting dead client ${client.sessionId} (${client.agentName}) — ${client.missedPongs} missed pongs`);
          socket.destroy();
          continue;
        }
        try {
          socket.write(JSON.stringify({ kind: 'ping' }) + '\n');
        } catch {
          // write failure → close will fire
        }
      }
    }, HEARTBEAT_INTERVAL_MS);
  }

  private checkToken(presented: string): boolean {
    if (!presented || !this.token) return false;
    if (presented.length !== this.token.length) return false;
    // constant-time compare
    return crypto.timingSafeEqual(Buffer.from(presented), Buffer.from(this.token));
  }

  private async routeCall(client: IpcClient, msg: IpcClientMessage & { kind: 'call' }): Promise<void> {
    if (msg.kind !== 'call') return;
    const daemonCallId = `c${Date.now().toString(36)}-${msg.id}`;
    client.pending.set(msg.id, { tool: msg.tool, daemonCallId });
    this.pendingCalls.set(daemonCallId, { client, clientId: msg.id });

    // The bridge forwards params as-is; the sessionId is threaded through to
    // the extension via a `__sessionId` injection so the extension's tab-lock
    // layer (2.2) can attribute the call.
    const params = { ...msg.params, __sessionId: client.sessionId };
    try {
      const result = await this.bridge.callTool(msg.tool, params);
      this.sendToClient(client, { kind: 'result', id: msg.id, success: true, result });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      this.sendToClient(client, { kind: 'result', id: msg.id, success: false, error });
    } finally {
      client.pending.delete(msg.id);
      this.pendingCalls.delete(daemonCallId);
    }
  }

  private sendToClient(client: IpcClient, msg: IpcDaemonMessage): void {
    try {
      client.socket.write(JSON.stringify(msg) + '\n');
    } catch {
      // socket gone
    }
  }

  /**
   * HTTP handler for the popup (bridge delegates GETs here). Two routes:
   *   GET /pair   → { token }           (lets the extension auto-pair, no fs)
   *   GET /status → { extension, agents }   (popup shows connection + agents)
   * Both are localhost-only (the bridge only listens on localhost).
   */
  private handleHttp(req: http.IncomingMessage, url: URL): unknown {
    const path = url.pathname;
    if (path === '/pair') {
      return { token: this.token };
    }
    if (path === '/kill') {
      // Manual disconnect from the popup. GET because the bridge rejects
      // non-GET methods (bridge.ts) and there's no reason to widen it.
      const sid = url.searchParams.get('sessionId');
      if (!sid) return { ok: false, error: 'sessionId query param required' };
      const victim = Array.from(this.clients.values()).find((c) => c.sessionId === sid);
      if (!victim) return { ok: false, error: 'session not found' };
      // destroy() fires `close`, which runs the existing cleanup (fail in-flight
      // calls, delete from the map) — no duplicated teardown.
      console.error(`[${SERVER_NAME}] /kill evicting ${victim.sessionId} (${victim.agentName}) by popup request`);
      victim.socket.destroy();
      return { ok: true, killed: sid };
    }
    if (path === '/status') {
      return {
        extension: { connected: this.bridge.isConnected(), since: null },
        agents: this.agents(),
        uptimeMs: Date.now() - this.startedAt,
      };
    }
    return undefined; // bridge returns 404
  }

  /** Snapshot of connected agents, for the popup UI. */
  agents(): Array<{ sessionId: string; name: string; connectedAt: number }> {
    return Array.from(this.clients.values()).map((c) => ({
      sessionId: c.sessionId,
      name: c.agentName,
      connectedAt: c.connectedAt,
    }));
  }

  private writeDaemonInfo(): void {
    const info = {
      pid: process.pid,
      socket: IPC_SOCKET_PATH,
      port: DEFAULT_WS_PORT,
      host: DEFAULT_WS_HOST,
      startedAt: this.startedAt,
      version: '2.0.0',
    };
    fs.writeFileSync(DAEMON_INFO_FILE, JSON.stringify(info, null, 2));
  }

  /** @internal exposed for tests: number of connected MCP clients. */
  clientCount(): number {
    return this.clients.size;
  }

  stop(): void {
    this.bridge.stop();
    this.ipcServer?.close();
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    this.clients.forEach((c) => c.socket.destroy());
    this.clients.clear();
    try {
      fs.unlinkSync(IPC_SOCKET_PATH);
    } catch {}
    try {
      fs.unlinkSync(DAEMON_INFO_FILE);
    } catch {}
  }
}

async function main(): Promise<void> {
  const daemon = new Daemon();
  await daemon.start();
}

main().catch((err) => {
  console.error(`[${SERVER_NAME}] Fatal:`, err);
  process.exit(1);
});

export { Daemon };
