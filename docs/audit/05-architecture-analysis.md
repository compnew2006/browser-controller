# 05 — Architecture analysis

Framing follows architecture-designer: requirements first, then the layer map, then findings, then decisions as ADRs, then risks.
Analysis only — nothing here was implemented.

---

## 1. Requirements summary

### Functional (what the system must do)

1. Accept MCP tool calls from a client, over stdio, and answer them with a typed envelope.
2. Route each call to a Chrome extension that executes it in a real page: navigate, snapshot, click, type, fill, screenshot, evaluate, intercept, emulate.
3. Support several browsers and several agent sessions concurrently, with per-session tab ownership that another session cannot steal.
4. Hold credentials in a per-browser encrypted vault, and fill one only after the user consents in a private extension page; afterwards the filled document stays protected.
5. Never expose a secret to the model, the logs, or storage: only metadata and audit events leave the vault.

### Non-functional (the properties the design is actually built around)

| Property | How the current code expresses it |
|---|---|
| Fail closed | `CredentialVaultStore` refuses to repair missing or corrupt state; `protectionStateTrusted = false` disables fills; ambiguity is an error, not a guess. |
| Crash safety | Atomic write-then-rename with fsync of file *and* directory; a restore journal with staged `.old`/`.tmp` pairs; a lock file with a dead-pid reclaim rule. |
| No secret at rest outside the envelope | Key file, encrypted envelope, and backups that carry both — nothing else. Passwords exist only in memory for one fill. |
| Cross-runtime compatibility | An explicit protocol version plus capability lists, so an old daemon or extension is refused instead of half-working. |
| Defence in depth | The daemon does not trust the extension's verdict; the extension does not trust the daemon's. The same check appears on both sides on purpose. |
| Testability without a browser | `TabMutexMap`/`TabLockMap`/`TabControlMap` are framework-free; fakes for `chrome.*` are everywhere (1,293 test-side symbols). |
| Readability | Files are kept under roughly 600 lines; the vault service was split across four files to stay there. |

### Constraints (these bound every option in section 4)

1. **MV3 service worker.** No persistent globals: state must be rebuildable from `chrome.storage.session` + a durable marker, and the rebuild must fail closed (`restoreVaultRuntimeState`).
2. **`chrome.scripting.executeScript` serialises the function body.** Injected code cannot import, cannot close over module scope, and is not unit-testable as a module. This is why `PAGE_DOM_INSTALL` is 904 lines and why two `collect`/`visible` pairs exist.
3. **Two runtimes, no shared build.** `mcp-server/` is TypeScript compiled by `tsc`; `extension/` is plain JS loaded by Chrome. There is no bundler and no shared package. Any "share the code" proposal must first introduce one, and no new dependencies are allowed.
4. **One process, one writer.** The vault is a single-writer file store; concurrency is solved by a mutation tail plus an on-disk lock, not a database.
5. **1,133 existing tests.** Any structural move must keep them green without rewriting them, otherwise the move cannot be verified.

---

## 2. High-level map

```
MCP client (Claude/Cursor)
        │ stdio, tool calls
        ▼
┌──────────────────────────────────────────────────────────┐
│ mcp-server/src/index.ts        thin client (DaemonClient)│  541 lines
│   connect / handshake / spawn / reconnect                │
└───────────────┬──────────────────────────────────────────┘
                │ unix socket, newline-delimited JSON (IPC)
                ▼
┌──────────────────────────────────────────────────────────┐
│ mcp-server/src/daemon.ts       Daemon                    │  558
│   session table, tool routing, heartbeat, HTTP /pair     │
│   ├─ tools/index.ts → 19 ToolDefinitions → tools/*.ts     │
│   ├─ vault/service.ts (VaultService)  ──────────────┐    │
│   └─ bridge.ts (ExtensionBridge) ── WebSocket ──┐   │    │
└─────────────────────────────────────────────────┼───┼────┘
                                                  │   │
                        ┌─────────────────────────┘   │
                        ▼                             ▼
┌───────────────────────────────────────┐   ┌──────────────────────────┐
│ extension/background.js               │   │ vault/store.ts           │
│   router.js → handlers/*.js (12)      │   │  key + encrypted envelope│
│   lib/*: state, page-exec, cdp-session│   │  backups, restore journal│
│   page scripts injected into tabs     │   │  (single-writer, 0600)   │
└───────────────────────────────────────┘   └──────────────────────────┘
                        │
                        ▼
                  the user's tabs / pages
```

Area sizes (production only):

| Area | Files | Lines | Symbols |
|---|---:|---:|---:|
| `extension/lib` | 25 | 6,382 | 412 |
| `extension/handlers` | 12 | 3,476 | 200 |
| `mcp-server/src` (root) | 12 | 2,958 | 137 |
| `mcp-server/src/vault` | 13 | 2,719 | 173 |
| `scripts` + `agent-config` | 6 | 1,613 | 73 |
| `mcp-server/src/tools` | 7 | 1,350 | 41 |
| `extension/popup` | 3 | 721 | 27 |
| `extension/vault` | 1 | 508 | 29 |
| `extension/utils` | 2 | 287 | 14 |
| `extension` (root: background, events) | 1 | 254 | 4 |
| **Total** | **82** | **20,268** | **1,110** |

The shape is healthy for this size: one hub for the tool contract (`tools/types.ts`, fan-in 53), one hub for extension state (`lib/state.js`, 16), one for page execution (`lib/page-exec.js`, 16), one for CDP (`lib/cdp-session.js`, 14). The problems below are concentrated in the four largest classes and in two boundary files, not spread across the codebase.

---

## 3. Findings

Ordered by how much they cost to leave alone. Confidence is stated per finding; `[high]` means the bodies were read, not inferred.

### F1 — The vault service is one object split across four files by inheritance `[high]`

`VaultServiceCore` (349 lines, 44 members) → `VaultServicePrivate` (+14) → `VaultServiceProtection` (+12) → `VaultService` (+5). One logical object, 75 members, ~1,050 lines, four files, three levels of subclassing.

Evidence: `service-core.ts:12`, `service-private.ts:9`, `service-protection.ts:65`, `service.ts:8`; the base declares `abstract fillGranted(...)` at `service-core.ts:359` and the implementation lives three levels down.

Why it hurts:

- Every layer can reach all ten protected maps (`stores`, `grants`, `requests`, `operations`, `protectedDocuments`, `protectionSequences`, …). Subclassing turns the base's `protected` into "public, but with ceremony". There is no seam at which you can say "this layer may not touch grants".
- The split point is file length, not responsibility. A change to request settlement (`settle`, `claimPending`, `cancelRequests`) lives in the base while the code that *calls* it lives in `service-private.ts`, so a reader must hold two files to see one rule.
- Unit-testing one concern requires constructing the whole chain, because the abstract method forces the top class.
- `service.ts` (175 lines, 5 members) exists only to be the non-abstract leaf. That is a file whose sole purpose is to satisfy the type system.

What is actually distinct inside it: credential storage (`CredentialVaultStore`, already a separate collaborator), the grant registry, the pending-request lifecycle, the operation/abort registry, the protection state, and transport calls. Five of those six are maps with rules.

Proposal: composition. Keep `VaultService` as a facade, extract the operation/abort registry and the grant registry first (they have the cleanest contracts and no UI coupling), then the request lifecycle. ADR-02.

### F2 — `ExtensionBridge` is a god class `[high]`

37 members, 521 lines. `tryListen` alone is 180 lines (`bridge.ts:188`), `sendToolCall` is 84 (`:479`), `handleResponse` 20, `waitForConnection` 25, plus a ping loop, an auth-protocol picker, a pending-call table, an HTTP delegation hook, and the connection registry.

It mixes five concerns: *transport lifecycle* (listen, retry ports, stop), *admission* (hello/helloAck, protocol version, capabilities, reject reasons), *registry* (who is connected, which browser is default, per-session choice), *call correlation* (send, pending map, timeout, abort, rejectAllPending), and *liveness* (ping, drop on silence).

The good news: the codebase already knows how to fix this. `bridge-connections.ts` (185 lines, 19 members) extracted the registry, and `bridge-frames.ts` extracted oversized-frame rejection. The direction is established; `bridge.ts` is where the remaining four concerns still live together.

Why it hurts: `tryListen` cannot be tested without a port; the admission rules cannot be tested without a socket; a change to the ping loop risks the handshake. Blast radius of any edit is the whole file.

Proposal: ADR-04 — extract admission (pure: message in, verdict out) and the pending-call table (pure: id in, promise out), leave a thin facade. Both extractions make existing behaviour testable without a network.

### F3 — The IPC wire is implemented twice, symmetrically `[high]`

`Daemon` (445 lines, 25 members) and `DaemonClient` (216, 23) each contain: a pending-request table keyed by id, a heartbeat/ping loop, line framing with a size cap, session-id handling, and a handshake with version + capability validation. `daemon-reconnect.ts` adds reconnect policy (11 members) and `daemon-config.ts` adds token/enrollment/lock/state.

Some duplication here is *required*: two peers must validate each other independently (see the look-alikes table in `04`). What is not required is the plumbing:

- line buffering with `MAX_IPC_LINE_BYTES` and JSON parse-per-line;
- a `Map<id, {resolve, reject, timer, abort}>` with the same five operations (add, settle, fail-all, fail-for-session, abort);
- heartbeat scheduling.

Those three have no trust content and are the parts that drift silently (a size cap changed on one side is a half-duplex bug).

Proposal: `mcp-server/src/ipc/` with `framing.ts`, `pending.ts`, `heartbeat.ts`, imported by both sides. Keep the two validators separate. This also gives `daemon-reconnect.ts` one place to hang backoff constants.

### F4 — The protocol contract is kept in sync by a comment `[high]`

`mcp-server/src/protocol.ts` and `extension/lib/protocol.js` both declare `PROTOCOL_VERSION = 1`, the capability lists, and mirror-image validators. The extension file says: *"Keep in sync with mcp-server/src/protocol.ts (guarded by protocol tests)."*

A test guards it today. But the failure mode is asymmetric: a capability added on the daemon side and forgotten on the extension side makes a *new* extension look old, and the user is told to reload the extension — a wrong diagnosis, produced by a stale constant.

Proposal: ADR-01. Cheapest correct step: a parity test that reads both files as text and compares the exported constant values (no build change, no new dependency). Better long-term: generate the extension copy.

### F5 — Two import cycles, both through `tools/batch.ts` `[high]`

Verified by DFS over the resolved graph — the only two cycles in production code:

```
tools/index.ts → tools/batch.ts → tools/index.ts
tools/index.ts → tools/batch.ts → register-tools.ts → tools/index.ts
```

Cause: `batch.ts` imports `toolMap` from the barrel `tools/index.ts` (which imports `batchTool`), and imports `parseToolParams` from `register-tools.ts` (the server bootstrap, which imports the barrel and the tool contract). A tool implementation is therefore above the layer that registers it.

Why it hurts: the barrel cannot be tree-shaken, a tool cannot be loaded alone, and `register-tools.ts` — which also owns the payload-size schema and the "missing tabId" hint — is now a dependency of a tool. It is also the single cheapest structural fix in this report: `parseToolParams` plus `payloadLimitsSchema` plus `REQUIRED_HINTS` are a pure parameter-validation module with no server dependency.

Proposal: `tools/params.ts` (validation) and `tools/registry.ts` (the map, built from a list that `index.ts` owns). `batch.ts` imports both; `register-tools.ts` imports both. Cycles gone, no behaviour change.

### F6 — The extension's composition root sits below its own handlers `[medium]`

`extension/lib/router.js` (420 lines) imports 12 handlers; those handlers import `lib/*` back. That is 12 of the 13 cross-area edges from `lib` to `handlers`, and at directory level it looks like a cycle. It is not a logic cycle — `router.js` is the dispatcher, i.e. the composition root, and the handlers are leaves. The problem is placement: everything else in `lib/` is *below* the handlers (`state`, `page-exec`, `cdp-session`, `target`, `ref-errors`), so a reader who trusts directory names will misread the dependency direction.

Proposal: move `router.js` to `extension/dispatch/router.js` (or `extension/router.js`) and update the 12 imports + the background entry. Low risk, and it makes "lib is a leaf layer" true. Alternatively — if the move is judged not worth the churn — write the exception in `extension/lib/README` style at the top of `router.js`.

### F7 — The module boundary over-claims: 34 exports used only inside their own file, 1 dead export, 53 test-only exports `[high]`

Measured, then corrected by hand:

- **Truly dead**: `extension/lib/vault.js:429 clearInspectionState` — no reference anywhere, including its own file.
- **Over-exported** (34): e.g. `mcp-server/src/vault/types.ts` exports `VAULT_MAX_ENTRIES`, `VAULT_MAX_PASSWORD_CHARS`, `VAULT_MAX_LABEL_CHARS`, `VAULT_MAX_IDENTIFIER_CHARS`, `originSchema`, `VaultPrivateRequestSchema`, `VaultGrantSchema`, `VaultMetadataSchema` — all used only inside that file; `tools/types.ts` exports `payloadOf`/`outcomeOf`; `service-common.ts` exports `publicMetadataOf`; `bridge-connections.ts` exports `identityOf`; `daemon.ts` exports the `Daemon` class while `main()` in the same file is its only consumer.
- **Test-only** (53): legitimately part of the contract under test, but they widen the module's public surface for everyone. Examples: `native-host.ts` (`encodeMessage`/`decodeMessage`/`handleRequest`/`runHost`), `tools/index.ts` `toolManifest`, `extension/lib/vault.js` `inspectPasswordField`/`fillInspectedPassword`, `daemon-reconnect.ts` constants.

Why it matters: in a codebase this size, the export list *is* the architecture diagram. 34 false edges in that diagram make every "who depends on what" question harder, and one dead export survives precisely because nothing can see it.

Proposal: phase 4, file by file, `export` removed where the symbol is internal. Zero behaviour change; the compiler and `eslint` catch mistakes. Do it as a separate commit per area so a revert is trivial.

### F8 — Complexity is concentrated, and the top of the list is partly exempt `[high]`

Top by cognitive complexity (extractor metric, `if`/`for`/`while`/`case`/`catch`/`&&`/`||`/`??`/`?`):

| Complexity | Lines | Symbol | Exempt? |
|---:|---:|---|---|
| 484 | 904 | `page-dom.js:25 PAGE_DOM_INSTALL` | yes — injected page script (constraint 2) |
| 187 | 319 | `vault/service-private.ts:9 VaultServicePrivate` | no |
| 152 | 225 | `trusted-input.js:43 pageLocate` | yes — injected |
| 134 | 202 | `handlers/inspection.js:355 snapshotPage` | no |
| 130 | 526 | `vault/store.ts:54 CredentialVaultStore` | no, but security-critical |
| 120 | 521 | `bridge.ts:72 ExtensionBridge` | no (F2) |
| 76 | 166 | `utils/smart-selector.js:27 PAGE_FALLBACK_INSTALL` | yes — injected |
| 61 | 75 | `handlers/interaction.js:318 handleType` | no |
| 61 | 62 | `service-private.ts:164 privateSave` | no |
| 60 | 86 | `lib/input-outcome.js:30 pageRelease` | mixed |

The exempt rows are exempt for a mechanical reason, not a stylistic one. `CredentialVaultStore` is also exempt in practice: its complexity is the price of the crash-safety and ownership rules, and every branch is load-bearing. `privateSave` and `privateUnlock` are the ones where complexity is *rule* complexity — the validation of a save or an unlock request — and could be expressed as a schema plus a few guards.

Proposal: do not touch the injected scripts until ADR-03 lands. For the non-exempt ones, the phase-3 work is targeted: `snapshotPage` and `handleType` are handler bodies that can lose their branch structure to small named predicates, and `privateSave` can lose its manual validation to the existing zod schemas.

### F9 — The tool vocabulary has three homes and no compile-time link `[high]`

A tool's name appears in: `mcp-server/src/tools/index.ts` (`allTools`, 19 entries), the tool's own `ToolDefinition`, and the extension's dispatch (`router.js` + the handler that answers it). Adding a tool therefore touches two runtimes.

Checked, so this is not a guess. `tests/tools/registry.test.ts` already locks two of the three links:

- `:10` `expectedTools` — a hardcoded, ordered list of the 19 public names, asserted with `toEqual`. That is a deliberate contract lock on `tools/list` order, not drift.
- `:58` a **wire-name drift guard** — every tool's handler closure must be tagged with its own `.name`, otherwise the idempotency-retry lookup silently fails. That covers MCP name ↔ wire name.
- `toolManifest` (`tools/index.ts:68`) exists to back those tests; it compares against nothing external.

So the gap is exactly one edge: **nothing asserts that the extension's dispatch knows every wire name the server will send.** Forgetting the extension side yields a runtime "unknown tool" instead of a failed test. The cheapest fix is that one test (phase 6, step 6) — not a new mechanism.

### F10 — Three "vault" modules, one word `[high]`

`extension/lib/vault.js` (worker actions), `extension/vault/vault.js` (UI page), `extension/lib/vault-connection.js` (channel). See `04` B4. Pure navigability; cheap; do it before any deeper vault work so later diffs are readable.

### F11 — Two failure-message tables for one code vocabulary `[medium]`

`extension/lib/vault.js:33 safeFailure` and `mcp-server/src/vault/service-common.ts publicError/safeMessage` both map `VAULT_*` codes to prose the model reads. Same code, potentially two explanations. For an agent-facing tool that is a correctness issue: the model's next action depends on that sentence. See `04` B2. Decide whether they are meant to be identical or deliberately layered, then pin the decision with a fixture test or a comment.

The sharper half of this is F13: the extension consults its table with the **wrong key** for most throws, so the wording question is downstream of a mapping question.

### F12 — Test-helper sprawl `[high, out of scope]`

9 copies of an `executeScript` fake, 6 of a storage stub, 5 of `sendCommand`, two `FakeWebSocket`, `FakeElement`/`FakeDocument` in two places. Real debt, recorded in `04` D, deliberately excluded from the plan (tests are not to be modified, and touching them would collide with every phase).

### F13 — The extension's vault catch-all reports the wrong reason `[high]`

`extension/lib/vault.js:587` `handleVaultAction` wraps `inspectAction` and `fillAction` in a bare `catch`
that returns `safeFailure('VAULT_TARGET_UNSAFE')` for **every** throw. That code's sentence
(`:35`) is *"The page does not have one verified editable password field."*

So all of these arrive at the model as a claim about the page's fields:

- an origin the vault does not support (`canonicalOrigin` throws `VAULT_TARGET_UNSAFE` at `:49`–`:53`);
- a `chrome.tabs.get` / `chrome.webNavigation.getFrame` rejection in `getMainDocument`;
- a wedged tab or an 8 s injection timeout from `runVaultScript`;
- a malformed request, an expired nonce, a document that changed.

This is the one finding in the report whose user is the *model*: an agent told "no password field" will
try to type into the page, or give up and ask the user to log in manually, instead of reporting that the
origin is unsupported. It also collides with the daemon, which has a precise `VAULT_ORIGIN_MISMATCH` for
the same condition — so the same page can produce two different stories depending on which layer refuses
first (see B1 and B2 in `04`).

Two halves, and the second is a prerequisite for the first: give the specific throws their own codes
(origin at minimum), then decide the wording policy. Tracked as the wayfinder ticket *Failure messages:
one voice or two*.


---

## 4. Decisions (ADR drafts)

Each is written as context → decision → alternatives → consequences, per architecture-designer.

### ADR-01 — One source of truth for the wire protocol

**Context.** Two runtimes hand-maintain the same constants; a comment and tests are the only link (F4).

**Decision (recommended).** Two steps. (1) Now: a parity test that reads `mcp-server/src/protocol.ts` and `extension/lib/protocol.js` as text, extracts `PROTOCOL_VERSION` and the capability arrays, and fails on any difference. No build change, no dependency. (2) Later, if the capability list keeps growing: generate `extension/lib/protocol.js` from a single JSON file at build time (`node scripts/generate-protocol.mjs` in the existing `build` script).

**Alternatives.** *Shared TS package* — rejected: the extension is plain JS with no build step (constraint 3). *Duplicate and accept* — rejected: the failure mode is a wrong diagnosis shown to the user. *Runtime fetch of a JSON from the daemon* — rejected: the extension must validate before it trusts anything the daemon sends.

**Consequences.** Positive: drift fails CI. Negative: a generated file must be committed or built in the extension flow; the parity test duplicates knowledge of both file shapes and must be updated if either moves.

### ADR-02 — Vault service: composition over inheritance

**Context.** F1: 75 members over four files, `protected` state reachable everywhere, `service.ts` exists to satisfy the type system.

**Decision (recommended).** Keep `VaultService` as the public facade. Extract, in this order, each as a plain collaborator with an explicit interface, injected through the constructor:
1. `OperationRegistry` — `track`, `complete`, `signal`, `abortMatching`, `waitForMatching`. Pure map + `AbortController`; no domain knowledge.
2. `GrantRegistry` — `find`, `create`, `consume`, `revokeByScope`. The `findGrant` predicate is the whole rule and becomes testable alone.
3. `RequestJournal` — `begin`, `claim`, `settle`, `expire`, `cancelMatching`. This is where `settle()` from the last refactor belongs.

Leave protection state and the transport calls in the facade until 1–3 have landed: they are the most coupled to both.

**Alternatives.** *Keep the chain and add docs* — cheapest, but the `protected` leakage stays. *Full rewrite into separate services with a message bus* — over-engineering for 20k lines (architecture-designer's MUST NOT). *Move methods between the existing files only* — does not change the coupling, just its address.

**Consequences.** Positive: each registry is unit-testable without a store or a transport; the facade shrinks; the `abstract fillGranted` can become an injected strategy. Negative: constructor grows (mitigate with one options object); a mechanical move of ~40 methods across three commits is high-churn and must be done with the test suite green at each step; `private` state that used to be reachable becomes genuinely inaccessible, so any hidden cross-layer use surfaces as a compile error — which is the point, and also the risk.

### ADR-03 — Bundle injected page scripts at build time

**Context.** `PAGE_DOM_INSTALL` is 904 lines / complexity 484 because an injected function cannot import (constraint 2). The same constraint forces the `collect`/`visible` duplication.

*Correction (2026-10-27, `09` F8-2).* `09` places the `collect`/`visible` duplication between `PAGE_DOM_INSTALL` and `PAGE_FALLBACK_INSTALL`. That was not reproduced: the pair is copied in `extension/lib/vault-actions.js` (`inspectPasswordField`, `fillInspectedPassword`), forced by the same constraint. `PAGE_FALLBACK_INSTALL` has only an overlapping inline visibility check in `computeNth`. `09` section 5 is corrected to match.

**Decision (recommended).** Do not decide yet — this is a wayfinder ticket, because the answer changes the extension's build story. If pursued: a second `tsc` target (or the existing TypeScript compiler API) emits each page script as a single-file IIFE string into a generated `page-scripts.js`, and the call sites pass the string to `executeScript` instead of a function. No new dependency (constraint 3).

**Alternatives.** *Keep as is* — legitimate; the code works and is well commented. *String-template the shared helper into both bodies* — moves the duplication into a build step with worse ergonomics than bundling. *Have the injected function import via dynamic `import(chrome.runtime.getURL(...))`* — works in MV3 but adds an async hop before the page script can run and fails on pages with a strict CSP.

**Consequences.** Positive: the four large injected scripts become testable modules; `collect`/`visible` collapse to one. Negative: a generated artefact in the tree; a build step that can break the "load unpacked" workflow; the injected code's error semantics (`wedgedError`, timeouts) must survive the wrapper.

### ADR-04 — Split `ExtensionBridge`

**Context.** F2: 37 members, five concerns, 180-line `tryListen`.

**Decision (recommended).** Extract, in this order:
1. `admission.ts` — `judgeHello(message, expected)` → `{ok, reason, identity}`. Pure; the version/capability policy already exists in `protocol.ts`, so this is assembly, not new logic.
2. `pending-calls.ts` — `add(id, {resolve, reject, timer})`, `settle(id, result)`, `failAll(predicate, error)`, `abort(id)`. Pure table; `sendToolCall` loses its bookkeeping half.
3. Keep in `bridge.ts`: listen/retry, socket wiring, ping loop, HTTP delegation, and the facade methods (`callTool`, `isConnected`, `stop`).

**Alternatives.** *Extract the listener into a `WsServer` class* — tempting, but `tryListen`'s 180 lines are mostly port-selection policy and daemon-vs-standalone decisions, which is domain logic, not transport; extracting it would move the problem. *Leave it* — the file is stable, so this is a maintainability bet, not a bug fix; sequence it after F5 (the cycles), which is cheaper and de-risks the tool layer first.

**Consequences.** Positive: admission rules become table-testable; a call-correlation bug stops being a socket bug. Negative: two new files, and the bridge's private state must be passed explicitly — the same "hidden cross-layer use becomes a compile error" risk as ADR-02.

### ADR-05 — Router is a composition root, not a library module

**Context.** F6: 12 of 13 `lib → handlers` edges come from `router.js`.

**Decision (recommended).** Move `extension/lib/router.js` to `extension/dispatch/router.js`. Update 12 imports and the background entry.

**Alternatives.** *Document the exception* — acceptable if the move interferes with `web_accessible_resources` or the test harness. *Leave and re-export* — no; a re-export barrel would preserve the wrong direction.

**Consequences.** Positive: "everything in `lib/` is below the handlers" becomes true; new handlers have an obvious registration point. Negative: test imports change (`tests/` import `lib/router.js`), so this is a rename touching tests — verify it is allowed before starting; if tests may not change, choose the documentation option instead.

---

## 5. Risks and mitigations

| # | Risk | Likelihood | Impact | Mitigation | Phase |
|---|---|---|---|---|---|
| R1 | A structural move silently changes vault behaviour | Medium | Critical | The vault is fail-closed: a behaviour change can lock a user out or expose a fill. Every vault phase needs its existing tests *plus* a manual smoke (`npm run smoke:vault-isolated`) before and after. | 3 |
| R2 | Moving methods into collaborators surfaces hidden cross-layer state and the fix becomes a rewrite | High | High | One collaborator per commit; `npm run typecheck` after each; if a commit needs more than ~10 call-site edits, stop and re-plan. | 3 |
| R3 | Renaming `extension/lib/vault.js` breaks the loaded extension in place | Medium | Medium | The manifest and `vault.html` reference paths. Grep `vault.js` across `extension/` and `tests/` before the rename; reload the unpacked extension once. | 2 |
| R4 | The parity test (ADR-01) becomes a second hand-maintained copy | Medium | Low | Parse only the two constant blocks, with an explicit failure message naming the file to update. | 1 |
| R5 | Deduplicating `bounded`/`withTimeout` changes a timeout message the tests assert on | Low | Low | Keep the message strings identical at the call sites; the message is part of the agent-facing contract. | 1 |
| R6 | Narrowing exports (F7) breaks a consumer outside `mcp-server/` and `extension/` (docs, generated schemas) | Low | Medium | `tsc --noEmit` catches TS consumers; grep `llms.txt`, `README.md`, `server.json` for the symbol name before removing `export`. | 4 |
| R7 | The injected-script bundling (ADR-03) changes timing or error handling on the page | Medium | High | Not in any phase until the wayfinder ticket decides; if adopted, ship one script at a time behind an unchanged call-site contract. | — |
| R8 | Fixing the extension's failure catch-all (F13) changes a code the agent sees, in an area with no test coverage | Medium | Medium | Nothing asserts `VAULT_TARGET_UNSAFE` today, so the change cannot break a test — which means nothing will catch a mistake either. Add the assertion for the new mapping in the same commit, and run the private-vault path by hand. | 6 |

---

## 6. What is deliberately **not** proposed

Per architecture-designer's MUST NOT list, and to protect what already works:

- No microservices, no message bus, no database. The single-process, single-writer design is what makes the vault's guarantees expressible.
- No new dependencies. Every recommendation above is achievable with the compiler, the test runner and the file system.
- No rewrite of `CredentialVaultStore`. Its complexity is the security model; the remediation is to leave it alone and make its neighbours simpler.
- No change to the injected page scripts until ADR-03 is decided.
- No test refactor, even though the duplication there is larger than in production code (`04` D).
- No consolidation of the intentional cross-runtime duplication listed in `04` C.
