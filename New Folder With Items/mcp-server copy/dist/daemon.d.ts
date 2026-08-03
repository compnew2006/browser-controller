#!/usr/bin/env node
declare class Daemon {
    private bridge;
    private ipcServer;
    private clients;
    /** daemon-global call id counter -> { client, clientId } to route the reply. */
    private pendingCalls;
    private sessionIdCounter;
    private token;
    private enrollmentSecret;
    private startedAt;
    /** Heartbeat timer — evicts half-open IPC sockets (see startHeartbeat). */
    private heartbeatTimer;
    constructor();
    start(): Promise<void>;
    private createIpcServer;
    private handleNewClient;
    /**
     * Heartbeat loop: every HEARTBEAT_INTERVAL_MS, ping every IPC client and
     * count missed pongs. A client that hasn't replied HEARTBEAT_MAX_MISSED times
     * in a row is treated as dead (half-open socket — e.g. IDE killed without a
     * graceful FIN) and evicted. `socket.destroy()` fires the existing `close`
     * cleanup, so we don't duplicate the teardown logic.
     */
    private startHeartbeat;
    private checkToken;
    private routeCall;
    private sendToClient;
    /**
     * HTTP handler for the popup (bridge delegates GETs here). Two routes:
     *   GET /pair   → { token }           (lets the extension auto-pair, no fs)
     *   GET /status → { extension, agents }   (popup shows connection + agents)
     * Both are localhost-only (the bridge only listens on localhost).
     */
    private handleHttp;
    /** Snapshot of connected agents, for the popup UI. */
    agents(): Array<{
        sessionId: string;
        name: string;
        connectedAt: number;
    }>;
    private writeDaemonInfo;
    /** @internal exposed for tests: number of connected MCP clients. */
    clientCount(): number;
    stop(): void;
}
export { Daemon };
//# sourceMappingURL=daemon.d.ts.map