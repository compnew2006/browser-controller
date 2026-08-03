import http from 'node:http';
/**
 * Signature of an HTTP request handler the daemon can register so it can serve
 * `/pair` (token bootstrap) and `/status` (connected agents) on the SAME port
 * as the WebSocket. Returning a value serializes it as JSON; returning undefined
 * means the handler already wrote the response.
 */
export type HttpRequestHandler = (req: http.IncomingMessage, url: URL) => unknown | void | Promise<unknown | void>;
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
/**
 * Cross-platform (no `lsof`) probe: returns true if something is listening on
 * host:port. Replaces the macOS/Linux-only `lsof` call (plan task 1.6).
 */
export declare function isPortInUse(host: string, port: number): Promise<boolean>;
/**
 * Find PIDs of processes LISTENing on `port`. Cross-platform:
 *   - macOS/Linux: `lsof -ti :PORT -sTCP:LISTEN`
 *   - Windows:     PowerShell `Get-NetTCPConnection -LocalPort PORT`
 * Returns [] on any failure (best-effort; callers handle the empty case).
 */
export declare function findListenersOnPort(port: number): number[];
export declare class ExtensionBridge {
    private httpServer;
    private wss;
    private client;
    private pendingRequests;
    private requestId;
    private port;
    private host;
    private token;
    private enrollmentSecret;
    private maxRetries;
    private pingIntervalMs;
    private defaultTimeoutMs;
    private pingTimer;
    private missedPongs;
    private connectionWaiters;
    /** Optional HTTP handler (set by the daemon) for /pair, /status, etc. */
    private httpHandler;
    /**
     * The extension Origin (`chrome-extension://<id>`) we pin on first contact,
     * used by the exact-match origin gate. null until the first extension-origin
     * request lands (TOFU). See isAllowedOrigin() for why this is per-process.
     */
    private pinnedExtensionOrigin;
    constructor(options: BridgeOptions);
    /**
     * Register an HTTP handler so the daemon can serve `/pair` and `/status` on
     * the same port as the WebSocket (the extension can then auto-discover the
     * token and poll connected agents without a second server/port).
     */
    registerHttpHandler(handler: HttpRequestHandler): void;
    start(): Promise<void>;
    /**
     * Cross-platform stale-process eviction (plan task 1.6). If the port is still
     * held after the first EADDRINUSE, find and SIGTERM the owning PID so the
     * daemon can recover when a previous instance crashed without releasing 7225.
     *   - macOS/Linux: `lsof -ti :PORT -sTCP:LISTEN`
     *   - Windows:     `Get-NetTCPConnection -LocalPort PORT` (via powershell)
     * Best-effort: if the owner can't be attributed (permission/odd platform),
     * the listen retry will surface EADDRINUSE again with a clear message.
     */
    private killStaleProcess;
    private tryListen;
    private startPingLoop;
    private stopPingLoop;
    private handleResponse;
    isConnected(): boolean;
    /**
     * Send a non-tool control message to the extension (e.g. notify it that an
     * agent disconnected, so it can release that session's tab locks). Fire-and-
     * forget: control messages carry no reply. Used by the daemon's close handler.
     */
    sendControl(type: string, payload?: Record<string, unknown>): void;
    waitForConnection(timeoutMs?: number): Promise<void>;
    callTool(tool: string, params: Record<string, unknown>, sessionId?: string, signal?: AbortSignal, agentName?: string): Promise<unknown>;
    private sendToolCall;
    private rejectAllPending;
    stop(): void;
}
export {};
//# sourceMappingURL=bridge.d.ts.map