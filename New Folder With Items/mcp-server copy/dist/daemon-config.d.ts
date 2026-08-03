/**
 * Daemon configuration, IPC protocol, paths, and auth-token helpers.
 *
 * Architecture (see plan task 1.0):
 *   Agent (stdio) ──► thin MCP client (index.ts) ──IPC──► daemon (daemon.ts)
 *                                                              │ owns WS server :7225
 *                                                              ▼
 *                                                         Chrome extension
 *
 * The daemon is a pure multiplexer. It does NOT speak MCP. It ferries
 * `{id, tool, params}` calls between N stdio MCP clients (over a local IPC
 * socket) and the single Chrome extension (over WS), tagging every call with a
 * per-client `sessionId` so the extension can do per-agent tab locking (2.2).
 */
export declare const DEFAULT_WS_PORT: number;
export declare const DEFAULT_WS_HOST: string;
/**
 * Directory under the user's home where daemon state lives (token, socket,
 * daemon.json, daemon.log). Override with BC_STATE_DIR for isolated tests so
 * the suite never touches the real ~/.browser-controller.
 */
export declare const STATE_DIR: string;
/** Local IPC socket the daemon listens on (thin clients connect here). */
export declare const IPC_SOCKET_PATH: string;
/** Daemon metadata file: { pid, socket, port, startedAt }. */
export declare const DAEMON_INFO_FILE: string;
/** Auth token file (3.1): both IPC clients and the extension must present it. */
export declare const TOKEN_FILE: string;
/**
 * Enrollment secret file. A one-time out-of-band secret the legitimate
 * extension must present (via the X-BC-Enrollment header) on EVERY HTTP
 * endpoint — most importantly /pair, which is how it first obtains the auth
 * token. This closes the first-contact TOFU race: even if a co-installed
 * hostile extension wins the Origin-pinning race, it cannot obtain the token
 * because it does not know the enrollment secret (delivered to the user via
 * `npx browser-controller` terminal output and entered manually in the popup
 * once). See SECURITY.md "First-contact TOFU window".
 */
export declare const ENROLLMENT_FILE: string;
export type IpcClientMessage = {
    kind: 'hello';
    token: string;
    agentName?: string;
} | {
    kind: 'call';
    id: string;
    tool: string;
    params: Record<string, unknown>;
} | {
    kind: 'pong';
};
export type IpcDaemonMessage = {
    kind: 'welcome';
    sessionId: string;
    ok: true;
} | {
    kind: 'denied';
    reason: string;
    ok: false;
} | {
    kind: 'result';
    id: string;
    success: boolean;
    result?: unknown;
    error?: string;
} | {
    kind: 'status';
    connectionState: string;
    connectedSince: number | null;
} | {
    kind: 'ping';
};
/**
 * Message the daemon forwards to the extension. `sessionId` is included so the
 * extension can enforce per-agent tab locks (task 2.2). `id` is daemon-global.
 */
export interface ExtensionRequest {
    id: string;
    tool: string;
    params: Record<string, unknown>;
    sessionId: string;
}
export interface StoredToken {
    token: string;
    createdAt: number;
}
/** Reads the existing token, or creates the state dir + token on first run. */
export declare function loadOrCreateToken(): StoredToken;
/** Reads the token without creating one (returns null if absent). */
export declare function readToken(): string | null;
export interface StoredEnrollment {
    secret: string;
    createdAt: number;
}
/**
 * Reads the existing enrollment secret, or creates one on first run. The
 * secret is stable across daemon restarts (persisted to enrollment.json), so
 * the user pairs once and the popup keeps working after reboots. Rotating it
 * means deleting enrollment.json and re-running `npx browser-controller` (the
 * daemon prints the new secret on next start).
 *
 * Use readEnrollmentSecret() to peek without creating (e.g. index.ts decides
 * whether to print the "first run — here is your secret" banner).
 */
export declare function loadOrCreateEnrollment(): StoredEnrollment;
/** Reads the enrollment secret without creating one (returns null if absent). */
export declare function readEnrollmentSecret(): string | null;
//# sourceMappingURL=daemon-config.d.ts.map