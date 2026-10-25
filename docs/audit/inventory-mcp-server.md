# Inventory — MCP server (Node/TypeScript)

The process the MCP client launches: tool surface, extension bridge, daemon client, credential vault.

Symbols: **351** across **32** files.

Evidence column: `D` = purpose taken from the doc comment in the source; `R` = purpose written after reading the body; `B` = no doc comment, the quoted line is the whole body; `N` = no doc comment and a multi-statement body, so the purpose is derived from the identifier only (shown with `~`) — treat those as a label, not a verified description.

## mcp-server/src/bridge-connections.ts

185 lines · 18 symbols · 18 exported · fan-in 3 · fan-out 0

| line | kind | symbol | purpose | ev |
|---:|---|---|---|---|
| 22 | function | newConnection (exp) | ~ new connection | N |
| 31 | function | identityOf (exp) | Normalised identity from an extension helloAck (absent = "default"). | D |
| 45 | class | ExtensionConnections (exp, cx41) | The set of extension connections plus each session's browser choice. Routing: a session's selected browser, else the default — the … | D |
| 54 | method | ExtensionConnections.add (exp) | ~ add on ExtensionConnections | N |
| 55 | method | ExtensionConnections.has (exp) | ~ has on ExtensionConnections | N |
| 56 | method | ExtensionConnections.delete (exp) | ~ delete on ExtensionConnections | N |
| 57 | method | ExtensionConnections.all (exp) | ~ all on ExtensionConnections | N |
| 59 | method | ExtensionConnections.isLive (exp) | `return conn.state === 'ready' && conn.ws.readyState === WebSocket.OPEN;` | B |
| 63 | method | ExtensionConnections.live (exp) | `return this.all().filter((c) => ExtensionConnections.isLive(c));` | B |
| 72 | method | ExtensionConnections.identify (exp) | A connection's browser identity is now known (its helloAck). Only the first sighting of a browserId counts: a reconnect (service-worker … | D |
| 77 | method | ExtensionConnections.markReady (exp) | ~ mark ready on ExtensionConnections | N |
| 95 | method | ExtensionConnections.primary (exp) | The default browser: the earliest-seen live one. Connecting a second browser, or recycling the default's service worker, never moves it, … | D |
| 109 | method | ExtensionConnections.forSession (exp) | Where a session's calls go: its selected browser, else the default one. | D |
| 133 | method | ExtensionConnections.siblingsOf (exp) | Other sockets of the same browser (a reconnect replaces them). | D |
| 138 | method | ExtensionConnections.list (exp) | browser_tabs list: every connected extension, with this session's choice. | D |
| 156 | method | ExtensionConnections.select (exp) | browser_tabs {browser}: route this session's calls to one browser ("auto" = default). | D |
| 173 | method | ExtensionConnections.releaseSession (exp) | `this.sessionBrowser.delete(sessionId);` | B |
| 178 | method | ExtensionConnections.clear (exp) | ~ clear on ExtensionConnections | N |

## mcp-server/src/bridge-frames.ts

51 lines · 1 symbols · 1 exported · fan-in 3 · fan-out 0

| line | kind | symbol | purpose | ev |
|---:|---|---|---|---|
| 31 | function | rejectOversizedFrame (exp) | Oversized inbound frame (above `limit`). When it is a response to a call sent to this connection, that call fails … | D |

## mcp-server/src/bridge-security.ts

90 lines · 5 symbols · 5 exported · fan-in 2 · fan-out 0

| line | kind | symbol | purpose | ev |
|---:|---|---|---|---|
| 8 | function | corsHeaders (exp) | Build restrictive CORS headers for the one pinned extension origin. | D |
| 28 | function | isAllowedOrigin (exp) | Allow local non-browser clients or the exact extension origin pinned by TOFU. | D |
| 47 | function | extractToken (exp) | The auth token comes only from the `bc-auth.<token>` WebSocket subprotocol. A ?token= query is never read: query strings reach access … | D |
| 62 | function | tokensMatch (exp) | Compare credentials in constant time while preserving exact string equality. | D |
| 70 | function | isDaemonResponsiveOnPort (exp, async) | Probe the authenticated daemon endpoint without trusting the port owner. | D |

## mcp-server/src/bridge-tabs.ts

27 lines · 1 symbols · 1 exported · fan-in 1 · fan-out 1

| line | kind | symbol | purpose | ev |
|---:|---|---|---|---|
| 11 | function | tabsAcrossBrowsers (exp, async) | browser_tabs across several Chrome profiles (the bridge answers the browser part itself, the extension lists the tabs). `browser` first selects … | D |

## mcp-server/src/bridge.ts

593 lines · 22 symbols · 18 exported · fan-in 6 · fan-out 10

| line | kind | symbol | purpose | ev |
|---:|---|---|---|---|
| 72 | class | ExtensionBridge (exp, cx120) | ~ class extension bridge: 37 members | N |
| 101 | constructor | ExtensionBridge.constructor (exp) | ~ constructs ExtensionBridge | N |
| 116 | method | ExtensionBridge.markExtensionReady (exp) | ~ mark extension ready on ExtensionBridge | N |
| 130 | method | ExtensionBridge.rejectExtensionHandshake (exp) | ~ reject extension handshake on ExtensionBridge | N |
| 145 | method | ExtensionBridge.dropConn (exp) | Forget a connection and fail the calls that were waiting on it. | D |
| 160 | method | ExtensionBridge.registerHttpHandler (exp) | Register an HTTP handler so the daemon can serve `/pair` and `/status` on the same port as the WebSocket (the … | D |
| 164 | method | ExtensionBridge.start (exp, async) | ~ start on ExtensionBridge | N |
| 188 | method | ExtensionBridge.tryListen (exp, cx37) | ~ try listen on ExtensionBridge | N |
| 264 | const-function | pickAuthProtocol | handleProtocols picks the subprotocol to ACK in the handshake. The // extension offers `bc-auth.<token>`; we answer with the bare `bc-auth` … | D |
| 369 | method | ExtensionBridge.startPingLoop (exp) | ~ starts ping loop on ExtensionBridge | N |
| 384 | method | ExtensionBridge.stopPingLoop (exp) | ~ stops ping loop on ExtensionBridge | N |
| 391 | method | ExtensionBridge.handleResponse (exp) | ~ handles response on ExtensionBridge | N |
| 412 | method | ExtensionBridge.isConnected (exp) | `return this.conns.live().length > 0;` | B |
| 421 | method | ExtensionBridge.sendControl (exp) | Send a non-tool control message to the extension (e.g. notify it that an agent disconnected, so it can release that … | D |
| 434 | method | ExtensionBridge.waitForConnection (exp) | ~ waits for for connection on ExtensionBridge | N |
| 448 | object-function | resolve | `clearTimeout(timer);` | B |
| 452 | object-function | reject | `clearTimeout(timer);` | B |
| 460 | method | ExtensionBridge.callTool (exp, async) | ~ call tool on ExtensionBridge | N |
| 479 | method | ExtensionBridge.sendToolCall (exp) | ~ sends tool call on ExtensionBridge | N |
| 526 | const-function | onAbort | Cancellation (audit C2): if the caller aborts (daemon evicted the // client mid-call), tear down this pending entry and reject … | D |
| 565 | method | ExtensionBridge.rejectAllPending (exp) | Fail waiting calls: all of them, or only those sent to one browser. They read NOT_CONNECTED. | D |
| 577 | method | ExtensionBridge.stop (exp) | ~ stop on ExtensionBridge | N |

## mcp-server/src/daemon-config.ts

279 lines · 11 symbols · 11 exported · fan-in 6 · fan-out 0

| line | kind | symbol | purpose | ev |
|---:|---|---|---|---|
| 44 | function | envInt (exp) | Parse an integer env var, falling back to `def` when unset, non-numeric, or outside [min, max]. Bare `parseInt(process.env.X \|\| '…')` … | D |
| 80 | class | DaemonLockHeldError (exp) | Another daemon holds the runtime lock: this one lost the start race and must exit. | D |
| 83 | constructor | DaemonLockHeldError.constructor (exp) | ~ constructs DaemonLockHeldError | N |
| 98 | function | daemonLockHolder (exp) | Who holds daemon.lock: the pid of a live holder, 0 for a lock another daemon is still writing (created, not … | D |
| 115 | function | acquireDaemonLock (exp) | Acquire the runtime lock, removing only a demonstrably stale lock. Throws DaemonLockHeldError when another daemon holds it. | D |
| 132 | function | releaseDaemonLock (exp) | ~ releases daemon lock | N |
| 151 | function | openDaemonLog (exp) | Open daemon.log for appending, as the stdout/stderr of a daemon about to start. A log past maxBytes is first rotated … | D |
| 213 | function | loadOrCreateToken (exp) | Reads the existing token, or creates the state dir + token on first run. | D |
| 228 | function | readToken (exp) | Reads the token without creating one (returns null if absent). | D |
| 255 | function | loadOrCreateEnrollment (exp) | Reads the existing enrollment secret, or creates one on first run. The secret is stable across daemon restarts (persisted to … | D |
| 270 | function | readEnrollmentSecret (exp) | Reads the enrollment secret without creating one (returns null if absent). | D |

## mcp-server/src/daemon-reconnect.ts

125 lines · 7 symbols · 6 exported · fan-in 2 · fan-out 0

| line | kind | symbol | purpose | ev |
|---:|---|---|---|---|
| 47 | const-function | message | ~ message | N |
| 49 | class | Reconnector (exp) | ~ class reconnector: 11 members | N |
| 59 | constructor | Reconnector.constructor (exp) | `this.deps = deps;` | B |
| 66 | method | Reconnector.reconnect (exp) | Start a reconnect cycle, or join the running one. Resolves true once connected. | D |
| 75 | method | Reconnector.waitFor (exp, async) | For a tool call made while disconnected: join (or start) a cycle and wait up to timeoutMs. Resolves null once … | D |
| 85 | method | Reconnector.run (exp, async) | ~ run on Reconnector | N |
| 117 | method | Reconnector.takeRespawn (exp) | Record a daemon start, unless MAX_RESPAWNS already happened in the window. | D |

## mcp-server/src/daemon.ts

558 lines · 20 symbols · 0 exported · fan-in 0 · fan-out 5

| line | kind | symbol | purpose | ev |
|---:|---|---|---|---|
| 94 | class | Daemon (cx48) | ~ class daemon: 25 members | N |
| 115 | constructor | Daemon.constructor | ~ constructs Daemon | N |
| 130 | object-function | getBrowserContext (async) | ~ reads browser context | N |
| 131 | object-function | callVaultAction | ~ call vault action | N |
| 137 | method | Daemon.isSessionLive | `return [...this.clients.values()].some((client) => client.sessionId === session...` | B |
| 141 | method | Daemon.start (async) | ~ start on Daemon | N |
| 159 | const-function | shutdown | `console.error(`[${SERVER_NAME}] ${sig} received, shutting down`);` | B |
| 172 | method | Daemon.createIpcServer | ~ creates ipc server on Daemon | N |
| 196 | method | Daemon.handleNewClient (cx23) | ~ handles new client on Daemon | N |
| 201 | const-function | safeSend | ~ safe send | N |
| 348 | method | Daemon.startHeartbeat | Heartbeat loop: every HEARTBEAT_INTERVAL_MS, ping every IPC client and count missed pongs. A client that hasn't replied HEARTBEAT_MAX_MISSED times in … | D |
| 366 | method | Daemon.checkToken | ~ check token on Daemon | N |
| 380 | method | Daemon.routeCall (async) | ~ route call on Daemon | N |
| 444 | method | Daemon.sendToClient | ~ sends to client on Daemon | N |
| 458 | method | Daemon.handleHttp | HTTP handler for the popup (bridge delegates GETs here). Two routes: GET /pair → { token } (lets the extension … | D |
| 489 | method | Daemon.agents | Snapshot of connected agents, for the popup UI. | D |
| 497 | method | Daemon.writeDaemonInfo | ~ writes daemon info on Daemon | N |
| 516 | method | Daemon.clientCount | @internal exposed for tests: number of connected MCP clients. | D |
| 520 | method | Daemon.stop | ~ stop on Daemon | N |
| 540 | function | main (async) | `const daemon = new Daemon();` | B |

## mcp-server/src/index.ts

541 lines · 23 symbols · 0 exported · fan-in 0 · fan-out 5

| line | kind | symbol | purpose | ev |
|---:|---|---|---|---|
| 34 | function | parseAgentArg | Parse `--agent <name>` (or `--agent=<name>`) from argv. This is the user-facing way to name the agent in the MCP config, … | D |
| 98 | class | DaemonClient (cx45) | Daemon connection: a line-delimited JSON socket speaking the IPC protocol defined in daemon-config.ts (hello/welcome/call/result). | D |
| 104 | getter | DaemonClient.sessionId | @returns session ID assigned by the daemon, for logging. | D |
| 123 | constructor | DaemonClient.constructor | `this.ipcPath = ipcPath;` | B |
| 130 | getter | DaemonClient.connected | True while the daemon has welcomed this client and the socket is open. | D |
| 134 | method | DaemonClient.connect (async) | ~ connect on DaemonClient | N |
| 144 | const-function | onErr | ~ callback for err | N |
| 196 | method | DaemonClient.waitForWelcome | ~ waits for for welcome on DaemonClient | N |
| 198 | const-function | settle | ~ settle | N |
| 209 | method | DaemonClient.handleMessage | ~ handles message on DaemonClient | N |
| 262 | method | DaemonClient.callTool (async) | ~ call tool on DaemonClient | N |
| 296 | method | DaemonClient.failAll | ~ fail all on DaemonClient | N |
| 304 | method | DaemonClient.close | `this.socket?.destroy();` | B |
| 310 | method | DaemonClient.onClose | Register a handler fired when the daemon socket closes (main() reconnects there). | D |
| 340 | function | connectProbe | Active probe: try to open+close the IPC socket. A live daemon accepts immediately; a crashed-but-not-reaped process refuses or hangs. 250ms … | D |
| 349 | function | daemonLooksAlive (async) | ~ daemon looks alive | N |
| 382 | function | daemonState (async) | Whether a daemon answers, is starting (daemon.lock names a live pid), or neither. | D |
| 394 | function | deriveAgentName | Best-effort detection of which MCP client launched us, so the popup can show "Cursor" / "Claude Desktop" instead of the … | D |
| 419 | function | spawnDaemon | Spawn the daemon as a detached background process. | D |
| 439 | function | waitForDaemon (async) | Wait until the IPC socket becomes connectable. | D |
| 455 | function | main (async) | ~ main | N |
| 511 | object-function | connect | ~ connect | N |
| 516 | object-function | log | ~ log | N |

## mcp-server/src/native-host.ts

130 lines · 7 symbols · 4 exported · fan-in 1 · fan-out 1

| line | kind | symbol | purpose | ev |
|---:|---|---|---|---|
| 40 | function | encodeMessage (exp) | Native messaging frame: 32-bit length in native byte order, then UTF-8 JSON. | D |
| 49 | function | decodeMessage (exp) | The first complete frame in `buf`, or undefined while it is still incomplete. | D |
| 58 | function | daemonPort | The running daemon's port (daemon.JSON), else the configured default. | D |
| 70 | function | handleRequest (exp) | ~ handles request | N |
| 82 | function | runHost (exp) | Read one request from `input`, write one response to `output`. | D |
| 90 | const-function | reply | ~ reply | N |
| 112 | function | isMainModule | ~ tests whether main module | N |

## mcp-server/src/protocol.ts

183 lines · 11 symbols · 11 exported · fan-in 12 · fan-out 0

| line | kind | symbol | purpose | ev |
|---:|---|---|---|---|
| 7 | function | newDaemonInstanceId (exp) | Random ID: 8 base36 characters. | D |
| 21 | function | buildSessionId (exp) | `s-<instance>-<n>`: unique across daemon restarts, readable in logs and UI. | D |
| 63 | function | validateProtocolVersion (exp) | ~ validates protocol version | N |
| 73 | function | validateCapabilities (exp) | ~ validates capabilities | N |
| 96 | function | validateExtensionCapabilities (exp) | The extension's helloAck must carry the 3.0 contract. A peer that lacks tools-v3, or sends no capabilities at all, is … | D |
| 108 | function | validateExtensionHelloAck (exp) | Gate for the extension's helloAck, run before any tool call is routed to it. An explicit protocolVersion and the 3.0 … | D |
| 131 | function | validateIpcHandshake (exp) | IPC handshake gate, run on both sides: the thin client checks the daemon's welcome, the daemon checks the client's hello. … | D |
| 144 | function | buildIpcHello (exp) | ~ builds ipc hello | N |
| 154 | function | buildIpcWelcome (exp) | ~ builds ipc welcome | N |
| 164 | function | buildExtensionHello (exp) | ~ builds extension hello | N |
| 175 | function | buildExtensionHelloAck (exp) | ~ builds extension hello ack | N |

## mcp-server/src/register-tools.ts

196 lines · 11 symbols · 2 exported · fan-in 5 · fan-out 4

| line | kind | symbol | purpose | ev |
|---:|---|---|---|---|
| 13 | function | checkPayloadLimits | ~ check payload limits | N |
| 75 | const-function | pathText | ~ path text | N |
| 80 | const-function | valueAt | ~ value at | N |
| 86 | function | describeIssue | One short line per zod issue, as the agent reads it. | D |
| 109 | function | parseToolParams (exp) | Validate a call's arguments against the tool's schema and the payload limits. A failure is one `INVALID_ARGUMENT: …` error: `field … | D |
| 123 | function | codedText | A failure text the agent reads: a text with no code gets INTERNAL_ERROR in front (a batch step's `step i/n … | D |
| 128 | function | failure | `return { content: [{ type: 'text' as const, text: codedText(text) }], isError: ...` | B |
| 133 | function | codedResult | A tool's own failure result, with its text coded the same way as a thrown one. | D |
| 140 | function | wrapHandler | Run a tool: validate, call its handler, and turn every failure into a `CODE: message` result (never a protocol error). | D |
| 162 | function | registerTools (exp) | Tool registration, extracted from index.ts's main() so the wiring is testable without a live daemon (see tests/register-tools.test.ts, which drives a … | D |
| 164 | object-function | confirm (async) | ~ confirm | N |

## mcp-server/src/tools/action-support.ts

283 lines · 13 symbols · 5 exported · fan-in 5 · fan-out 2

| line | kind | symbol | purpose | ev |
|---:|---|---|---|---|
| 20 | function | attachSafetyController (exp) | `controllerByHost.set(host, controller);` | B |
| 25 | function | setSafetySettings (exp) | ~ sets safety settings | N |
| 32 | function | getSafetySettings (exp) | `const settings = settingsByHost.get(host);` | B |
| 38 | function | classificationParams | ~ classification params | N |
| 53 | function | targetSummary | ~ target summary | N |
| 68 | function | classify (async) | ~ classify | N |
| 81 | function | enforceActionSafety (exp, async, cx24) | Run before dispatch. The classifier receives targets and action kinds only, never field values. | D |
| 158 | function | snapshot (async) | ~ snapshot | N |
| 170 | function | diff | ~ diff | N |
| 184 | function | summaryOf | ~ summary of | N |
| 192 | function | withReceipt | ~ wrapper that supplies receipt | N |
| 200 | function | actionHandler (exp, cx42) | Preserve the legacy text content while adding a safe, machine-readable action receipt. | D |
| 205 | const-function | wrapped (async, cx41) | ~ wrapped | N |

## mcp-server/src/tools/batch.ts

145 lines · 6 symbols · 0 exported · fan-in 1 · fan-out 5

| line | kind | symbol | purpose | ev |
|---:|---|---|---|---|
| 8 | const-function | sleep | ~ sleep | N |
| 19 | function | untilDeadline (async) | Runs one step until the batch deadline. A step still running then is left behind: its late result or error … | D |
| 37 | function | runStep (async) | One step. A pure delay (browser_wait with only `ms`) sleeps here instead of costing a daemon call, capped at BATCH_MAX_DELAY_MS. … | D |
| 59 | function | messageOf | The step's failure text: its CODE: message string. | D |
| 88 | object-function | handler (async, cx25) | ~ handler | N |
| 96 | const-function | withReceipts | `? { ...result, structuredContent: { success, steps: receipts } }` | B |

## mcp-server/src/tools/fill.ts

147 lines · 8 symbols · 0 exported · fan-in 2 · fan-out 4

| line | kind | symbol | purpose | ev |
|---:|---|---|---|---|
| 16 | function | unreadableFiles (async) | Local paths that are not readable regular files. The extension cannot stat files, and DOM.setFileInputFiles accepts a missing path as … | D |
| 38 | const-function | looksLikePath | A value that may be a local path: ~/, POSIX absolute, or a Windows drive (C:/ or C:\\). Any field … | D |
| 40 | const-function | expandHome | ~ expand home | N |
| 43 | const-function | nameOf | The last path segment, for messages (names only: the local directory layout is not the agent's business). | D |
| 56 | function | isSecretPath | `const parts = path.split(/[\\/]+/);` | B |
| 62 | function | refusalReason (async) | Why an upload path is refused, if it is: the vault tree is named apart from hidden files. | D |
| 78 | const-function | mayBeFile | Whether a string may name a file: absolute, ~/, or with a path separator. A bare word ("en", "Ada", ".net") … | D |
| 86 | const-function | handler (async) | Path-like values are checked here: hidden or credential files are refused (nothing is sent). Paths that cannot be read are … | D |

## mcp-server/src/tools/index.ts

111 lines · 3 symbols · 2 exported · fan-in 10 · fan-out 20

| line | kind | symbol | purpose | ev |
|---:|---|---|---|---|
| 62 | function | capabilityOf | `if (tool.idempotent === true) return 'read';` | B |
| 90 | function | isIdempotent (exp) | `return idempotentToolNames.has(tool);` | B |
| 108 | function | toolTimeoutMs (exp) | `return timeoutByToolName.get(tool);` | B |

## mcp-server/src/tools/safety.ts

43 lines · 1 symbols · 0 exported · fan-in 1 · fan-out 2

| line | kind | symbol | purpose | ev |
|---:|---|---|---|---|
| 28 | object-function | handler (async) | ~ handler | N |

## mcp-server/src/tools/types.ts

216 lines · 9 symbols · 8 exported · fan-in 53 · fan-out 0

| line | kind | symbol | purpose | ev |
|---:|---|---|---|---|
| 73 | function | textResult (exp) | `return { content: [{ type: "text", text }] };` | B |
| 78 | function | failureResult (exp) | A failed call: the text is `CODE: message`, and the MCP result has isError set. | D |
| 121 | function | unknownParameterHint (exp) | The 3.0 replacement for a removed 2.x parameter name, or undefined for any other name. | D |
| 132 | function | codedMessageOf (exp) | The `CODE: message` text of a thrown error. A message that already carries a code passes through; anything else is … | D |
| 142 | function | payloadOf (exp) | The in-band failure payload attached to a rejection by the bridge/daemon chain (unified error channel), if any. Used by forwardHandler, … | D |
| 150 | function | rawResultOf (exp) | Machine fields of a forwarded result, for the batch's tabId propagation. | D |
| 161 | function | outcomeOf (exp) | Wire form of an extension result. Success: its `text` is the one text the agent reads (JSON when there is … | D |
| 200 | function | forwardHandler (exp) | this body was previously copy-pasted across nearly every tool file). Forwards to the host and maps the result with outcomeOf. … | D |
| 201 | const-function | handler (async) | ~ handler | N |

## mcp-server/src/tools/vault.ts

34 lines · 1 symbols · 0 exported · fan-in 1 · fan-out 2

| line | kind | symbol | purpose | ev |
|---:|---|---|---|---|
| 17 | const-function | fail | ~ fail | N |

## mcp-server/src/vault/bridge-transport.ts

223 lines · 18 symbols · 17 exported · fan-in 1 · fan-out 3

| line | kind | symbol | purpose | ev |
|---:|---|---|---|---|
| 17 | class | VaultBridgeTransport (exp, cx69) | Owns the private vault wire protocol, separate from normal retried tools. | D |
| 22 | constructor | VaultBridgeTransport.constructor (exp) | ~ constructs VaultBridgeTransport | N |
| 24 | method | VaultBridgeTransport.setService (exp) | `this.service = service;` | B |
| 28 | method | VaultBridgeTransport.supportsVault (exp) | `return conn.capabilities.includes(CREDENTIAL_VAULT_CAPABILITY);` | B |
| 32 | method | VaultBridgeTransport.hasUniqueIdentity (exp) | `return this.connections.live().filter((candidate) => candidate.browserId === co...` | B |
| 36 | method | VaultBridgeTransport.getBrowserContext (exp) | ~ reads browser context on VaultBridgeTransport | N |
| 53 | method | VaultBridgeTransport.selectBrowser (exp) | `return this.connections.select(sessionId, browser);` | B |
| 57 | method | VaultBridgeTransport.callAction (exp, async, cx23) | ~ call action on VaultBridgeTransport | N |
| 99 | const-function | onAbort | `const target = this.pending.get(id);` | B |
| 116 | method | VaultBridgeTransport.handleMessage (exp) | ~ handles message on VaultBridgeTransport | N |
| 151 | method | VaultBridgeTransport.connectionDropped (exp) | `this.service?.revokeConnection(conn.browserId, conn.connectionId);` | B |
| 156 | method | VaultBridgeTransport.rejectPending (exp) | ~ reject pending on VaultBridgeTransport | N |
| 165 | method | VaultBridgeTransport.detachAction (exp) | `clearTimeout(pending.timeout);` | B |
| 171 | method | VaultBridgeTransport.rejectAction (exp) | `this.detachAction(id, pending);` | B |
| 177 | method | VaultBridgeTransport.validateFillParams (exp) | ~ validates fill params on VaultBridgeTransport | N |
| 188 | method | VaultBridgeTransport.resolveAction (exp) | ~ resolves action on VaultBridgeTransport | N |
| 199 | method | VaultBridgeTransport.handleUiRequest (exp, async) | ~ handles UI request on VaultBridgeTransport | N |
| 219 | method | VaultBridgeTransport.send (exp) | `try { conn.ws.send(JSON.stringify(message)); } catch { /* socket closing */ }` | B |

## mcp-server/src/vault/daemon-routing.ts

100 lines · 5 symbols · 1 exported · fan-in 2 · fan-out 2

| line | kind | symbol | purpose | ev |
|---:|---|---|---|---|
| 30 | function | isRecord | `return value !== null && typeof value === 'object' && !Array.isArray(value);` | B |
| 34 | function | safeErrorText | ~ safe error text | N |
| 43 | function | routeVaultAwareCall (exp, async) | Applies profile selection, vault authorization and result scrubbing at the daemon boundary. | D |
| 48 | const-function | sanitize | ~ sanitize | N |
| 90 | function | assertVaultPathsNotUploaded (async) | ~ asserts vault paths not uploaded | N |

## mcp-server/src/vault/protected-paths.ts

22 lines · 2 symbols · 1 exported · fan-in 2 · fan-out 0

| line | kind | symbol | purpose | ev |
|---:|---|---|---|---|
| 5 | function | inside | `const relative = path.relative(root, candidate);` | B |
| 11 | function | isCredentialVaultPath (exp, async) | True for the vault store/key/backup tree, including symlink aliases. | D |

## mcp-server/src/vault/redaction.ts

259 lines · 17 symbols · 17 exported · fan-in 4 · fan-out 0

| line | kind | symbol | purpose | ev |
|---:|---|---|---|---|
| 4 | function | secretVariants (exp) | Every shape a secret may take in page text: normalization forms and both line endings. | D |
| 18 | function | charactersOf (exp) | The characters a marker must avoid: every character of every value in scope. | D |
| 27 | function | unusedPrivateUseCharacter (exp) | First private-use code point no value in scope contains; '' when every one is taken. | D |
| 93 | class | VaultRedactionRegistry (exp, cx67) | Per-daemon, per-browser output scrubber. Raw values live only in this in-memory registry; callers register a value before the extension receives … | D |
| 96 | method | VaultRedactionRegistry.register (exp) | ~ register on VaultRedactionRegistry | N |
| 116 | method | VaultRedactionRegistry.hasSecrets (exp) | `return (this.byScope.get(scope)?.size ?? 0) > 0;` | B |
| 120 | method | VaultRedactionRegistry.hasSecretForDocument (exp) | ~ tests whether there is secret for document on VaultRedactionRegistry | N |
| 127 | method | VaultRedactionRegistry.removeDocument (exp) | ~ remove document on VaultRedactionRegistry | N |
| 141 | method | VaultRedactionRegistry.sanitize (exp) | ~ sanitize on VaultRedactionRegistry | N |
| 149 | method | VaultRedactionRegistry.replacementFor (exp) | ~ replacement for on VaultRedactionRegistry | N |
| 159 | method | VaultRedactionRegistry.sanitizeValue (exp, cx31) | ~ sanitize value on VaultRedactionRegistry | N |
| 209 | method | VaultRedactionRegistry.isTrustedRootField (exp) | `const fields = context.toolName ? TRUSTED_TOOL_RESULT_FIELDS[context.toolName] ...` | B |
| 214 | method | VaultRedactionRegistry.isVaultEnumField (exp) | ~ tests whether vault enum field on VaultRedactionRegistry | N |
| 222 | method | VaultRedactionRegistry.sanitizeVaultError (exp) | ~ sanitize vault error on VaultRedactionRegistry | N |
| 231 | method | VaultRedactionRegistry.containsSecret (exp) | `return records.some((record) => record.variants.some((variant) => value.include...` | B |
| 235 | method | VaultRedactionRegistry.isTrustedScreenshotImage (exp) | ~ tests whether trusted screenshot image on VaultRedactionRegistry | N |
| 249 | method | VaultRedactionRegistry.sanitizeString (exp) | ~ sanitize string on VaultRedactionRegistry | N |

## mcp-server/src/vault/service-common.ts

169 lines · 11 symbols · 11 exported · fan-in 5 · fan-out 3

| line | kind | symbol | purpose | ev |
|---:|---|---|---|---|
| 20 | function | publicMetadataOf (exp) | `const { id, ...metadata } = metadataOf(entry);` | B |
| 25 | function | containsCredentialSecret (exp) | `return entries.some((entry) => secretVariants(entry.password).some((variant) =>...` | B |
| 29 | function | metadataMarker (exp) | `return unusedPrivateUseCharacter(charactersOf(entries.flatMap((entry) => secret...` | B |
| 35 | function | safePublicMetadataOf (exp) | ~ safe public metadata of | N |
| 116 | class | VaultServiceError (exp) | ~ class vault service error: 1 members | N |
| 117 | constructor | VaultServiceError.constructor (exp) | `super(`${code}: ${message}`);` | B |
| 123 | function | isRecord (exp) | `return value !== null && typeof value === 'object' && !Array.isArray(value);` | B |
| 127 | function | safeCode (exp) | ~ safe code | N |
| 136 | function | safeMessage (exp) | ~ safe message | N |
| 159 | function | publicError (exp) | `const message = safeMessage(code);` | B |
| 164 | function | requireStrictKeys (exp) | `if (Object.keys(value).some((key) => !allowed.includes(key))) throw new VaultSe...` | B |

## mcp-server/src/vault/service-core.ts

361 lines · 34 symbols · 31 exported · fan-in 1 · fan-out 4

| line | kind | symbol | purpose | ev |
|---:|---|---|---|---|
| 12 | class | VaultServiceCore (exp, cx114) | Shared state and rules for the vault service: stores, grants, pending requests, in-flight operations and protection state. | R |
| 28 | constructor | VaultServiceCore.constructor (exp) | Injects the state directory, the browser transport, the liveness probe and the clock. | R |
| 35 | method | VaultServiceCore.publicStatus (exp, async) | Reports either one private request's state or the vault's own state for the caller's browser. | R |
| 61 | method | VaultServiceCore.contextForSession (exp, async) | Resolves the caller's verified browser context and refuses ambiguous, unverified or vault-less connections. | R |
| 72 | method | VaultServiceCore.storeFor (exp) | Returns the per-namespace store, creating and caching it on first use. | R |
| 82 | method | VaultServiceCore.inspect (exp, async) | Asks the extension to find exactly one safe password field and validates the inspection it returns. | R |
| 104 | method | VaultServiceCore.assertOrigin (exp) | Refuses an origin the vault does not support (non-HTTPS, credentials in URL). | R |
| 109 | method | VaultServiceCore.beginRequest (exp, async) | Records a pending private request and opens the vault UI for the user to answer it. | R |
| 143 | method | VaultServiceCore.requestRequired (exp) | Builds the user_action_required answer that carries the request id back to the agent. | R |
| 155 | method | VaultServiceCore.expireRequests (exp) | Expires overdue pending requests and drops terminal ones after the retention window. | R |
| 165 | method | VaultServiceCore.findGrant (exp) | Finds a live grant for this session, browser, origin and purpose, honouring one-shot and credential binding. | R |
| 173 | method | VaultServiceCore.markProtected (exp) | Records a protected document under its browser scope. | R |
| 182 | method | VaultServiceCore.pendingForConnection (exp) | Resolves a request id only when it belongs to this exact browser connection. | R |
| 189 | method | VaultServiceCore.claimPending (exp) | Moves a pending request to processing and registers the operation the fill will run under. | R |
| 205 | method | VaultServiceCore.settle (exp) | Ends a private request: records its final state once, with the time it ended. | R |
| 210 | method | VaultServiceCore.trackOperation (exp) | Creates the abortable operation record for a request, linking it to a parent signal when given. | R |
| 234 | method | VaultServiceCore.completeOperation (exp) | Drops an operation and resolves its done promise, unhooking any parent signal listener. | R |
| 244 | method | VaultServiceCore.operationSignal (exp) | The abort signal of the operation behind a request. | R |
| 249 | method | VaultServiceCore.abortOperationsMatching (exp) | Aborts in-flight work now; a caller that needs completion also awaits a waitForOperations call. | R |
| 254 | method | VaultServiceCore.cancelRequests (exp) | Cancels matching live private requests and aborts the work bound to them. | R |
| 262 | method | VaultServiceCore.cancelScopeOperations (exp, async) | Cancels every request and operation for one browser scope and waits for them to end. | R |
| 264 | const-function | inScope | ~ in scope | N |
| 269 | method | VaultServiceCore.cancelCredentialOperations (exp, async) | Aborts and awaits the operations working on one credential. | R |
| 270 | const-function | matching | ~ matching | N |
| 275 | method | VaultServiceCore.cancelGrantOperations (exp, async) | Aborts and awaits the operations bound to one grant. | R |
| 276 | const-function | matching | ~ matching | N |
| 281 | method | VaultServiceCore.waitForOperationsMatching (exp, async) | Waits for every operation matching a predicate to finish. | R |
| 286 | method | VaultServiceCore.revalidatePending (exp) | Whether a pending request is still unexpired and its session still live. | R |
| 290 | method | VaultServiceCore.revalidateDocument (exp, async) | Re-inspects the page and proves the browser identity, origin and document are unchanged before an answer is applied. | R |
| 302 | method | VaultServiceCore.createGrant (exp) | Creates a live grant (list or fill, optionally one-shot and credential-bound) with no expiry. | R |
| 327 | method | VaultServiceCore.requestState (exp) | The minimal status answer for a request: state plus request id. | R |
| 331 | method | VaultServiceCore.ensureUiUnlocked (exp, async) | Initialises an empty vault, refuses an incomplete one, and unlocks a locked one, for the UI path. | R |
| 338 | method | VaultServiceCore.auditEvent (exp) | Builds one audit event, pseudonymising the session id with an in-memory HMAC key. | R |
| 347 | method | VaultServiceCore.writeAudit (exp, async) | Writes an audit event only when the store is unlocked. | R |

## mcp-server/src/vault/service-private.ts

328 lines · 15 symbols · 15 exported · fan-in 1 · fan-out 4

| line | kind | symbol | purpose | ev |
|---:|---|---|---|---|
| 9 | class | VaultServicePrivate (exp, cx187) | ~ class vault service private: 14 members | N |
| 10 | method | VaultServicePrivate.handlePrivateUi (exp, async, cx24) | ~ handles private UI on VaultServicePrivate | N |
| 66 | method | VaultServicePrivate.assertInitiator (exp, async) | Re-reads the live browser identity and refuses a request that crossed connections. | D |
| 74 | method | VaultServicePrivate.privateState (exp, async) | ~ private state on VaultServicePrivate | N |
| 106 | method | VaultServicePrivate.safeRequestView (exp) | ~ safe request view on VaultServicePrivate | N |
| 124 | method | VaultServicePrivate.privateUnlock (exp, async, cx21) | ~ private unlock on VaultServicePrivate | N |
| 154 | method | VaultServicePrivate.privateLock (exp, async) | ~ private lock on VaultServicePrivate | N |
| 164 | method | VaultServicePrivate.privateSave (exp, async, cx61) | ~ private save on VaultServicePrivate | N |
| 227 | method | VaultServicePrivate.privateApprove (exp, async, cx35) | ~ private approve on VaultServicePrivate | N |
| 269 | method | VaultServicePrivate.finishRequest (exp) | ~ finishes request on VaultServicePrivate | N |
| 278 | method | VaultServicePrivate.privateRemove (exp, async) | ~ private remove on VaultServicePrivate | N |
| 289 | method | VaultServicePrivate.privateRevoke (exp, async) | ~ private revoke on VaultServicePrivate | N |
| 306 | method | VaultServicePrivate.privateBackup (exp, async) | ~ private backup on VaultServicePrivate | N |
| 314 | method | VaultServicePrivate.privateListBackups (exp, async) | `return { success: true, backups: await this.storeFor(connection.browserId).list...` | B |
| 318 | method | VaultServicePrivate.privateRestore (exp, async) | ~ private restore on VaultServicePrivate | N |

## mcp-server/src/vault/service-protection.ts

273 lines · 17 symbols · 12 exported · fan-in 1 · fan-out 4

| line | kind | symbol | purpose | ev |
|---:|---|---|---|---|
| 11 | class | RedactionRemovalQueue | Owns when a redaction record may be removed. Removal waits for every browser reply that was already in flight, so … | D |
| 15 | constructor | RedactionRemovalQueue.constructor | ~ constructs RedactionRemovalQueue | N |
| 21 | method | RedactionRemovalQueue.retain | Defers removals for `scope`; the returned release is idempotent. | D |
| 42 | method | RedactionRemovalQueue.removeWhenIdle | Removes now, or once the last retained reply for `scope` is sanitized. | D |
| 57 | function | navigationSummary | Navigation output after protection was lost or is uncertain: keep the outcome, drop every page payload. | D |
| 65 | class | VaultServiceProtection (exp, cx98) | ~ class vault service protection: 12 members | N |
| 71 | method | VaultServiceProtection.pinBrowserId (exp, async) | ~ pin browser ID on VaultServiceProtection | N |
| 82 | method | VaultServiceProtection.endSession (exp) | `this.revokeSession(sessionId);` | B |
| 89 | method | VaultServiceProtection.retainRedactionForBrowser (exp) | Keep output redaction available until the active browser call has been scrubbed. | D |
| 93 | method | VaultServiceProtection.sanitizeForSession (exp, async) | ~ sanitize for session on VaultServiceProtection | N |
| 127 | method | VaultServiceProtection.assertToolAllowed (exp, async, cx30) | ~ asserts tool allowed on VaultServiceProtection | N |
| 172 | method | VaultServiceProtection.noteProtectionState (exp, cx20) | Full state from an authenticated extension connection; no secret values are accepted. | D |
| 220 | method | VaultServiceProtection.discardProtectedTab (exp) | Only an authenticated, explicit tab-destruction event may clear taint. | D |
| 241 | method | VaultServiceProtection.revokeSession (exp) | ~ revoke session on VaultServiceProtection | N |
| 251 | method | VaultServiceProtection.revokeConnection (exp) | A reconnect is a new authority epoch even when the copied profile ID matches. | D |
| 261 | method | VaultServiceProtection.cancelPrivateUiRequests (exp) | Closing the authenticated private vault page cancels its waiting approvals. | D |
| 266 | method | VaultServiceProtection.lockAll (exp) | ~ lock all on VaultServiceProtection | N |

## mcp-server/src/vault/service.ts

183 lines · 6 symbols · 6 exported · fan-in 4 · fan-out 5

| line | kind | symbol | purpose | ev |
|---:|---|---|---|---|
| 8 | class | VaultService (exp, cx70) | ~ class vault service: 5 members | N |
| 9 | method | VaultService.handlePublic (exp, async) | ~ handles public on VaultService | N |
| 54 | method | VaultService.inspectSupportedSite (exp, async) | The current page, refused here when its origin is not a supported site. | D |
| 61 | method | VaultService.requestForInspection (exp, async) | Opens the private-page request this inspection needs and reports it to the caller. | D |
| 80 | method | VaultService.fillGranted (exp, async, cx28) | ~ fill granted on VaultService | N |
| 159 | method | VaultService.grantStillUsable (exp, async) | ~ grant still usable on VaultService | N |

## mcp-server/src/vault/store-errors.ts

12 lines · 3 symbols · 3 exported · fan-in 3 · fan-out 0

| line | kind | symbol | purpose | ev |
|---:|---|---|---|---|
| 1 | class | VaultStorageError (exp) | ~ class vault storage error: 1 members | N |
| 2 | constructor | VaultStorageError.constructor (exp) | `super(`${code}: ${message}`, options);` | B |
| 9 | function | fileError (exp) | A storage failure whose message names no secret path or value. | D |

## mcp-server/src/vault/store-format.ts

83 lines · 4 symbols · 4 exported · fan-in 1 · fan-out 2

| line | kind | symbol | purpose | ev |
|---:|---|---|---|---|
| 27 | function | envelopeFor (exp) | ~ envelope for | N |
| 42 | function | dataFromEnvelope (exp) | ~ data from envelope | N |
| 69 | function | parseJson (exp) | `try { return JSON.parse(bytes.toString('utf8')); }` | B |
| 74 | function | parseBackup (exp) | ~ parses backup | N |

## mcp-server/src/vault/store.ts

580 lines · 38 symbols · 35 exported · fan-in 7 · fan-out 4

| line | kind | symbol | purpose | ev |
|---:|---|---|---|---|
| 19 | function | scopeForBrowser (exp) | Derives the per-browser vault namespace: SHA-256 of the browser identity, rejecting empty or over-long ids. | R |
| 35 | function | currentUid | Returns the current process uid, or undefined on platforms without getuid. | R |
| 39 | function | assertOwnerMode | Rejects a path that is a symlink, the wrong file type, another user's, or group/world-accessible. | R |
| 54 | class | CredentialVaultStore (exp, cx130) | One browser-scoped AES-GCM vault: a single atomically replaced envelope plus a separate owner-only key file. | R |
| 68 | constructor | CredentialVaultStore.constructor (exp) | Resolves the namespace directory and the key, store, lock, backup and restore-journal paths under stateDir. | R |
| 81 | getter | CredentialVaultStore.isUnlocked (exp) | Whether the in-memory key is currently held. | R |
| 83 | method | CredentialVaultStore.lock (exp) | Zeroes and drops the in-memory key. | R |
| 88 | method | CredentialVaultStore.status (exp, async) | Reports empty, ready or incomplete from the presence of key, store and restore journal. | R |
| 97 | method | CredentialVaultStore.initialize (exp, async) | Creates the first key and empty envelope, refusing to touch any pre-existing state. | R |
| 119 | method | CredentialVaultStore.unlock (exp, async) | Reads the key and proves the envelope decrypts before holding the key in memory. | R |
| 140 | method | CredentialVaultStore.list (exp, async) | Returns copies of every credential entry. | R |
| 144 | method | CredentialVaultStore.get (exp, async) | Returns one credential by id, or null. | R |
| 149 | method | CredentialVaultStore.upsert (exp, async) | Validates and inserts or replaces one entry, preserving its original createdAt and the 1000-entry cap. | R |
| 163 | method | CredentialVaultStore.remove (exp, async) | Deletes one entry and reports whether it existed. | R |
| 173 | method | CredentialVaultStore.audit (exp, async) | Appends an audit event and trims the audit log to its cap. | R |
| 180 | method | CredentialVaultStore.createBackup (exp, async) | Writes a self-contained backup package (envelope plus its key) for the current state. | R |
| 199 | method | CredentialVaultStore.listBackups (exp, async) | Lists valid backup files, newest first, skipping anything that fails validation. | R |
| 219 | method | CredentialVaultStore.restoreBackup (exp, async) | Replaces key and envelope from a named backup, auto-backing up the live pair and journaling the swap. | R |
| 302 | method | CredentialVaultStore.readData (exp, async) | Reads and decrypts the vault under the file lock, refusing while a restore is pending. | R |
| 311 | method | CredentialVaultStore.mutate (exp, async) | Read-modify-write under the mutation lock: decrypt, apply the change, validate, re-encrypt, atomically replace. | R |
| 323 | method | CredentialVaultStore.readEnvelope (exp, async) | Decrypts the current envelope with the given key. | R |
| 327 | method | CredentialVaultStore.readRawEnvelope (exp, async) | Reads and validates the encrypted envelope, including its namespace. | R |
| 337 | method | CredentialVaultStore.readKey (exp, async) | Reads the 32-byte key file, failing closed when its length is wrong. | R |
| 343 | method | CredentialVaultStore.requireKey (exp) | Returns the in-memory key or throws VAULT_LOCKED. | R |
| 348 | method | CredentialVaultStore.readRestoreJournal (exp, async) | Reads, shape-validates and path-validates the restore journal, returning null when it is unusable. | R |
| 354 | const-function | safeName | ~ safe name | N |
| 364 | method | CredentialVaultStore.restorePaths (exp) | Maps a validated journal's file names to absolute paths inside the namespace directory. | R |
| 373 | method | CredentialVaultStore.commitRestore (exp, async) | Completes a staged restore: move the previous pair aside, move the staged pair in, fsync, verify, clean up. | R |
| 392 | method | CredentialVaultStore.rollbackRestore (exp, async) | Undoes a staged restore: put the previous pair back and delete staged files and the journal. | R |
| 411 | method | CredentialVaultStore.exists (exp, async) | Whether a path exists, refusing symlinks. | R |
| 422 | method | CredentialVaultStore.ensureDirectories (exp, async) | Creates the state, vault, namespace and backup directories with 0700, then verifies each one's owner and mode. | R |
| 445 | method | CredentialVaultStore.readSafeFile (exp, async) | Reads a vault file with size, owner, mode and symlink checks both before and after opening it. | R |
| 466 | method | CredentialVaultStore.writeExclusive (exp, async) | Creates a file exclusively with mode 0600 and fsyncs it. | R |
| 479 | method | CredentialVaultStore.atomicWrite (exp, async) | Writes via a 0600 temp file and rename, fsyncing the directory, and never leaves a half-written target. | R |
| 512 | method | CredentialVaultStore.syncDirectory (exp, async) | fsyncs a directory so a completed rename survives a crash. | R |
| 522 | method | CredentialVaultStore.withMutationLock (exp, async) | Serialises mutations in-process, then takes the cross-process file lock. | R |
| 535 | method | CredentialVaultStore.withFileLock (exp, async) | Takes the on-disk lock file, waiting until the timeout and clearing only provably dead locks. | R |
| 567 | method | CredentialVaultStore.removeStaleLock (exp, async) | Deletes the lock file when its owning pid no longer exists and it is older than the grace period. | R |

## mcp-server/src/vault/types.ts

126 lines · 3 symbols · 3 exported · fan-in 10 · fan-out 0

| line | kind | symbol | purpose | ev |
|---:|---|---|---|---|
| 11 | function | canonicalizeOrigin (exp) | ~ canonicalize origin | N |
| 117 | function | metadataOf (exp) | `const { password: _password, ...metadata } = entry;` | B |
| 123 | function | randomId (exp) | Opaque identifiers keep the shape their schemas above require: `<prefix>_<32 hex>`. | D |
