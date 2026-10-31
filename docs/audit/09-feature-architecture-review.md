# 09 — Feature-by-feature architecture review (2026-10-27)

Written as analysis only. Fixes are tracked in section 9 and in each finding's status.

- **Baseline:** branch `codex/002-daemon-authentication`, HEAD `c1f2141`, plus the uncommitted 002 work (24 modified, 8 untracked files). Findings on uncommitted code are marked **WIP**.
- **Lenses:** the architecture-guardian workflow (blast radius, layering, coupling, immutable cores, strangler migration), the codebase-memory-mcp index, the graphify graph, and `constitution.md` v4.1.0.
- **Constitution status:** v4.1.0 is *proposed*. It binds only after gates A–D pass. Every constitution item below is therefore a **gap against the proposed constitution**, not a violation.

---

## 1. Method and evidence

| Item | Value |
|---|---|
| codebase-memory index | project `Users-noiemany-.zcode-workspace-default-real-browser-mcp`, status `ready`, watched (git), 5231 nodes / 16029 edges, indexed 2026-10-26T23:08Z |
| graphify graph | `graphify update .` run once by the orchestrator before delegation: 2858 nodes, 6167 edges, 223 communities, includes the WIP tree. `graphify-out/` is gitignored. |
| Baseline checks (orchestrator, this tree) | `npm run typecheck` exit 0 · `npm run lint` exit 0 · `npm test` 94 files / 1171 tests passed |
| Analysts | 9 read-only agents (Haiku), one per feature slice F1–F9. Agents made no edits and did not refresh any index. |
| Orchestrator verification | Every P1 and most P2 claims were re-read against source. Column **Chk** in section 4: `✔` = re-read and holds, `±` = holds but narrower than the agent claimed, `✘` = contradicted, `—` = agent evidence only. |

**Record types and statuses** follow constitution Art 5 and Art 12. `OBSERVED` means the behaviour is visible in source. `HYPOTHESIS` means it is inferred and not reproduced. No finding is `VERIFIED`: no test was written or run per finding.

**Severity rubric:** P0 = exploitable now or data loss now. P1 = a security-relevant gap or a defect reachable in normal use. P2 = a defect that needs rare conditions, or a design or contract gap. P3 = hygiene, documentation, or a design note.

### Process deviations (reported, not hidden)

1. Nine agents ran in parallel. The Owner's later instruction caps parallel agents at 3; the agents had already been launched when that instruction arrived.
2. Agent compliance was partial. F4 did not read `constitution.md` or the architecture-guardian skill. F2 read only Art 16 and Art 21. Their tier proposals were re-derived by the orchestrator from Art 2.
3. Graph caveats. codebase-memory `trace_path` and `search_graph` disagree on the callers of `ExtensionBridge.callTool`. `graphify affected` cannot resolve duplicated names (`PAGE_DOM_INSTALL`, `CredentialVaultStore`) without `path::symbol`. Per Art 10, static analysis did not prove any *absence*; absence claims rest on literal greps.

---

## 2. Feature map

| ID | Feature | Main files | Proposed tier (Art 2) | Spec / contract | Refactor now? |
|---|---|---|---|---|---|
| F1 | Daemon and MCP client lifecycle | `index.ts`, `daemon.ts`, `daemon-config.ts`, `daemon-reconnect.ts`, `scripts/daemon.mjs`, `deploy/` | CRITICAL (IPC token, session table, vault routing) | none | NO |
| F2 | Daemon auth and pairing (002, WIP) | `bridge-auth.ts`, `bridge-http.ts`, `bridge-security.ts`, `native-host.ts`, `extension/lib/daemon-auth.js`, `popup.js` | CRITICAL | `specs/002-*` with prose contracts; tasks unchecked; no `verification.md` | NO |
| F3 | Bridge, wire protocol, multi-browser | `bridge.ts`, `bridge-connections.ts`, `bridge-frames.ts`, `protocol.ts`, `extension/lib/connection.js`, `protocol.js` | CRITICAL | none for the wire protocol | Pending-call extraction only (KNOWN ADR-04) |
| F4 | Tab ownership and Tab Control-Lock | `extension/lib/state.js`, `tab-concurrency.js`, `lock-ops.js`, `handlers/tabs.js`, `dispatch/router.js` | CRITICAL (exclusivity between agents) | `specs/tab-control-lock/` — stale | NO |
| F5 | Credential vault | `mcp-server/src/vault/*` (16 files), `extension/vault/*`, `vault-actions.js` | CRITICAL (secrets) | `specs/001-*` complete (22/22 tasks); contract is prose | NO (freeze service chain, KNOWN ticket) |
| F6 | Tool layer and extension dispatch | `tools/*.ts`, `register-tools.ts`, `batch.ts`, `action-support.ts`, `dispatch/router.js` | CRITICAL | zod schemas = machine-readable contract for 18/19 tools | NO |
| F7 | Page interaction and trusted input | `trusted-input.js`, `handlers/interaction*.js`, `action-safety.js`, `tools/fill.ts`, `tools/safety.ts` | CRITICAL (input + safety policy) | none | NO (strangler split of `trusted-input.js` when touched) |
| F8 | Inspection, navigation, wait | `page-dom.js`, `inspection.js`, `screenshot.js`, `navigation.js`, `page-exec.js` | CONTROLLED; CRITICAL for ref issuance and page-data handling | `specs/webmcp-support/` — stale (feature removed) | NO (bundle decision parked, KNOWN ticket) |
| F9 | DevTools surface (CDP) | `cdp-session.js`, `network-capture.js`, `response-bodies.js`, `handlers/logs.js`, `mock.js`, `evaluate.js` | CRITICAL for redaction/evaluate; CONTROLLED otherwise | none | NO |

**Architecture-guardian verdict:** the repository already has a coherent structure (thin TS tool layer → daemon → bridge → extension dispatch → handlers → lib). Forcing a `core/application/infrastructure/features` re-layout would add churn without improving outcomes, so none is recommended. Business logic does not leak into infrastructure in any serious way; the coupling that exists is one-way and goes through interfaces (`VaultTransport`, `FillWorkflow`, `useToolRegistry`).

### Immutable cores (treat as high-blast-radius; change only by strangler migration)

| Symbol | Where | Evidence of fan-in |
|---|---|---|
| `daemon-config.ts` exports | `mcp-server/src/daemon-config.ts` | imported by `daemon.ts`, `index.ts`, `bridge.ts`, `native-host.ts`, ~8 tests |
| `handleMessage` | `extension/dispatch/router.js` | out-degree 32; every wire tool, mutex, lock, cancel |
| `send` / `locateTarget` | `extension/lib/trusted-input.js` | `send` fan-in 27; `locateTarget` used by F7, `screenshot.js`, `inspection.js` |
| `withCdp` / `ensureCdp` | `extension/lib/cdp-session.js` | ~12 callers across F7, F8, F9; sole owner of `chrome.debugger` |
| `PAGE_DOM_INSTALL` | `extension/lib/page-dom.js:25` | degree 52; every ref-based call |
| `ToolDefinition` | `mcp-server/src/tools/types.ts` | in-degree 26 |
| `persistSessionState` / lock maps | `extension/lib/state.js` | in 9 / out 8; mutable global imported by ~8 modules |
| `ExtensionBridge.sendToolCall` | `mcp-server/src/bridge.ts` | the single route for all tool traffic |

---

## 3. Cross-cutting themes

1. **Lock and lease correctness repeats in three places.** The daemon lock (F1-1), the vault store lock (F5-1, F5-2) and the tab-lock restore (F4-3) each have a reclaim or restore edge that is not atomic or that fails open. The daemon and vault locks share one pattern: check the owner, then unlink, without re-checking the file that was judged stale. A second daemon process (F1-1) is also the main way two writers reach the vault store (F5-1).
2. **Specs drift from code, and nothing flags it.** `specs/tab-control-lock/spec.md` describes a lock-lifetime shield and `browser_tabs lock/unlock`; the code moved to a per-call shield in commit `e4c6baf` and the tool has no lock actions (F4-1). The same spec puts lock persistence out of scope, while `state.js` persists locks (F4-7). `specs/webmcp-support/` reports a removed feature as implemented (F8-4). `specs/002-*/tasks.md` has 0 of 20 boxes ticked (F2-7). Under Art 5 these are `NON_CONFORMITY` records that need a decision: amend the spec, or write an ADR.
3. **TS/JS twins without full parity tests.** The protocol constants (F3-1), the helloAck builders (F3-2), the auth transcripts (F2-4) and the secret-key redaction lists (F9-2) are hand-duplicated across the two runtimes. The audit already explains why there is no shared build (05 §1 constraint 3). Parity tests exist for protocol constants and tool names; the auth transcripts are exercised end-to-end across runtimes (see F2-4).
4. **Security policy is under-tested.** The action-safety gate has no behavioural test (F7-2). The daemon-side pre-auth WebSocket gate was only partly tested (F2-3, now resolved). Lock reclaim has no concurrency test (F5-7).
5. **The Art 6 structure is absent repository-wide.** There is no `specs/features/`, `specs/contracts/` or `specs/evidence/`, no versioned spec headers (`version`, `mode`, `risk_tier`), and no claim IDs (Art 12). Eight of nine features would be CRITICAL or partly CRITICAL under Art 2, so gate B of the constitution cannot pass without this scaffolding.

---

## 4. Findings, prioritised

### P1

| ID | Chk | KNOWN/NEW | Status | Finding | Evidence | Smallest credible fix |
|---|---|---|---|---|---|---|
| F7-2 | ✔ | NEW | **Resolved 2026-10-27** (`f99d69b`) | The action-safety gate (`enforceActionSafety`, `ACTION_BLOCKED`, `browser_classify_action`, `action-safety.js`) had no behavioural test. 36 tests now cover allow / block / ask per category (submit, delete, upload, unknown), site rules, elicitation outcomes, and classifier failure, which is fail-closed (`SAFETY_CHECK_FAILED`, nothing dispatched). The gate has no timeout of its own; a hung classifier is bounded by the bridge call timeout. | `tests/action-safety-gate.test.ts` | Done. |
| F7-1 | ✔ | NEW | **Resolved 2026-10-27** (`f99d69b`) | `browser_evaluate` bypassed the session safety policy. Owner decision 2026-10-27: gate it. With safety mode on, evaluate follows the site's effective action (site rule, else default): block refuses, ask elicits, allow runs. Follow-up: the extension classifier has no `browser_evaluate` action, so the server asks it for the site with `action: 'browser_click'` and no target (no element is probed). | `mcp-server/src/tools/evaluate.ts`; `action-support.ts` `classify`; `tests/action-safety-gate.test.ts` | Done; follow-up in phase 2 (`extension/handlers/action-safety.js` `ACTIONS`). |

### P2

| ID | Chk | KNOWN/NEW | Status | Finding | Evidence | Smallest credible fix |
|---|---|---|---|---|---|---|
| F4-3 | ✔ | NEW (principle KNOWN 05 §1) | **Resolved 2026-10-27** (`f0bc5a1`) | Tab-lock restore failed **open**. A failed `chrome.storage.session` read is now retried with backoff (100 ms to 2.7 s, then every 15 s); persisting stays deferred, and the router answers tool calls with `STATE_UNAVAILABLE` until a read succeeds. Failed writes are logged. | `extension/lib/state.js` `loadSessionState`; `extension/dispatch/router.js`; `tests/extension-state-load-failure.test.ts` | Done. |
| F4-1 | ✔ | NEW | **Resolved 2026-10-27** (`76e618d`) | The spec's LOCKED decision 1 ties the shield to the lock lifetime and to `browser_tabs {action:"lock"/"unlock"}`. The code draws the shield per call, and the tool enum is `list/close/focus`. The change was deliberate (commit `e4c6baf`, "per-call shield"), but the spec was not amended. Recorded as ADR-07 in `10-decision-records.md`; the spec carries a superseded header. | `specs/tab-control-lock/spec.md:35`; `extension/lib/lock-ops.js:5-6`; `extension/dispatch/router.js:384-386, 403-405`; `mcp-server/src/tools/tabs.ts` | Write an ADR recording the per-call decision and mark the spec superseded. No code change. |
| F4-2 | ✔ path | NEW | **Resolved 2026-10-27** (`f0bc5a1`) | Orphan tab locks when a `releaseSession` frame was lost while the extension was disconnected. On every ready connection the daemon now sends that connection the live session ids (`sessionRoster`), and the extension releases locks and settings of every other session. An older extension ignores the frame. | `mcp-server/src/bridge.ts` `setSessionRoster`; `daemon.ts`; `router.js`; `tests/bridge-session-roster.test.ts`, `tests/extension-session-roster.test.ts` | Done. |
| F1-1 | ✔ | NEW | **Resolved 2026-10-27** (`15b5c6e`) | Daemon lock takeover was check-then-unlink, so two starters could both take a stale lock. `reclaimLock` now renames the lock to a tombstone and keeps it only if it is still the file judged stale (device, inode and mtime, since a freed inode can be reused at once); otherwise it restores it. `createIpcServer` unlinks the socket only after the lock is held. | `mcp-server/src/lock-file.ts`; `daemon-config.ts` `acquireDaemonLock`; `tests/daemon-lock.test.ts` | Done. |
| F1-3 | ✔ | NEW | **Resolved 2026-10-27** (`15b5c6e`) | The systemd unit restarted forever when a second daemon lost the lock (`main` exits 0 on `DaemonLockHeldError` by design). Now `Restart=on-failure`. `deploy/` has no other supervisor file. | `deploy/systemd/browser-controller-daemon.service`; `tests/managed-daemon-mode.test.ts` | Done. |
| F5-2 | ✔ | NEW | **Resolved 2026-10-27** (`15b5c6e`) | A crash between `O_EXCL` create and the pid write left an empty vault lock and `VAULT_BUSY` forever. An empty or unparseable lock past the grace period is now stale. | `mcp-server/src/vault/store.ts` `removeStaleLock`; `tests/vault-store.test.ts` | Done. |
| F5-1 | ✔ | NEW | **Resolved 2026-10-27** (`15b5c6e`) | Vault stale-lock reclaim unlinked without re-checking the file. It now uses the same `reclaimLock` as the daemon. | `mcp-server/src/vault/store.ts`; `tests/vault-store.test.ts` "two reclaimers on one stale lock" | Done. |
| F5-7 | — | NEW | **Resolved 2026-10-27** (`15b5c6e`) | Lock tests now cover dead-pid reclaim, a live pid, an empty lock inside and after the grace period, concurrent reclaim, and inode reuse, for both locks. pid reuse after a crash (F1-5) is still not covered. | `tests/daemon-lock.test.ts`; `tests/vault-store.test.ts` | Done. |
| F2-2 | ✔ | NEW | **Resolved 2026-10-27** | `/auth/challenge` needs no secret and has no per-source limit. Filling 1024 challenges within the 30 s TTL returned 503 to pairing, `/status` and reconnect. Browser control was not bypassed. A full store now evicts its oldest challenge instead of refusing, so a flood must win a race against each live request instead of locking every caller out. All callers share 127.0.0.1, so a per-source limit would not separate them. | `mcp-server/src/bridge-auth.ts` `issueChallenge`; `tests/bridge-auth.test.ts` "keeps a hard capacity by evicting the oldest outstanding challenge" | Done. **WIP** |
| F2-8 | ✔ | NEW | **Resolved 2026-10-27** | The WebSocket client proof was bound only to the client-chosen nonce and the per-process instance id. A local process that captured one `helloAck` could replay it, with the same nonce in its own `authInit`, and become the browser until the daemon restarted (FR-002; the contract's "replayed proofs fail closed"). The daemon now picks a `serverNonce` per socket, sends it in the hello, and verifies the client proof against it. The contract was amended to match. | `mcp-server/src/bridge.ts` connection handler; `mcp-server/src/bridge-auth.ts` WS transcripts; `extension/lib/daemon-auth.js`; `specs/002-daemon-authentication/contracts/websocket-auth.md` steps 2 and 4; `tests/protocol-handshake.test.ts` "refuses a helloAck replayed on a new connection" | Done; protocol change, needs Owner review. **WIP** |
| F2-1 | — | NEW | **Resolved 2026-10-27** (`0a3cb8b`) | The spec names a "rotated secret", but there is no rotate or revoke path. The enrollment secret is the single root of trust. Owner decision: `npm run pairing:rotate` replaces the secret and the token (0600, never printed); the user restarts the daemon and the extension re-pairs through the native host. ADR-10. | `specs/002-daemon-authentication/spec.md:53`; `daemon-config.ts:227` | Add `pairing.mjs rotate`, or amend the spec and record the accepted risk. |
| F2-3 | ✔ | NEW | **Resolved 2026-10-27** | The daemon-side pre-auth gate had only the invalid-proof path under test (`tests/protocol-handshake.test.ts` "rejects a browser control frame before the peer proves the extension token"). Two tests now cover a non-`authInit` first frame and a non-`helloAck` frame after the hello. | `mcp-server/src/bridge.ts:232, 245`; `tests/protocol-handshake.test.ts` | Done. **WIP** |
| F2-4 | ✔ | NEW (pattern KNOWN 04 §B) | OBSERVED, **downgraded to P3** | The auth transcripts are hand-duplicated in TS and JS. Correction: cross-runtime parity *is* exercised — `tests/extension-connection-handshake.test.ts` verifies JS proofs with the TS verifier and drives the JS HTTP client against the TS `BridgeHttpAuthenticator`. A shared vector file would only make failures easier to localise. | `bridge-auth.ts:62-119`; `extension/lib/daemon-auth.js:45-107` | **Resolved 2026-10-27** (`55a5517`): golden vectors pin both transcripts and their HMACs (`tests/auth-transcript-vectors.test.ts`). |
| F2-7 | ✔ | NEW | **Resolved 2026-10-27** (`76e618d`) | `tasks.md` has 0 of 20 boxes ticked although much is implemented; `verification.md` is missing; T008/T010/T016 cite non-existent paths. T001–T019 ticked with evidence, the three paths fixed, `verification.md` added. T020 stays open. | `specs/002-daemon-authentication/tasks.md` | Update tasks after the suite passes; add `verification.md`. |
| F3-2 | — | NEW | **Resolved 2026-10-27** (`294735f`) | Two helloAck builders on the extension side: the shared one has no auth fields, so `connection.js` adds them at the call site. `buildExtensionHelloAck` now takes the auth binding; `connection.js` no longer adds fields. Wire shape unchanged. | `extension/lib/protocol.js` `buildExtensionHelloAck`; `extension/lib/connection.js` ~380 | One builder per side that takes the auth input. |
| F3-3 | ✔ | NEW | **Resolved 2026-10-27** (`d9171a6`) | No outbound backpressure: `ws.bufferedAmount` is never checked. A call is refused with `BROWSER_BUSY` above 4 MiB of unsent bytes (`MAX_WS_BUFFERED_BYTES`); never retried. | `grep bufferedAmount` over `mcp-server/src`, `extension/lib`: no hits | Reject with a busy code above a buffer limit; add a test. |
| F6-1 | — | NEW | **Resolved 2026-10-27** (`2bcd5a1`) | When the batch budget cut a write step, the result did not say the outcome was unknown. Non-idempotent steps now report "outcome unknown, the step may have completed: check the page before retrying". | `mcp-server/src/tools/batch.ts`; `tests/tools/batch.test.ts` | Done. |
| F7-3 | — | NEW | **Resolved 2026-10-27** (`f99d69b`) | A blocked `browser_fill` returned a different shape from a blocked click/type (no receipt). Gate refusals raised inside a handler now get the same `not_dispatched` receipt. | `mcp-server/src/tools/action-support.ts` `gateRefusals`; `tests/action-safety-gate.test.ts` | Done. |
| F7-5 | ✔ | NEW | **Resolved 2026-10-27** (`a33981d`) | Classify-then-act TOCTOU: the classifier resolves the target (`action-safety.js` `execDom`), then `handleClick` resolves it again through `locatePointer` / `pageLocate` (`trusted-input.js`); on the allow path no fingerprint is compared, so a page can swap the element in between. Now the server sends the final classification's fingerprints as the internal wire field `expectFingerprints`, and the extension compares `D.safetyFingerprint` (ref, tag, input type; one formula shared with the classifier) before any scroll, focus or input, refusing with `SAFETY_TARGET_CHANGED`. Residual (in `SECURITY.md`): the same element changed in place keeps its fingerprint; select, picker and file fields are checked up front only. | `extension/handlers/action-safety.js`; `extension/lib/trusted-input.js` `pageLocate` | Pass `expectFingerprints` through the click/type/fill schemas and wire params; `pageLocate` recomputes them and refuses with `SAFETY_TARGET_CHANGED` before any input. Touches `trusted-input.js`, `router.js` and three tool schemas: own slice (phase 4). |
| F7-7 | ✔ | NEW (phase 4) | **Resolved 2026-10-27** (`a33981d`) | The classifier page function `pageActionCategories` used module-level regexes (`DELETE_INTENT`, `SUBMIT_INTENT`, `ENTER_KEY`). `chrome.scripting.executeScript` serializes the function alone, so in a real page every element classification threw a `ReferenceError`, and with safety mode on click/type/fill on an element target failed closed (`SAFETY_CHECK_FAILED`). Tests ran the function in-process and hid it. The patterns now live inside the function, and the new test harness runs page functions from their source text. Not yet confirmed in real Chrome. | `extension/handlers/action-safety.js`; `extension/lib/page-exec.js` `safeExec`; `tests/extension-dispatch-fingerprint.test.ts` | — |
| F8-3 | ✔ | NEW | **Resolved 2026-10-27** (`76e618d`) | Page-derived text reaches the model without an in-payload "untrusted data" marker; the only guard is the server instruction. Agent rated P1; downgraded because the instruction exists and an envelope is defence in depth. Owner decision: the format is kept and the server instruction is the guard. ADR-09. | `mcp-server/src/index.ts:83`; snapshot/text formatting in `extension/handlers/inspection.js` | Delimit page-derived strings in results; check snapshot consumers before changing the format. |
| F9-2 | ± | NEW | **Resolved 2026-10-27** (`9240503`) | The two body redactors disagreed, and response bodies skipped numbers and booleans under a secret key. One policy (`extension/lib/secret-keys.js`) now serves both, as the union of the old lists, and redacts every scalar under a secret key except numeric counters (`max_tokens`). | `extension/lib/secret-keys.js`; `tests/secret-keys.test.ts`, `tests/response-bodies.test.ts` | Done. |
| R-1 (F5-5 + F9-1) | — | NEW | **Resolved 2026-10-27** (`9240503`), partly | Vault-secret scrubbing was exact substring only. JSON-escaped, URL-encoded and base64 forms of secrets of 8 or more characters are now scrubbed too. Split or chunked forms are still not caught; evaluate is not a secret-safe channel, now stated in `SECURITY.md` (`0a3cb8b`). | `mcp-server/src/vault/redaction.ts`; `tests/vault-redaction-encodings.test.ts` | Done for encodings. |
| F3-1 | ✔ | KNOWN (05 F3/F4, ADR-01) + NEW detail | **Resolved 2026-10-27** (`294735f`) | Parity tests cover protocol constants only, not validators or required-capability lists. NEW: the JS export is named `PROTOCOL_VERSION = 2` while its TS twin is `EXTENSION_PROTOCOL_VERSION`; TS `PROTOCOL_VERSION = 1` is the IPC version. The JS constant is now `EXTENSION_PROTOCOL_VERSION`; a new test runs both validators over the same version and capability inputs. | `extension/lib/protocol.js:1-2`; `mcp-server/src/protocol.ts:9-11` | Rename the JS constant; extend the parity test. |

### P3

| ID | Chk | Finding | Evidence |
|---|---|---|---|
| F1-4 | ± | **Resolved 2026-10-27** (`1d4eb97`): `daemon:stop` unlinks the lock when the info file says the daemon is not live. Narrower than the agent's "unconditional" claim, but a stop during a concurrent start can still delete a fresh lock. `stop` now judges the lock as the daemon does (live pid or EPERM, or unfilled inside the 5 s grace: kept) and reclaims only that exact stale file. | `scripts/daemon.mjs:113-116` |
| F2-9 | ✔ | **Resolved 2026-10-27** (`137740a`): a socket refused before its extension proof verified rejected connection waiters and made later calls fail fast, so any local process could fail agents' calls during a reconnect. Its reason is now only the text of a wait that times out. | `mcp-server/src/bridge.ts` `rejectExtensionHandshake`, `lastRefusal`; `tests/protocol-handshake.test.ts` |
| F3-9 | ✔ | **Resolved 2026-10-27** (`137740a`): frames from a socket already dropped from the registry (replaced sibling) still reached the vault and result handlers. | `bridge.ts` message guard; `tests/bridge-multibrowser.test.ts` |
| F3-10 | ✔ | **Resolved 2026-10-27** (`137740a`): `/pair` and the native pairing host had no timeout, so a request that never settled held `connect()`'s attempt guard. Both are bounded at 5 s. | `extension/lib/connection-transport.js` `withTimeout`; `tests/extension-native-pairing.test.ts` |
| F1-2 | — | **Resolved 2026-10-27** (`510ab81`): No handshake timer before `hello`; an idle local socket is held indefinitely. An IPC socket with no valid hello within `BC_IPC_HELLO_MS` (default 10 s) is destroyed. Unit-tested; the spawned-daemon path needs a rebuilt `dist`. | `mcp-server/src/daemon.ts:196-339` |
| F1-5 | ✔ | **Resolved 2026-10-27** (`55a5517`): Lock ownership is "pid alive", so pid reuse after a crash can look like a held lock. A live pid now holds the lock only inside a 10 s startup grace (`LOCK_STARTUP_GRACE_MS`) or while a daemon answers on the IPC socket (`ipc-probe.ts` `ipcAnswers`). `scripts/daemon.mjs stop` keeps its own copy without the probe (phase 6). | `mcp-server/src/daemon-config.ts:98-109` |
| F1-6 | — | **Resolved 2026-10-27** (`1d4eb97`): `daemonStatus` reports a missing build as "daemon not running". `status` and `stop` now report a missing build with the build hint. | `scripts/daemon.mjs` (diff) |
| F3-4 | ± | Cancel is broadcast to every browser. The comment at `bridge.ts:362` says this is intended, so it is a design note, not a defect. **Accepted as a design note 2026-10-27** (Owner: P3 bugs only). | `mcp-server/src/bridge.ts:359-370` |
| F3-5 | ✔ | **Resolved 2026-10-27** (`d9171a6`): The timeout branch does not remove the `abort` listener (send-failure and settle paths do). Harmless after the fact because `onAbort` checks the pending map; a small leak per timed-out call on a long-lived signal. The timeout branch now removes the listener. | `mcp-server/src/bridge.ts:443-458` vs `:336, :491, :507` |
| F3-7 | — | `connection.js` mixes transport with pairing, badge, popup setters and tab listing. Stays a refactor ticket. | `extension/lib/connection.js` |
| F4-4 | — | **Resolved 2026-10-27** (`76e618d`): No lock TTL or liveness check: an idle but alive session holds a tab indefinitely. Decision needed, not code. Owner decision: no TTL; a lock lives until its session ends. ADR-08. | `extension/lib/tab-concurrency.js` |
| F4-6 | — | **Resolved 2026-10-27** (`76e618d`): The daemon enforces no tab ownership; the extension is the sole authority. Record it as an explicit decision. Owner decision: the extension is the sole authority. ADR-08. | literal grep `TAB_LOCKED` in `mcp-server/src` |
| F4-7 | ✔ | **Resolved 2026-10-27** (`76e618d`): The tab-lock spec says lock persistence is out of scope; `state.js` persists locks. Spec line refs point at the pre-split `background.js`. Recorded as ADR-07; the spec carries a superseded header. | `specs/tab-control-lock/spec.md:73`; `extension/lib/state.js:11-15` |
| F5-3 | ✔ | **Resolved 2026-10-27** (`7df0570`), partly: Backups embed the key and keep deleted credentials; nothing purges them. Only the newest three backups are kept (`VAULT_BACKUP_RETENTION`, Owner decision); a deleted credential still lives in up to three backups. | `mcp-server/src/vault/store.ts:189, 202-210` |
| F5-4 | — | KNOWN (`specs/001-*/plan.md:72`): plaintext `.key` next to the ciphertext, no KDF. Documented choice. **Accepted as a design note 2026-10-27.** | `store-format.ts:28-58` |
| F5-6 | — | Every get/list/fill decrypts the whole vault into JS strings. Stays a refactor ticket. | `store.ts:144-147` |
| F5-8 | — | KNOWN (`07-wayfinder/ticket-vault-composition-pay-or-freeze.md`): the service split is an inheritance chain, i.e. a size split. Stays a refactor ticket. | `vault/service-*.ts` |
| F6-2 | — | `browser_batch` step params are `z.record(z.unknown())`; per-step schemas are not advertised. A real token trade-off. | `mcp-server/src/tools/batch.ts:87-95` |
| F6-3 | ✔ | **Resolved 2026-10-27** (`55a5517`): `routeCall` forwards any tool name and params ("pure multiplexer"); schema validation exists only in the MCP process. Defence in depth for authenticated IPC clients. A name outside the registry and the internal wire actions (`wire-tools.ts` `isKnownWireTool`) now gets `UNKNOWN_TOOL`. Params are still validated only in the MCP process. | `mcp-server/src/daemon.ts` ~380-425 |
| F6-5 | ✔ | **Resolved 2026-10-27** (`f0bc5a1`): intended. `browser_classify_action` must stay reachable through `dispatch` because the server's safety gate calls it; a comment and a test now pin that it is internal and changes nothing. | `extension/dispatch/router.js` |
| F6-6 | — | **Resolved 2026-10-27** (`7df0570`): `browser_batch.timeoutMs` is inert for transport (batch never reaches the bridge). Documented in `types.ts` as batch's own budget; no behaviour change. | `batch.ts:98` |
| F6-8 | — | Uncoded throws become `INTERNAL_ERROR`; count of affected handlers not measured. **Measured 2026-10-27:** 23 uncoded literal throws in `extension/` (16 in `vault-actions.js`, 2 in `page-exec.js`, one each in `router.js:80`, `keys.js:60`, `emulation.js:70`, `action-safety.js:104`, `navigation.js:42`), plus the two fallbacks in `action-support.ts` (lines 84, 203). Stays a ticket. | `types.ts:132-135` |
| F7-4 | — | KNOWN (05, 04): `trusted-input.js` mixes CDP plumbing with injected locate policy. Stays a refactor ticket. | `extension/lib/trusted-input.js` |
| F7-6 | — | `screenshot.js` and `inspection.js` import input internals from `trusted-input.js`; scroll input lives outside F7. Stays a refactor ticket. | `screenshot.js:18, 315`; `inspection.js:8, 175` |
| F8-1 | — | KNOWN (05 §1, 04, 06): `PAGE_DOM_INSTALL` is tested through fake-dom only. Stays a ticket; phase 4 added source-text tests of page functions, and real-Chrome checks now cover F7-5 and F7-7. | `extension/lib/page-dom.js:25` |
| F8-4 | ✔ | **Resolved 2026-10-27** (`76e618d`): `specs/webmcp-support/` says "implemented"; the feature was removed in 3.0 (no `webmcp` in `extension/` or `mcp-server/src`). Each file in `specs/webmcp-support/` carries a superseded header. | `specs/webmcp-support/implementation_report.md:57` |
| F8-5 | ✔ | **Resolved 2026-10-27** (`af63187`): `browser_wait` hard max 50 s vs tool timeout 55 s; the poll loop was not fully read. Each poll and sleep is now raced against the deadline and the abort signal (`extension/lib/wait-page.js`), so a frozen page ends with the wait's own `TIMEOUT`. | `extension/handlers/inspection.js` |
| F8-7 | ✔ | NEW (2026-10-31): `browser_wait {until:'stable'}` ended the wait at the **first** failed page read. `pageFingerprint` returns `undefined` for every failure, so one transient one (the debugger detached — the extension says "the next call reattaches on its own") ended the wait after a single read and reported "the page was still changing" for a page that had already settled. A failure that cannot clear (the tab is gone) now ends the wait at once; a transient one is retried inside the same wait, up to three consecutive failures. Distinct from F8-5: that fix bounded the poll loop in the extension's `wait-page.js` (the selector/url wait); this path is the server-side `page-stability.ts`, added 4 days later in `67dde6b` and never audited. | `mcp-server/src/tools/page-stability.ts` `readFingerprint`/`waitUntilStable`; `tests/tools/wait-stable.test.ts` |
| F8-8 | ✔ | NEW (2026-10-31): `tools/list` was 21,033 chars, over its 20,000-char budget by 1,033. It stood at 19,963 before `67dde6b` (a 37-char margin), and that commit added 1,070: `browser_batch`'s rewritten description (478 chars, now the longest after `browser_click`) and `browser_wait`'s `until:"stable"` variant. Not caused by the F8-7 fix. The budget is a hard contract (`tests/v3-server.test.ts`), so it failed CI as it stood. **Resolved 2026-10-31** (Owner decision: trim, not raise): 21,033 → 19,875. The 890-char bulk is text the schema already repeated ten times — the locator's per-field `nth` description (published once per element tool) and a verbose union sentence that now says the same in 82 chars instead of 108. The other 268 came from `browser_batch`, `browser_logs`, `browser_tabs`, `browser_navigate`, `browser_click`, `browser_wait` and `browser_fill`, mostly enumerations their own parameter descriptions already carry. No parameter, bound, default or behaviour changed. | `mcp-server/src/tools/types.ts` `targetParam`; `tests/v3-server.test.ts:50` |
| F8-6 | — | Screenshot budget is bounded and tested (positive check). **Accepted 2026-10-27.** | `extension/handlers/screenshot.js:28-34, 98-111` |
| F9-4 | ✘ / ± | **Contradicted:** the agent said body capture is not released when a session ends. It is: `clearTabSetting` handles `'bodies'` via `releaseBodyCapture`. What remains: no TTL while the session is alive. The duplicated pin name is **Resolved 2026-10-27** (`9240503`): `logs.js` uses `BODY_CAPTURE_PIN` from `state.js`. | `extension/dispatch/router.js:131-136`; `extension/lib/state.js:41`; `extension/handlers/logs.js` |
| F9-5 | — | A mock with rules pins the debugger; `Fetch.enable` `*` pauses every request. Documented. **Accepted as a design note 2026-10-27.** | `extension/handlers/mock.js` |
| F9-6 | ✔ | **Resolved 2026-10-27** (`af63187`): The evaluate size cap runs after full page-side `JSON.stringify`. The page-side serializer now takes the cap and returns only the head and the full length above it (`cdp-evaluate.js` `serializeThis`). | `extension/lib/cdp-evaluate.js` |
| F9-7 | — | KNOWN (04, 06): race helpers duplicated in `cdp-session.js`. Stays a refactor ticket. | `extension/lib/cdp-session.js` |

### Positive checks worth keeping on record

- F2 auth core: challenges are consumed before verification, have a TTL, use a timing-safe compare, fail closed without a secret, and pin the origin by exact match (`bridge-auth.ts:59, 273-274`; `bridge-security.ts:40, 50`). **WIP**
- F5: AES-256-GCM with a random 96-bit nonce and AAD; grants are re-checked after every await in `FillWorkflow` (`vault/fill.ts:61-133`).
- F7: one resolver for `REF_GONE` / `AMBIGUOUS` (`page-dom.js:448-487`) with shared wording (`ref-errors.js`).
- F9: `chrome.debugger.*` is called only from `cdp-session.js`; tab-close cleanup drops network, body and mock state.

---

## 5. Corrections to existing audit documents

| Document | Correction | Source |
|---|---|---|
| `04-duplication-register.md:183`, `05-architecture-analysis.md:285` | *Corrected 2026-10-27 from source.* `inspection.js` and `inspect-element.js` call `D.isVisible` / `D.nameOf` rather than copying them. The `collect`/`visible` pair is not between the two page installers: it is copied in `extension/lib/vault-actions.js` (`inspectPasswordField`, `fillInspectedPassword`), so 04's A6 row stands with the new file name. `PAGE_FALLBACK_INSTALL` only overlaps `isVisible` through an inline check in `computeNth`. Applied in `76e618d`. | F8-2 |
| `07-wayfinder/ticket-tool-vocabulary-assertion.md` | Parity is now asserted by `tests/extension-router.test.ts:362-378` and `tests/vault-redaction.test.ts:11`; the ticket still describes a gap. Applied in `76e618d`. | F6-4 |
| `specs/tab-control-lock/spec.md` | Superseded by the per-call shield (`e4c6baf`) and by lock persistence in `state.js`. Applied in `76e618d` (ADR-07). | F4-1, F4-7 |
| `specs/webmcp-support/` | Feature removed in 3.0; mark superseded. Applied in `76e618d`. | F8-4 |

---

## 6. Constitution fit (proposed v4.1.0)

| Article | Repository state | Gap |
|---|---|---|
| Art 2 (tiers) | No feature declares a tier. | 8 of 9 features are CRITICAL or partly CRITICAL (section 2). The Owner must confirm CRITICAL. |
| Art 5 (record types) | Stale specs are not recorded as `NON_CONFORMITY`. | F4-1, F4-7, F8-4, F2-7. |
| Art 6 (spec/contract/evidence) | Specs exist for 001, 002, tab-control-lock, webmcp. Contracts are prose (`contracts/*.md`); the zod schemas are the only machine-readable contract. | No `specs/features/`, `specs/contracts/`, `specs/evidence/`; no `version` / `risk_tier` headers; no contract hash. |
| Art 10 (static analysis) | Respected in this review: absence claims are backed by greps. | — |
| Art 11 (one graph tool per repo) | The repo uses both graphify and codebase-memory, and `AGENTS.md` names both. | Recorded as an exception: ADR-11 in `10-decision-records.md` (`76e618d`). |
| Art 12 (claims) | No claim IDs or evidence manifests. | This report uses feature-scoped IDs as an interim. |
| Art 16 / Annex B (tests) | Full regression baseline passes (1171 tests). | Missing: safety gate (F7-2), lock reclaim and concurrency (F1-1, F5-7), failure/recovery for tab-lock restore (F4-3), adversarial redaction (R-1, F9-2). CRITICAL needs failure-and-recovery tests. |
| Art 21 (security) | Secrets are written 0600 in 0700 dirs; no secret value was printed by any agent. | Secret rotation (F2-1), redaction drift (F9-2, R-1), evaluate outside policy (F7-1). |

---

## 7. Recommended order (not implemented)

1. **Owner decisions, recorded as ADRs:** evaluate vs safety policy (F7-1); per-call shield and lock persistence, then mark the tab-lock spec superseded (F4-1, F4-7); lock lifetime and the extension-as-authority model (F4-4, F4-6); secret rotation (F2-1); one graph tool vs both (Art 11). *Done 2026-10-27: ADR-06 to ADR-11 in `10-decision-records.md` (`76e618d`).*
2. **Cheap, high-value tests first:** the safety gate (F7-2), vault lock reclaim and empty-lock cases (F5-7).
3. **Correctness fixes, each small and local:** one compare-before-unlink lock helper used by the daemon and the vault (F1-1, F5-1, F5-2); fail-closed tab-lock restore (F4-3); `Restart=on-failure` (F1-3); the batch outcome-unknown message (F6-1); a receipt for a blocked fill (F7-3); one shared secret-key redaction policy (F9-2).
4. **Documentation hygiene:** the corrections in section 5, plus ticking `specs/002-*/tasks.md` and adding its `verification.md` once the suite passes.

---

## 8. Limits and cost

- Not verified by running anything: every race (F1-1, F5-1), MV3 suspension behaviour (F3-8), real-Chrome page-dom behaviour, webRequest fragment exposure (F9-3), and the full `browser_wait` loop (F8-5).
- No Serena reference checks were made; caller claims rest on codebase-memory, graphify and grep.
- The architecture-guardian "paperwork" step (`STRUCTURE.md`, `RALPH_MEMORY.md`, `CHANGELOG.md`, `session_summary.md`) was not performed: this was analysis only, no code changed, and no test gate applies to a code change.

**Token usage (provider-reported per agent; input, cached and output split UNAVAILABLE):**

| Agent | Tokens | Tool calls |
|---|---|---|
| F1 | 155,302 | 22 |
| F2 | 145,365 | 15 |
| F3 | 144,129 | 16 |
| F4 | 150,634 | 14 |
| F5 | 156,348 | 18 |
| F6 | 157,689 | 19 |
| F7 | 136,411 | 17 |
| F8 | 121,473 | 14 |
| F9 | 167,182 | 21 |
| **Total (agents)** | **1,334,533** | **156** |

Orchestrator tokens: UNAVAILABLE. Deterministic checks (typecheck, lint, tests, graphify update) used no model tokens.

---

## 9. Remediation log

Owner decisions, 2026-10-27: gate `browser_evaluate` under safety mode (F7-1); add a secret rotate command (F2-1); record the current tab-lock lifetime and authority as decisions, with no TTL (F4-4, F4-6); keep the inspection output format and record that the server instruction is the guard (F8-3).

| Phase | Commit | Findings |
|---|---|---|
| 0 | `6c9922d` | F2-2, F2-3, F2-8 and the 002 review fixes (committed by the Owner) |
| 1 | `137740a` | F2-9, F3-9, F3-10 |
| 1 | `f99d69b` | F7-1, F7-2, F7-3 |
| 1 | `15b5c6e` | F1-1, F1-3, F5-1, F5-2, F5-7 |
| 2 | `f0bc5a1` | F4-2, F4-3, F6-5 |
| 2 | `9240503` | F9-2, F9-4, R-1 (encodings) |
| 2 | `d789b12` | F7-1 follow-up (classifier knows `browser_evaluate`) |
| 2 | `2bcd5a1` | F6-1 |
| 3 | `d9171a6` | F3-3, F3-5 |
| 3 | `510ab81` | F1-2 |
| 3 | `294735f` | F3-1, F3-2 |
| 3 | `0a3cb8b` | F2-1, R-1 (documentation) |
| 3 | `1d4eb97` | F1-4, F1-6 |
| 3 | `76e618d` | ADR-06 to ADR-11 (F7-1, F4-1, F4-7, F4-4, F4-6, F8-3, F2-1, Art 11); F2-7, F8-4; section 5 corrections, including F8-2 |
| 4 | `a33981d` | F7-5, F7-7 |
| 5 | `55a5517` | F1-5, F6-3, F2-4 |
| 5 | `7df0570` | F5-3, F6-6 |
| 5 | `af63187` | F8-5, F9-6 |
| 5 | `3c2f686` | Constitution Art 2 and Art 6 scaffolding (`specs/features/`, `specs/contracts/`, `specs/evidence/`) |
| 6 | `66f2fe4` | U-1 (hidden file input upload), CR-5, CR-6 |
| 6 | `5c96e52` | CR-1, CR-10 |
| 6 | `3bc430c` | CR-3, CR-13 |
| 6 | `f92b50e` | CR-8, CR-11 (closes the F1-5 drift in `scripts/daemon.mjs`) |
| 6 | `eeb5e5e` | CR-2, CR-7, CR-9, CR-12 |

Phase 1 checks (orchestrator, after all slices): `npm run typecheck` 0, `npm run lint` 0, emit to a scratch directory 0, `npm test` 96 files / 1235 tests passed. Local acceptance only; CI and Owner PR approval are the formal gates.

Phase 2 checks (orchestrator): `npm run typecheck` 0, `npm run lint` 0, emit 0, `npm test` 102 files / 1386 tests passed, twice. Orchestrator corrections during acceptance: the secret-key policy again matches `pass` and `pwd` inside one-word keys (`dbpass`, `userpwd`), which the old request-side list caught; the new roster test moved to a port range no other test file uses. F7-5 is confirmed and left for its own slice.

Phase 3 checks (orchestrator): `npm run typecheck` 0, `npm run lint` 0, emit 0, `npm run context:lint` 100/100, `npm test` 105 files / 1410 tests passed, twice. Orchestrator corrections during acceptance: `daemon:stop` first removed any lock the info file did not vouch for, including the fresh lock of a daemon still starting; it now judges the lock by its own pid and write grace, and the script's `pidAlive` counts EPERM as alive, as `lock-file.ts` does. The F8-2 correction in section 5 was itself wrong about the location and is corrected from source. Not covered: the IPC hello timer has no spawned-daemon test, because `daemon.test.ts` runs the compiled `dist`, which is stale until `npm run build`. `dist` and the loaded extension must be rebuilt and reloaded together.

Phase 4 checks (orchestrator): `npm run typecheck` 0, `npm run lint` 0, emit 0, `npm run context:lint` 100/100, `npm test` 1437 tests passed, twice. The implementer found F7-7 while wiring the dispatch check; the orchestrator confirmed it against `safeExec` (`chrome.scripting.executeScript({ func })`) and against `ad03d46`, where the module-level patterns were introduced. `PAGE_DOM_VERSION` is now 16, so a loaded page reinstalls the shared runtime. Real-Chrome smoke was not run: F7-5 and F7-7 are verified against the fake page only.

Phase 5 scope (Owner decision 2026-10-27): fix P3 bugs only; record design notes as accepted (F3-4, F5-4, F8-6, F9-5); keep refactors as tickets (F3-7, F5-6, F5-8, F7-4, F7-6, F8-1, F9-7; F6-8 measured). Risk tiers (Owner decision, adopting the proposal): F1 to F7 CRITICAL; F8 and F9 CONTROLLED, except ref issuance and page data (F8) and redaction and evaluate (F9), which are CRITICAL.

Phase 5 checks (orchestrator): `npm run build` 0, `npm run typecheck` 0, `npm run lint` 0, `npm run context:lint` 100/100, `npm test` 110 files / 1458 tests passed, twice. Before phase 5, `dist` was rebuilt, the daemon restarted and the extension reloaded; `npm run smoke:real-chrome` passed on darwin (reconnect, snapshot, click and type, console and network, upload, drag), and a scratch IPC check confirmed F7-5 and F7-7 in real Chrome (the classifier returns fingerprints; a mismatch is refused with nothing clicked or typed; a match clicks).

Phase 6 scope: the 13 findings of a branch review against `main` (`/code-review`, labelled CR-1 to CR-13 here) and one field report (U-1).
- CR-1: an unparseable absolute-form request target crashed the daemon from the async HTTP listener, before authentication. It now gets 400.
- CR-2: a late successful state load overwrote the adopted daemon instance and releases made while the state was unavailable. It now merges.
- CR-3: running MCP clients kept the startup token, so after `pairing:rotate` and a restart they were denied and exited. They re-read `token.json` on reconnect.
- CR-4 (EPERM pid holds a stale lock) was already covered by F1-5 in the daemon; CR-11 removes the copy in `scripts/daemon.mjs` that lacked the probe.
- CR-5: the classifier and `pageLocate` walked to the focused element differently (closed shadow roots). One shared walk now.
- CR-6: a throw on the second pointer measurement left the input shield armed for 8 s. It is released.
- CR-7: `withTimeout` left its timer armed when `run` threw synchronously.
- CR-8: `reclaimLock` deleted a displaced live lock when the restore link failed. The tombstone is kept.
- CR-9: the popup reported a refused secret as "daemon not reachable".
- CR-10: a silent socket's timeout was reported as "extension older than 3.0". It now names the timeout, keeps the reload hint and never replaces a reason a peer sent. The implementer first dropped the reason; the orchestrator kept a hedged one, because a pre-3.0 extension is silent too.
- CR-12 (HMAC key import per call) and CR-13 (duplicate fingerprint field) are cleanups.
- U-1: `browser_fill` could not reach a hidden `input[type=file]` (Odoo) by selector, ref or label. `D.fileInputFor` maps the target; the classifier marks it `upload`. The orchestrator added a guard so an ARIA control beside a file input stays its own field.

Phase 6 checks (orchestrator): `npm run build` 0, `npm run typecheck` 0, `npm run lint` 0, `npm run context:lint` 100/100, `npm test` 114 files / 1504 tests passed, three times (the third after the 3.0.8 version bump). Process deviation: one implementer ran `git stash` and `git stash pop` on `lock-file.ts` to observe a red test, against its brief; the orchestrator checked that the stash list is empty and the edit intact. Not covered by unit tests: the denied-then-retry wiring in `DaemonClient` (`index.ts`, not exported), and a `sessionRoster` received while the state was unavailable does not drop stored locks of sessions it no longer lists. Risk accepted: a client that reconnects between `pairing:rotate` and `daemon:restart` sends the new token to the old daemon and exits, as any new client would.
