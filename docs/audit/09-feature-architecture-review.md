# 09 — Feature-by-feature architecture review (2026-10-27)

Analysis only. Nothing in this document was implemented.

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
| F7-2 | ✔ | NEW | OBSERVED | The action-safety gate (`enforceActionSafety`, `ACTION_BLOCKED`, `browser_classify_action`, `action-safety.js`) has no behavioural test. | `grep` of `tests/` finds only tool-name lists: `tests/extension-router.test.ts:360-362`, `tests/tools/registry.test.ts:17-20`. | Add tests for allow / block / ask / unavailable and for each category (submit, delete, upload, unknown) with a mocked classifier. |
| F7-1 | ✔ | NEW | HYPOTHESIS (intent unknown) | `browser_evaluate` bypasses the session safety policy. The policy promises control of "submit, delete and upload actions", but page JS can call `form.submit()` or `el.click()`. | `mcp-server/src/tools/safety.ts:10-11`; `mcp-server/src/tools/evaluate.ts` has no safety hook; only `action-support.ts` and `fill.ts` call `enforceActionSafety`. | Owner decision: either state in the `browser_safety` description that evaluate is outside the policy, or deny/ask evaluate when the policy is `block`/`ask`. |

### P2

| ID | Chk | KNOWN/NEW | Status | Finding | Evidence | Smallest credible fix |
|---|---|---|---|---|---|---|
| F4-3 | ✔ | NEW (principle KNOWN 05 §1) | OBSERVED | Tab-lock restore fails **open**. A `chrome.storage.session` read error starts with no locks, marks state loaded, and flushes any deferred persist over the stored locks. Writes also fail silently. | `extension/lib/state.js:271-277`, `:233` (`.catch(() => {})`) | On load failure keep persistence disabled and retry the load; never flush empty state over stored data. |
| F4-1 | ✔ | NEW | NON_CONFORMITY | The spec's LOCKED decision 1 ties the shield to the lock lifetime and to `browser_tabs {action:"lock"/"unlock"}`. The code draws the shield per call, and the tool enum is `list/close/focus`. The change was deliberate (commit `e4c6baf`, "per-call shield"), but the spec was not amended. | `specs/tab-control-lock/spec.md:35`; `extension/lib/lock-ops.js:5-6`; `extension/dispatch/router.js:384-386, 403-405`; `mcp-server/src/tools/tabs.ts` | Write an ADR recording the per-call decision and mark the spec superseded. No code change. |
| F4-2 | ✔ path | NEW | HYPOTHESIS | Orphan tab locks. `releaseSession` is fire-and-forget to *live* sockets only. If the extension is disconnected when an agent leaves, the release is lost; locks are reset only when the daemon instance id changes. | `mcp-server/src/bridge.ts:359-370`; `extension/lib/connection.js:257` (`adoptDaemonInstance`) | On hello/helloAck, send the live session roster and release locks whose owner is absent. |
| F1-1 | ✔ | NEW | HYPOTHESIS (race not reproduced) | Daemon lock takeover is check-then-unlink. Two starters that both judge a lock stale can each unlink and recreate it, so two daemons can run. `createIpcServer` also unlinks the socket unconditionally. | `mcp-server/src/daemon-config.ts:98-131` (`daemonLockHolder`, `acquireDaemonLock`) | Re-read the lock and unlink only if its content still equals the stale content, or use an atomic rename/flock takeover. Add a stale-lock race test. |
| F1-3 | ✔ | NEW | OBSERVED | The systemd unit restarts forever when a second daemon loses the lock: `main` exits 0 on `DaemonLockHeldError` by design, and the unit uses `Restart=always`. | `deploy/systemd/browser-controller-daemon.service:12-13`; `mcp-server/src/daemon.ts:545-551` | `Restart=on-failure`. |
| F5-2 | ✔ | NEW | OBSERVED | A crash between `O_EXCL` create and the pid write leaves an empty vault lock. `removeStaleLock` then fails to parse it, the error is swallowed, and every operation returns `VAULT_BUSY` until the file is deleted by hand. | `mcp-server/src/vault/store.ts:541-552, 571-572` | Treat an unparseable lock older than the grace period as stale, or write the lock to a temp file and rename it into place. |
| F5-1 | ✔ | NEW | HYPOTHESIS | Vault stale-lock reclaim reads the pid, probes it, then unlinks without re-checking the file. Between probe and unlink another process can take the lock, so two writers can run and one update is lost. Reachable mainly through F1-1. | `mcp-server/src/vault/store.ts:567-578` | Rename the lock to a unique tombstone, re-read its pid, restore if alive. Add a two-reclaimer test. |
| F5-7 | — | NEW | OBSERVED | No test covers stale-lock reclaim, pid reuse, an empty lock, or concurrent reclaim. | `tests/vault-store.test.ts:152` is the only lock test | Add these tests with F5-1 and F5-2. |
| F2-2 | ✔ | NEW | **Resolved 2026-10-27** | `/auth/challenge` needs no secret and has no per-source limit. Filling 1024 challenges within the 30 s TTL returned 503 to pairing, `/status` and reconnect. Browser control was not bypassed. A full store now evicts its oldest challenge instead of refusing, so a flood must win a race against each live request instead of locking every caller out. All callers share 127.0.0.1, so a per-source limit would not separate them. | `mcp-server/src/bridge-auth.ts` `issueChallenge`; `tests/bridge-auth.test.ts` "keeps a hard capacity by evicting the oldest outstanding challenge" | Done. **WIP** |
| F2-8 | ✔ | NEW | **Resolved 2026-10-27** | The WebSocket client proof was bound only to the client-chosen nonce and the per-process instance id. A local process that captured one `helloAck` could replay it, with the same nonce in its own `authInit`, and become the browser until the daemon restarted (FR-002; the contract's "replayed proofs fail closed"). The daemon now picks a `serverNonce` per socket, sends it in the hello, and verifies the client proof against it. The contract was amended to match. | `mcp-server/src/bridge.ts` connection handler; `mcp-server/src/bridge-auth.ts` WS transcripts; `extension/lib/daemon-auth.js`; `specs/002-daemon-authentication/contracts/websocket-auth.md` steps 2 and 4; `tests/protocol-handshake.test.ts` "refuses a helloAck replayed on a new connection" | Done; protocol change, needs Owner review. **WIP** |
| F2-1 | — | NEW | REQUIREMENT gap | The spec names a "rotated secret", but there is no rotate or revoke path. The enrollment secret is the single root of trust. | `specs/002-daemon-authentication/spec.md:53`; `daemon-config.ts:227` | Add `pairing.mjs rotate`, or amend the spec and record the accepted risk. **WIP** |
| F2-3 | ✔ | NEW | **Resolved 2026-10-27** | The daemon-side pre-auth gate had only the invalid-proof path under test (`tests/protocol-handshake.test.ts` "rejects a browser control frame before the peer proves the extension token"). Two tests now cover a non-`authInit` first frame and a non-`helloAck` frame after the hello. | `mcp-server/src/bridge.ts:232, 245`; `tests/protocol-handshake.test.ts` | Done. **WIP** |
| F2-4 | ✔ | NEW (pattern KNOWN 04 §B) | OBSERVED, **downgraded to P3** | The auth transcripts are hand-duplicated in TS and JS. Correction: cross-runtime parity *is* exercised — `tests/extension-connection-handshake.test.ts` verifies JS proofs with the TS verifier and drives the JS HTTP client against the TS `BridgeHttpAuthenticator`. A shared vector file would only make failures easier to localise. | `bridge-auth.ts:62-119`; `extension/lib/daemon-auth.js:45-107` | Optional. **WIP** |
| F2-7 | ✔ | NEW | NON_CONFORMITY (process) | `tasks.md` has 0 of 20 boxes ticked although much is implemented; `verification.md` is missing; T008/T010/T016 cite non-existent paths. | `specs/002-daemon-authentication/tasks.md` | Update tasks after the suite passes; add `verification.md`. **WIP** |
| F3-2 | — | NEW | OBSERVED | Two helloAck builders on the extension side: the shared one has no auth fields, so `connection.js` adds them at the call site. | `extension/lib/protocol.js` `buildExtensionHelloAck`; `extension/lib/connection.js` ~380 | One builder per side that takes the auth input. **WIP** |
| F3-3 | ✔ | NEW | OBSERVED | No outbound backpressure: `ws.bufferedAmount` is never checked. | `grep bufferedAmount` over `mcp-server/src`, `extension/lib`: no hits | Reject with a busy code above a buffer limit; add a test. |
| F6-1 | — | NEW | OBSERVED | When the batch budget cuts a write step, the result says `TIMEOUT: batch budget used` and not that the outcome is unknown, although the step may have completed. | `mcp-server/src/tools/batch.ts:30-40, 128-131` | For non-idempotent steps report "outcome unknown; check the page before retrying" (as `VAULT_OUTCOME_UNKNOWN` does). |
| F7-3 | — | NEW | OBSERVED | A blocked `browser_fill` returns a different shape from a blocked click/type (no receipt). | `mcp-server/src/tools/fill.ts:124-125, 145` vs `action-support.ts:227-230` | Wrap the inline return in `withReceipt(..., 'not_dispatched')`. |
| F7-5 | — | NEW | HYPOTHESIS | Classify-then-act TOCTOU: the target is resolved at classification time and again at action time; the fingerprint is not compared. | `extension/handlers/action-safety.js`; `trusted-input.js:53` | Pass the classified fingerprint to the action and reject on mismatch. |
| F8-3 | ✔ | NEW | OBSERVED | Page-derived text reaches the model without an in-payload "untrusted data" marker; the only guard is the server instruction. Agent rated P1; downgraded because the instruction exists and an envelope is defence in depth. | `mcp-server/src/index.ts:83`; snapshot/text formatting in `extension/handlers/inspection.js` | Delimit page-derived strings in results; check snapshot consumers before changing the format. |
| F9-2 | ± | NEW | OBSERVED | The two body redactors disagree. `response-bodies.js` `SENSITIVE_KEY` lacks `pwd`, `credential`, `private_key` and bare `pass`, which `network-capture.js` `SECRET_KEY` covers. The agent's second claim (numeric values under a secret key are skipped) was not re-checked. | `extension/lib/response-bodies.js:26`; `extension/lib/network-capture.js:28` | One shared key policy; redact any scalar under a secret key; add tests. |
| R-1 (F5-5 + F9-1) | — | NEW | HYPOTHESIS | Vault-secret scrubbing is exact substring over Unicode-normalisation and line-ending variants only. JSON-escaped, URL-encoded, base64 or split forms returned by `browser_evaluate` or logs are not caught. | `mcp-server/src/vault/redaction.ts:12-21, 131-138` | Add escaped and encoded variants; document that evaluate is not a secret-safe channel. |
| F3-1 | ✔ | KNOWN (05 F3/F4, ADR-01) + NEW detail | OBSERVED | Parity tests cover protocol constants only, not validators or required-capability lists. NEW: the JS export is named `PROTOCOL_VERSION = 2` while its TS twin is `EXTENSION_PROTOCOL_VERSION`; TS `PROTOCOL_VERSION = 1` is the IPC version. | `extension/lib/protocol.js:1-2`; `mcp-server/src/protocol.ts:9-11` | Rename the JS constant; extend the parity test. **WIP** |

### P3

| ID | Chk | Finding | Evidence |
|---|---|---|---|
| F1-4 | ± | `daemon:stop` unlinks the lock when the info file says the daemon is not live. Narrower than the agent's "unconditional" claim, but a stop during a concurrent start can still delete a fresh lock. | `scripts/daemon.mjs:113-116` |
| F1-2 | — | No handshake timer before `hello`; an idle local socket is held indefinitely. | `mcp-server/src/daemon.ts:196-339` |
| F1-5 | — | Lock ownership is "pid alive", so pid reuse after a crash can look like a held lock. | `mcp-server/src/daemon-config.ts:98-109` |
| F1-6 | — | `daemonStatus` reports a missing build as "daemon not running". **WIP** | `scripts/daemon.mjs` (diff) |
| F3-4 | ± | Cancel is broadcast to every browser. The comment at `bridge.ts:362` says this is intended, so it is a design note, not a defect. | `mcp-server/src/bridge.ts:359-370` |
| F3-5 | ✔ | The timeout branch does not remove the `abort` listener (send-failure and settle paths do). Harmless after the fact because `onAbort` checks the pending map; a small leak per timed-out call on a long-lived signal. | `mcp-server/src/bridge.ts:443-458` vs `:336, :491, :507` |
| F3-7 | — | `connection.js` mixes transport with pairing, badge, popup setters and tab listing. | `extension/lib/connection.js` |
| F4-4 | — | No lock TTL or liveness check: an idle but alive session holds a tab indefinitely. Decision needed, not code. | `extension/lib/tab-concurrency.js` |
| F4-6 | — | The daemon enforces no tab ownership; the extension is the sole authority. Record it as an explicit decision. | literal grep `TAB_LOCKED` in `mcp-server/src` |
| F4-7 | ✔ | The tab-lock spec says lock persistence is out of scope; `state.js` persists locks. Spec line refs point at the pre-split `background.js`. | `specs/tab-control-lock/spec.md:73`; `extension/lib/state.js:11-15` |
| F5-3 | — | Backups embed the key and keep deleted credentials; nothing purges them. | `mcp-server/src/vault/store.ts:189, 202-210` |
| F5-4 | — | KNOWN (`specs/001-*/plan.md:72`): plaintext `.key` next to the ciphertext, no KDF. Documented choice. | `store-format.ts:28-58` |
| F5-6 | — | Every get/list/fill decrypts the whole vault into JS strings. | `store.ts:144-147` |
| F5-8 | — | KNOWN (`07-wayfinder/ticket-vault-composition-pay-or-freeze.md`): the service split is an inheritance chain, i.e. a size split. | `vault/service-*.ts` |
| F6-2 | — | `browser_batch` step params are `z.record(z.unknown())`; per-step schemas are not advertised. A real token trade-off. | `mcp-server/src/tools/batch.ts:87-95` |
| F6-3 | ✔ | `routeCall` forwards any tool name and params ("pure multiplexer"); schema validation exists only in the MCP process. Defence in depth for authenticated IPC clients. | `mcp-server/src/daemon.ts` ~380-425 |
| F6-5 | ✔ | `browser_classify_action` is excluded from `dispatchedTools` but still reachable through `dispatch`. | `extension/dispatch/router.js:67, 71, 73-76` |
| F6-6 | — | `browser_batch.timeoutMs` is inert for transport (batch never reaches the bridge). | `batch.ts:98` |
| F6-8 | — | Uncoded throws become `INTERNAL_ERROR`; count of affected handlers not measured. | `types.ts:132-135` |
| F7-4 | — | KNOWN (05, 04): `trusted-input.js` mixes CDP plumbing with injected locate policy. | `extension/lib/trusted-input.js` |
| F7-6 | — | `screenshot.js` and `inspection.js` import input internals from `trusted-input.js`; scroll input lives outside F7. | `screenshot.js:18, 315`; `inspection.js:8, 175` |
| F8-1 | — | KNOWN (05 §1, 04, 06): `PAGE_DOM_INSTALL` is tested through fake-dom only. | `extension/lib/page-dom.js:25` |
| F8-4 | ✔ | `specs/webmcp-support/` says "implemented"; the feature was removed in 3.0 (no `webmcp` in `extension/` or `mcp-server/src`). | `specs/webmcp-support/implementation_report.md:57` |
| F8-5 | — | `browser_wait` hard max 50 s vs tool timeout 55 s; the poll loop was not fully read. | `extension/handlers/inspection.js` |
| F8-6 | — | Screenshot budget is bounded and tested (positive check). | `extension/handlers/screenshot.js:28-34, 98-111` |
| F9-4 | ✘ / ± | **Contradicted:** the agent said body capture is not released when a session ends. It is: `clearTabSetting` handles `'bodies'` via `releaseBodyCapture`. What remains: no TTL while the session is alive. NEW (orchestrator): the pin name is defined twice, `BODY_PIN` and `BODY_CAPTURE_PIN`, both `'network-bodies'`. | `extension/dispatch/router.js:131-136`; `extension/lib/state.js:41, 190-194`; `extension/handlers/logs.js:21` |
| F9-5 | — | A mock with rules pins the debugger; `Fetch.enable` `*` pauses every request. Documented. | `extension/handlers/mock.js` |
| F9-6 | — | The evaluate size cap runs after full page-side `JSON.stringify`. | `extension/lib/cdp-evaluate.js` |
| F9-7 | — | KNOWN (04, 06): race helpers duplicated in `cdp-session.js`. | `extension/lib/cdp-session.js` |

### Positive checks worth keeping on record

- F2 auth core: challenges are consumed before verification, have a TTL, use a timing-safe compare, fail closed without a secret, and pin the origin by exact match (`bridge-auth.ts:59, 273-274`; `bridge-security.ts:40, 50`). **WIP**
- F5: AES-256-GCM with a random 96-bit nonce and AAD; grants are re-checked after every await in `FillWorkflow` (`vault/fill.ts:61-133`).
- F7: one resolver for `REF_GONE` / `AMBIGUOUS` (`page-dom.js:448-487`) with shared wording (`ref-errors.js`).
- F9: `chrome.debugger.*` is called only from `cdp-session.js`; tab-close cleanup drops network, body and mock state.

---

## 5. Corrections to existing audit documents

| Document | Correction | Source |
|---|---|---|
| `04-duplication-register.md:183`, `05-architecture-analysis.md:285` | The collect/visible duplication is between `PAGE_DOM_INSTALL` and `PAGE_FALLBACK_INSTALL`; `inspection.js` and `inspect-element.js` call `D.isVisible` / `D.nameOf` rather than copying them. | F8-2 |
| `07-wayfinder/ticket-tool-vocabulary-assertion.md` | Parity is now asserted by `tests/extension-router.test.ts:362-378` and `tests/vault-redaction.test.ts:11`; the ticket still describes a gap. | F6-4 |
| `specs/tab-control-lock/spec.md` | Superseded by the per-call shield (`e4c6baf`) and by lock persistence in `state.js`. | F4-1, F4-7 |
| `specs/webmcp-support/` | Feature removed in 3.0; mark superseded. | F8-4 |

---

## 6. Constitution fit (proposed v4.1.0)

| Article | Repository state | Gap |
|---|---|---|
| Art 2 (tiers) | No feature declares a tier. | 8 of 9 features are CRITICAL or partly CRITICAL (section 2). The Owner must confirm CRITICAL. |
| Art 5 (record types) | Stale specs are not recorded as `NON_CONFORMITY`. | F4-1, F4-7, F8-4, F2-7. |
| Art 6 (spec/contract/evidence) | Specs exist for 001, 002, tab-control-lock, webmcp. Contracts are prose (`contracts/*.md`); the zod schemas are the only machine-readable contract. | No `specs/features/`, `specs/contracts/`, `specs/evidence/`; no `version` / `risk_tier` headers; no contract hash. |
| Art 10 (static analysis) | Respected in this review: absence claims are backed by greps. | — |
| Art 11 (one graph tool per repo) | The repo uses both graphify and codebase-memory, and `AGENTS.md` names both. | Choose one per Art 11 rule 4, or record the exception in an ADR. |
| Art 12 (claims) | No claim IDs or evidence manifests. | This report uses feature-scoped IDs as an interim. |
| Art 16 / Annex B (tests) | Full regression baseline passes (1171 tests). | Missing: safety gate (F7-2), lock reclaim and concurrency (F1-1, F5-7), failure/recovery for tab-lock restore (F4-3), adversarial redaction (R-1, F9-2). CRITICAL needs failure-and-recovery tests. |
| Art 21 (security) | Secrets are written 0600 in 0700 dirs; no secret value was printed by any agent. | Secret rotation (F2-1), redaction drift (F9-2, R-1), evaluate outside policy (F7-1). |

---

## 7. Recommended order (not implemented)

1. **Owner decisions, recorded as ADRs:** evaluate vs safety policy (F7-1); per-call shield and lock persistence, then mark the tab-lock spec superseded (F4-1, F4-7); lock lifetime and the extension-as-authority model (F4-4, F4-6); secret rotation (F2-1); one graph tool vs both (Art 11).
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
