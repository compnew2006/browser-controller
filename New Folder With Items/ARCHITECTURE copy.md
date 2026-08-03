# Architecture

Browser Controller v2.1 — MCP server + Chrome extension that lets AI agents
drive the user's real browser (real sessions, logins, cookies).

## Process model

```
Agent (stdio MCP) ─► thin client (index.ts) ─IPC socket─► daemon (daemon.ts)
                                                            │ owns WS :7225 + HTTP
                                                            ▼
                                                    Chrome extension (background.js)
                                                            │ chrome.scripting / debugger
                                                            ▼
                                                    real browser tabs
```

- **Thin client** (`index.ts`): speaks MCP over stdio, forwards every tool call
  to the daemon over a local IPC socket. Many can run at once; all share one
  daemon. Derives the agent name (`--agent` flag > env > parent process).
- **Daemon** (`daemon.ts`): a PURE multiplexer. Owns the WS server + HTTP
  endpoints (`/pair`, `/status`, `/kill`). Tags each call with a `sessionId`,
  forwards `{id, tool, params, sessionId}` to the extension. Does NOT speak MCP,
  does NOT know tool semantics. Heartbeat evicts dead IPC clients (~45s);
  dedup-by-name prevents zombie accumulation on IDE restart.
- **Bridge** (`bridge.ts`): the daemon's WS client to the extension. Owns
  retry/timeout/idempotency policy, AbortSignal-based call cancellation, and the
  stale-port eviction on startup.
- **Extension** (`background.js`): MV3 service worker. Routes tool calls to
  handlers via `dispatch()`, enforces per-tab mutex + per-agent tab locks, builds
  snapshots, runs smart-selector fallback. Buffers are in-memory (lost on SW
  recycle — documented, by design).

## Key invariants (do not break)

1. **Single source of truth for tool metadata.** Each `ToolDefinition` carries
   `name`, `idempotent`, `timeoutMs`. `IDEMPOTENT_TOOLS`/`TOOL_TIMEOUTS` are
   DERIVED from these (see `tools/index.ts`). A tool's `callTool()` arg MUST
   equal its `.name` (enforced by a static drift-guard test).
2. **sessionId is a first-class WS field**, never injected into `params`. The
   daemon stays a pure `{tool, params}` forwarder.
3. **Non-idempotent tools never retry.** Click/type/navigate/evaluate/tabs are
   not in the idempotent set; the bridge rejects on timeout instead of resending.
4. **Eviction cancels in-flight calls — end to end.** Each `routeCall` gets an
   `AbortController`; the daemon's close handler aborts it so a non-idempotent
   action can't keep running after the agent is gone. **The abort is also
   forwarded to the extension** via a `cancel` control message
   (`bridge.sendControl('cancel', { id })` on abort + timeout), and
   `background.js` aborts the matching `activeControllers` entry so the
   handler releases the per-tab mutex immediately — without this, a slow
   navigate (e.g. a hung host) kept the tab locked for its full budget and
   every later call on that tab queued behind it. Handlers opt in by accepting
   a `signal` (`handleNavigate` races its wait; `handleRunAction` drops a
   post-abort result).
5. **Pure modules are injected, not duplicated.** `smart-selector.js`,
   `tab-concurrency.js`, `snapshot-tree.js`, `navigation.js` are framework-free;
   their page-world functions are stringified + `eval`'d across the
   `chrome.scripting` boundary (which can't serialize functions).

## Extension points

- **New tool:** add a file in `mcp-server/src/tools/`, export a
  `ToolDefinition` (set `idempotent`/`timeoutMs`), register in `index.ts`,
  add a handler in `background.js` `dispatch()`. The drift-guard test will catch
  a name mismatch.
- **New transport policy:** annotate the tool (`idempotent`/`timeoutMs`) rather
  than editing a parallel string table.
- **New fallback layer:** add to `smart-selector.js`; `handleClick`/`handleType`
  consume the resolver chain.
- **New cancellation-aware handler:** accept the `signal` arg threaded by
  `dispatch()`; race any wait against it and drop results computed after abort.
  Register the call in `activeControllers` (done centrally in `handleMessage`)
  and the `cancel` control message will abort it on daemon/timeout — no handler
  code needed beyond respecting `signal`.

## Where state lives

| State | Location | Survives SW restart? |
|---|---|---|
| token | `~/.browser-controller/token.json` | yes (disk) |
| wsPort/wsToken | `chrome.storage.local` | yes |
| console/network buffers | service-worker memory | **no** (by design) |
| tab locks / mutex / fallbacks / fingerprints | service-worker memory | **no** (recover on next snapshot) |

## Testing

151 tests across 8 files. Pure modules (`smart-selector`, `tab-concurrency`,
`navigation`) are unit-tested without a browser. `bridge.test.ts` proves WS
auth + retry + abort-cancellation **+ cancel-control forwarding** (on both
timeout and abort). `daemon.test.ts` runs the real daemon in a subprocess with
an isolated `BC_STATE_DIR` and proves heartbeat eviction, dedup, `/kill`.
