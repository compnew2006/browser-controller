# 06 — Remediation plan

Seven phases (P0–P6) plus one conditional (P7). Each phase is independently shippable, verified by the same commands, and revertable by reverting its own commits. Nothing in this document has been executed.

Ordering is by (risk removed ÷ risk introduced). Phases 1–2 are cheap and make later diffs readable; 3–4 are the structural work; 5–6 are contract hygiene that must come **after** 3–4 because those moves change the export surface anyway.

```
P0 baseline ─► P1 mechanical dedup ─► P2 boundaries & cycles ─► P3 vault composition
   ─► P4 bridge & IPC ─► P5 export narrowing ─► P6 single-source policy
                                                     │
                                                     └─► P7 (conditional, gated on a decision)
```

P3 and P4 are sequential rather than parallel on purpose: both edit `daemon.ts`, so running them at the
same time means rebasing one against the other. P1 is the only phase that can be split across two people
safely (its five steps touch disjoint files).

---

## Phase 0 — Baseline you can prove

**Goal.** A recorded starting point, so any later phase can show it did not regress behaviour.

**Steps.**

1. Record the clean state:
   ```
   git status --short          # expect only .codebase-memory/* modified
   git log --oneline -1        # c2b37f6 at the time of this audit
   npm run typecheck
   npx eslint mcp-server/src tests extension vitest.config.ts eslint.config.js
   npm test                    # expect 89 test files, 1133 tests
   ```
   Re-recorded 2026-10-28: commit `8777e78` untracked and gitignored `.codebase-memory/`, so a Phase 0 baseline taken from that commit onward expects a clean tree.
2. Record the structural baseline with the audit extractor (it writes only gitignored JSON, into `docs/audit/tools/`):
   ```
   node docs/audit/tools/extract2.cjs "$PWD" docs/audit/tools
   ```
   Expected: `files 193`, `symbols 2403`, `exactGroups 45`, `shapeGroups 22`, `unusedExports 35`, `testOnlyExports 53`, `parseFailures 0`.
3. Confirm the smoke harnesses are runnable in this checkout, or record that they are not (`npm run smoke:vault-isolated` needs a Chrome instance). Their availability decides whether R1's manual check is possible in phase 3.

**Acceptance.** All three commands green and the extractor counts match the numbers above.
**Blast radius.** None. **Rollback.** Not needed.

---

## Phase 1 — Mechanical dedup (no behaviour change, no structure change)

**Goal.** Remove the duplicates that are provably the same code (`04` A1–A5) and the one dead export.

**Steps, each its own commit.**

1. **`isRecord`** — delete the private copy at `mcp-server/src/vault/daemon-routing.ts:30`; import from `./service-common.js`.
2. **`extension/lib/timing.js`** — new module with `raceReject(promise, ms, message)`, `settleWithin(promise, ms)` and `TIMED_OUT` moved from `cdp-session.js`, plus `sleep(ms)`.
   - `extension/lib/cdp-session.js` `bounded` becomes a wrapper over `raceReject` keeping `SETUP_MS` and its exact message.
   - `handlers/screenshot.js` `withTimeout` becomes `raceReject`.
   - `handlers/evaluate.js:15`, `handlers/inspection.js:31`, `lib/trusted-input.js:31` import `sleep`.
   - Keep every message string byte-identical: it is part of what the agent reads (R5).
3. **`daemon-config.ts`** — replace the four read/create functions with `loadOrCreateSecret(file, field)` + `readSecret(file, field)` and four thin named wrappers that preserve today's signatures. Preserve exactly: 24 random bytes → hex, `mkdirSync(STATE_DIR, {recursive:true, mode:0o700})`, `writeFileSync(..., {mode:0o600})`, `{ [field], createdAt }`, and "invalid file behaves as absent".
4. **Dead export** — delete `extension/lib/vault.js:429 clearInspectionState` (no reference anywhere). Check first that no test imports it (`grep -rn clearInspectionState .`).
5. **Smoke duplicate** — in `scripts/smoke-real-chrome.mjs`, keep whichever of `restartManagedDaemon`/`startManagedDaemon` has call sites; delete the other. Verify call sites before deleting (A5).

**Acceptance.**
```
npm run typecheck && npm test
npx eslint extension/lib/timing.js extension/handlers/screenshot.js extension/lib/cdp-session.js \
  extension/handlers/evaluate.js extension/handlers/inspection.js extension/lib/trusted-input.js \
  mcp-server/src/vault/daemon-routing.ts mcp-server/src/daemon-config.ts extension/lib/vault.js
node docs/audit/tools/extract2.cjs "$PWD" docs/audit/tools    # exactGroups should drop by ≥2
```
Tests must stay at 1,133 (minus any test deleted in step 4 — there should be none).
**Blast radius.** 9 files. **Rollback.** Revert the individual commits; they are independent.
**Effort.** Half a day for all five.

---

## Phase 2 — Boundaries, cycles, names

**Goal.** Remove the two import cycles, put the composition root where it belongs, and stop three modules from sharing one name. No behaviour change.

**Entry condition.** Phase 1 merged.

**Steps, in this order (each its own commit).**

1. **Break the cycles (F5).** New `mcp-server/src/tools/params.ts` holding `parseToolParams`, `payloadLimitsSchema`, `checkPayloadLimits`, `pathText`, `valueAt`, `REQUIRED_HINTS` and the Zod issue formatting — moved verbatim out of `register-tools.ts`. Then a `tools/registry.ts` that builds and exports `toolMap` from a tool list, and `tools/index.ts` imports from it. `batch.ts` imports `parseToolParams` from `params.js` and `toolMap` from `registry.js`.
   - Acceptance for this step alone: the cycle detector reports **0 cycles** (the two listed in `05` F5 are the only ones), `npm test` green, and `register-tools.ts` no longer exports `parseToolParams` publicly unless a test needs it.
2. **Move the router (ADR-05).** `extension/lib/router.js` → `extension/dispatch/router.js`; update 12 handler imports' direction, the background entry, and any test import. If tests may not be edited, stop and take the alternative: document the exception at the top of the file and record the decision in the map.
3. **Rename the vault modules (F10).**
   - `extension/lib/vault.js` → `extension/lib/vault-actions.js`
   - `extension/vault/vault.js` → `extension/vault/vault-page.js`
   - Update every import, `vault.html`'s `<script src>`, and the manifest if it lists the file explicitly (it lists the directory via `web_accessible_resources`).
   - Grep before and after: `grep -rn "lib/vault.js\|vault/vault.js" extension tests`.
   - Do this in one commit with no other change, so a review can confirm it is a pure rename.

**Acceptance.**
```
node docs/audit/tools/extract2.cjs "$PWD" docs/audit/tools    # then: node docs/audit/tools/check-cycles.cjs  → 0 cycles
npm run typecheck && npm test
```
Plus one manual reload of the unpacked extension and one private-vault page open (rename step only).
**Blast radius.** ~20 files, all import paths.
**Rollback.** Per-commit revert. The rename commit must be isolated for exactly this reason.
**Effort.** One day.

---

## Phase 3 — Vault service: composition (ADR-02)

**Goal.** Turn one 75-member inheritance chain into a facade plus named collaborators, one at a time, without changing any behaviour.

**Entry condition.** Phases 1–2 merged; smoke harness either available or explicitly waived in writing (R1).

**Steps. Each is a separate commit and a separate verification.**

1. **`OperationRegistry`** (`vault/operations.ts`) — move `trackOperation`, `completeOperation`, `operationSignal`, `abortOperationsMatching`, `waitForOperationsMatching`, and the `operations` map. Interface: `track(id, meta, parentSignal?, completion?)`, `complete(id)`, `signalFor(id)`, `abortMatching(predicate)`, `waitForMatching(predicate)`.
   - Callers to update: `claimPending`, `cancelRequests`, `cancelScopeOperations`, `cancelCredentialOperations`, `cancelGrantOperations`, `operationSignal`, and `service-private.ts` wherever it reads the map.
   - If this needs more than ~10 call-site edits, stop: the coupling is worse than the audit estimated and the plan needs revisiting.
2. **`GrantRegistry`** (`vault/grants.ts`) — move `grants`, `findGrant`, `createGrant`, and the revoke/consume paths in `service-private.ts` that mutate grants. The `findGrant` predicate is the whole rule; it becomes directly testable.
3. **`RequestJournal`** (`vault/requests.ts`) — move `requests`, `beginRequest`, `requestRequired`, `expireRequests`, `claimPending`, **`settle`**, `cancelRequests`, `requestState`, `revalidatePending`. This is the object the last refactor (`c2b37f6`) was really about.
4. **Facade** — `VaultService` keeps `contextForSession`, `storeFor`, `inspect`, `assertOrigin`, protection state, audit, and delegates to the three collaborators. The `abstract fillGranted` becomes an injected strategy, so `service.ts` can stop existing purely to satisfy the type system.
5. Only if 1–4 are green: fold `service-private.ts` / `service-protection.ts` / `service.ts` into files named by responsibility instead of by subclass level.

**Acceptance for every step.**
```
npm run typecheck && npm test            # 1133 tests, unchanged count
npm run smoke:vault-isolated             # if available
```
Plus a manual vault path: initialise → save → list → approve → fill → protected page → close tab → restore after worker recycle. This is the only phase where "tests pass" is not sufficient evidence (R1).
**Blast radius.** `mcp-server/src/vault/*` (13 files) and any importer of `VaultService` (`daemon.ts`). No extension changes.
**Rollback.** Each collaborator is one commit; revert in reverse order.
**Effort.** 2–3 days. Do not start it in the last hour of a session.

---

## Phase 4 — Bridge and IPC plumbing (ADR-04, F3)

**Goal.** Make the two network-ish classes testable without a socket, and stop the IPC plumbing from existing twice.

**Entry condition.** Phase 2 merged (F5 removed the cycles that make the tool layer fragile). Phase 3 not required but preferred, because both touch `daemon.ts`.

**Steps.**

1. **`bridge/pending-calls.ts`** — extract the pending map from `bridge.ts` (`sendToolCall`'s bookkeeping half, `handleResponse`, `rejectAllPending`, the abort wiring). Interface: `add(id, handlers)`, `settle(id, message)`, `failAll(predicate, error)`, `abort(id)`.
2. **`bridge/admission.ts`** — extract the hello/helloAck judgement: version check, capability check, identity, reject reason. It should be a pure function returning `{ok, reason?, identity?}`; the socket code only transports.
3. **`mcp-server/src/ipc/framing.ts`** — one newline-delimited JSON codec with the size cap, used by both `Daemon.handleNewClient` and `DaemonClient.connect`.
4. **`mcp-server/src/ipc/pending.ts`** — one request table used by both sides' call paths (`Daemon.routeCall` / `sendToClient`, `DaemonClient.callTool` / `failAll`).
5. **Keep separate, on purpose**: `validateIpcHandshake` and the extension validator. The two peers must judge each other independently (`04` C).

**Acceptance.**
```
npm run typecheck && npm test
npm run daemon:start && npm run daemon:status && npm run daemon:stop
```
Plus one end-to-end tool call from an MCP client through the daemon to the extension, and one daemon-restart reconnect.
**Blast radius.** `bridge.ts`, `daemon.ts`, `index.ts`, new `ipc/*`, `bridge-connections.ts` untouched.
**Rollback.** Steps 1–2 are internal to `bridge.ts` and revert cleanly; steps 3–4 touch both sides of a wire, so revert them together.
**Effort.** 2 days.

---

## Phase 5 — Narrow the module surface (F7)

**Goal.** Make the export list mean something: 34 over-exports removed, one dead export already gone in phase 1.

**Entry condition.** Phases 3–4 merged, because they change which symbols are internal anyway.

**Steps.** One commit per area, in this order (least coupled first):

1. `extension/lib/*` — `RESPONSE_WAIT_MS`, `AGENT_CURSOR_KEY`, `WEDGE_PROBE_MS`, `probeResponsive`, `MAX_BODY_CHARS`, `BODY_CAPTURE_PIN`, `CONTROL_LINGER_MS`, `clipText`, `INPUT_BUDGET_MS`, `agentFor`.
2. `extension/handlers/*` — `getActiveTab`, `imageSize`.
3. `mcp-server/src/vault/types.ts` — `VAULT_MAX_ENTRIES`, `VAULT_MAX_PASSWORD_CHARS`, `VAULT_MAX_LABEL_CHARS`, `VAULT_MAX_IDENTIFIER_CHARS`, `originSchema`, `VaultPrivateRequestSchema`, `VaultGrantSchema`, `VaultMetadataSchema`.
4. `mcp-server/src/**` — `identityOf`, `DAEMON_LOCK_FILE`, `DAEMON_LOG_MAX_BYTES`, `MAX_IPC_LINE_BYTES`, `Daemon`, `getSafetySettings`, `payloadOf`, `outcomeOf`, `publicMetadataOf`.
5. `scripts/pairing.mjs` — `browserTargets`, `wrapperScript`, `hostManifest`.

**Rules.** Remove `export` only; never move or rename in this phase. Before each removal: `grep -rn "<name>" . --exclude-dir=node_modules --exclude-dir=.git` and check `llms.txt`, `README.md`, `server.json` (R6). If a symbol is imported by a test, it stays exported (that is the 53 test-only group, and it is legitimate).

**Acceptance.**
```
npm run typecheck && npm test
node docs/audit/tools/extract2.cjs "$PWD" docs/audit/tools   # unusedExports must reach 0
```
**Blast radius.** ~15 files, one-line changes each.
**Rollback.** Per-area revert.
**Effort.** Half a day.

---

## Phase 6 — One source for the policies (ADR-01, B1, B2, F9, F13)

**Goal.** Every rule that exists in two runtimes becomes enforced by a test instead of by a comment.

**Entry condition.** Phase 5 merged (the export surface is now honest). Can be split and interleaved earlier if drift is suspected.

**Steps.**

1. **Protocol parity test** — read `mcp-server/src/protocol.ts` and `extension/lib/protocol.js` as text, extract `PROTOCOL_VERSION` and the capability arrays, compare. Failure message must name both files. No build change.
2. **Origin-policy fixture** — a JSON list of `{origin, acceptedByDaemon, acceptedByExtension, why}` covering: `https://example.com`, `https://example.com/path`, `https://user:pass@example.com`, `http://localhost`, `http://127.0.0.1`, `http://[::1]`, `http://[::ffff:127.0.0.1]`, `ftp://…`, `about:blank`. Each runtime has one test that reads the fixture. This makes the `::ffff:127.0.0.1` divergence a decision instead of an accident.
3. **Decide B1's divergence.** The direction is: the daemon accepts `::ffff:127.0.0.1` as loopback and the
   extension does not, so a page the vault would fill is refused earlier by a shorter list (the extension
   list is the outlier). Pick one: extend the extension's loopback list to match the daemon (recommended —
   one supported set, decided by the stricter trust boundary), or document why they differ. Whichever is
   chosen, the fixture records it.
4. **Fix the catch-all first, then the wording (F13).** In `extension/lib/vault.js`, give the specific
   throws their own codes — origin refusal → `VAULT_ORIGIN_MISMATCH` at minimum — so the blanket
   `safeFailure('VAULT_TARGET_UNSAFE')` at `:596` stops claiming "no verified editable password field"
   for a tab read, a timeout, or an unsupported origin. Note that **no test currently asserts
   `VAULT_TARGET_UNSAFE`** (grep `tests/`), so this change is unguarded in both directions: add the
   assertion for the new mapping in the same commit.
5. **Failure-message parity** — for the shared `VAULT_*` codes, either assert the two tables agree in
   meaning (same text is simplest) or add a comment in both files naming the intentional difference.
   B2's point is that the model reads this text, so a difference must be a decision.
6. **Tool-manifest test (F9)** — assert every name in `allTools` minus the local set
   (`browser_batch`, `browser_safety`) is known to the extension's dispatch. `tests/tools/registry.test.ts`
   already locks the name list and the MCP-side wire-name tagging; it does **not** cross into the
   extension. See the wayfinder ticket *Tool vocabulary: add the cross-runtime assertion*.

**Acceptance.**
```
npm run typecheck && npm test
```
and, if step 1 is done as a text test, deliberately break one constant and confirm the test fails (a test that cannot fail is not evidence).
**Blast radius.** New test files plus, at most, two small production edits (step 3).
**Rollback.** Revert the test files; step 3 is a two-line change.
**Effort.** One day.

---

## Phase 7 — Conditional: page-script bundling (ADR-03)

**Do not start this without the wayfinder decision.**

It is listed as a phase only so it is not lost: it is the only way to fix `PAGE_DOM_INSTALL` (904 lines, complexity 484), `pageLocate` (152), `PAGE_FALLBACK_INSTALL` (76) and the `collect`/`visible` pair — and it changes the extension's build story, which is a product decision, not a refactor.

**Entry condition.** The wayfinder ticket *"Page scripts: bundle or keep"* is resolved.
**Acceptance, if adopted.** One injected script is converted first (`smart-selector` is the smallest), the extension still loads unpacked, and the existing page-behaviour tests pass unchanged.
**Effort.** 2–3 days for the mechanism, then per-script.

---

## Verification kit

Reusable for every phase. All read-only apart from the gitignored JSON the extractor writes into `docs/audit/tools/`.

| Check | Command | Expected |
|---|---|---|
| Types | `npm run typecheck` | clean |
| Lint (touched files) | `npx eslint <files>` | clean |
| Tests | `npm test` | 89 files / 1,133 tests (count may only grow) |
| Structure | `node docs/audit/tools/extract2.cjs "$PWD" docs/audit/tools` | `parseFailures 0`; `exactGroups` decreasing; `unusedExports` decreasing |
| Cycles | `node docs/audit/tools/check-cycles.cjs` | 0 after phase 2 (2 before) |
| Inventory refresh | `node docs/audit/tools/gen-inventory.cjs docs/audit` | row count still 1,110 production symbols |
| Vault behaviour (phase 3) | `npm run smoke:vault-isolated` + manual vault path | unchanged |
| Daemon round-trip (phase 4) | `npm run daemon:start`, `daemon:status`, `daemon:stop` | session visible, then gone |

**Stop rule used in this plan.** A phase that needs changes outside its declared blast radius, or that needs more than ~10 call-site edits in one commit, is a signal that the audit's model of that area is wrong. Stop, re-read the area, and re-plan rather than pushing through.
