# Tasks: خزنة تسجيل الدخول بطريقة Hermes

**Input**: [spec.md](spec.md), [plan.md](plan.md), [research.md](research.md), [data-model.md](data-model.md), [contracts/vault.md](contracts/vault.md), [quickstart.md](quickstart.md).  
**Execution**: GPT-6 Luna xhigh owns implementation. User explicitly authorized this model and delegation. Shared repository; preserve other edits, especially existing `.codebase-memory` files.  
**Tests**: Required for this credential-handling change and specified acceptance scenarios. Checkmarks represent actual completed work, not intention.

## Phase 1: Setup

- [x] T001 Read applicable instructions and Impeccable before UI changes; verify exact imported callers/wire registries for `mcp-server/src/daemon.ts`, `bridge.ts`, `register-tools.ts`, `tools/index.ts` and `extension/lib/router.js`; record newly affected files in `plan.md`.
- [x] T002 Add a temporary-state/fixture testing seam using existing patterns in `tests/` and map FR/SC coverage in `verification.md`, which now records actual evidence and remaining acceptance gaps.

## Phase 2: Foundation

- [x] T003 Add strict vault entities/envelope/private operation schemas in `mcp-server/src/vault/types.ts` and meaningful validation tests in `tests/vault-contracts.test.ts`.
- [x] T004 Implement authenticated encryption, protected local key, namespace-safe paths, bounded parsing, locking and atomic storage in `mcp-server/src/vault/store.ts` and `store-format.ts`; cover temp-file secrecy, invalid key/envelope and write/concurrency failures in `tests/vault-store.test.ts`.
- [x] T005 Implement per-browser secret redaction and lifecycle rules in `mcp-server/src/vault/redaction.ts`; cover nested errors/results, normalized/short/Unicode/overlapping values in `tests/vault-redaction.test.ts`.
- [x] T006 Implement grants, private pending requests, context binding/expiry and sanitized service operations across `service.ts` and its focused modules; cover authorization and no delayed/replayed writes in `tests/vault-service.test.ts`.

## Phase 3: US1 — fill a saved login

- [x] T007 [US1] Add strict public handle-only tool in `mcp-server/src/tools/vault.ts`, register in `tools/index.ts`, and update manifest/registry tests without exposing internal wire actions.
- [x] T008 [US1] Route vault calls through the daemon service and dedicated one-shot extension messages in `mcp-server/src/daemon.ts`, `vault/daemon-routing.ts`, `bridge.ts`, `vault/bridge-transport.ts` and protocol/types; keep raw values out of MCP/IPC params/history and update transport tests.
- [x] T009 [US1] Implement inspected nonce-bound current-password fill in `extension/lib/vault.js`, routed through `extension/lib/router.js`, using isolated-world document-targeted scripts, tab ownership/mutex and cancellation; reject stale/ambiguous/cross-origin targets and cover in `tests/extension-vault.test.ts` and `tests/extension-router.test.ts`.

## Phase 4: US2 — private entry and management

- [x] T010 [US2] Add authenticated private UI RPC between `mcp-server/src/bridge.ts`, `vault/bridge-transport.ts`, vault service, `extension/lib/vault-connection.js`, `extension/lib/connection.js` and `extension/events.js`; exact extension-page sender checks and safe errors are covered.
- [x] T011 [US2] Add extension-owned masked add/update/remove, grants, lock/unlock and pending-request interface in `extension/vault/`, with an entry from `extension/popup/`; follow Impeccable and preserve existing design/accessibility.
- [x] T012 [US2] Cover cancellation, expiry, headless refusal, no held tab mutex and no secret storage/reflection in `tests/vault-service.test.ts` and `tests/extension-vault.test.ts`; record rendered UI verification in `verification.md`.

## Phase 5: US3 — protected document outputs

- [x] T013 [US3] Implement persistent non-secret document taint and lifecycle handling in `extension/lib/vault.js`, `extension/events.js` and `extension/lib/router.js`; gate evaluation, screenshots, mocks and raw logs profile-wide while protected/recovery contexts exist, including restored contexts and the extension vault UI.
- [x] T014 [US3] Sanitize every public daemon result/error/batch reply before IPC in `mcp-server/src/vault/daemon-routing.ts`; cover output paths in `tests/vault-redaction.test.ts`, `tests/vault-service.test.ts`, `tests/daemon.test.ts` and wrapper tests. Prevent `browser_fill` from uploading the canonical vault tree or symlink aliases. Fail closed after protection loss and avoid diagnostic leaks.
- [x] T015 [US3] Cover reveal-password screenshots, evaluate side-effect prevention, nested batch calls, SPA/hash/BFCache, worker/daemon recycle and lock/delete protection in `tests/extension-vault.test.ts`, `tests/extension-router.test.ts`, `tests/extension-shield.test.ts` and `tests/wp5-network-events.test.ts`.

## Phase 6: US4 — profile/session isolation

- [x] T016 [US4] Bind scope/grants to verified connections and live sessions in `mcp-server/src/vault/service-protection.ts`, `bridge-connections.ts` and daemon cleanup hooks; revoke on session end/profile switch and reject ambiguous duplicate browser identity.
- [x] T017 [US4] Verify browser scopes, sessions, colliding tab IDs, foreign handles and metadata privacy in `tests/vault-service.test.ts` and `tests/bridge-vault.test.ts` using existing multi-browser patterns.

## Phase 7: US5 — recovery

- [x] T018 [US5] Implement private backup/list/explicit restore and safe locked/corrupt/missing-key recovery in `store.ts`, `store-format.ts`, vault service and `extension/vault/`; never expose raw backup/key content to MCP.
- [x] T019 [US5] Verify interrupted writes, concurrent writes/restore, ownership/symlink, unsupported versions, no silent reset and unknown fill outcomes in `tests/vault-store.test.ts`, service/transport tests.

## Phase 8: Verification and documentation

- [x] T020 Run actual MCP fixture acceptance and timing scenarios from `quickstart.md`, using isolated state/profile only; add `scripts/smoke-vault-isolated.mjs` and record real SC results in `verification.md`.
- [x] T021 Run targeted tests then `npm test`, `npm run typecheck`, `npm run build`, `npm run lint`; diagnose/fix failures and record actual results in `verification.md`.
- [x] T022 Document setup, supported actions, encrypted-local-key limitations, scope of protection and deferred features in `README.md` and `SECURITY.md`; review the final diff and refresh code knowledge through supported mechanisms while preserving pre-existing `.codebase-memory` changes.

## Dependencies and execution order

Setup -> foundation -> US1 transport/fill -> US2 private UI -> US3 output protection -> US4 isolation -> US5 recovery -> full fixture/regression review. US1 is independently testable with a synthetic pre-provisioned store, but must not be released without US2–US5 security gates. Any failing requirement remains incomplete and is reported.

Store/redaction pure tests can be prepared independently after types; UI styling work can be done after the private contract is stable. Execution is assigned to one Luna worker to avoid overlapping edits; no additional parallel agents are required.

## Spec Kit workflow note

The repository has existing `specs/` but no `.specify/` bootstrap. Installed templates/scripts were used. For installed scripts that require a numeric branch, set the task-local `SPECIFY_FEATURE=001-credential-vault`; the actual Git branch uses the app-required `codex/` prefix. Root client instruction files and a new constitution are not generated.
