# Tasks: Authenticate the Local Daemon

**Input**: Design documents from /specs/002-daemon-authentication/

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, and contracts/

**Tests**: Required by the feature's security acceptance criteria. Add regression tests before changing the behavior; do not weaken existing assertions.

**Organization**: Tasks are grouped by user story. Cross-cutting cryptographic helpers are foundational and must be complete before the stories.

## Phase 1: Foundational

**Purpose**: Define and test the canonical proof helpers used by both runtimes.

- [ ] T001 [P] Add daemon proof, challenge expiry, capacity, and one-use tests in tests/bridge-auth.test.ts.
- [ ] T002 [P] Add browser HMAC, random nonce, authenticated request, and response-verification tests in tests/extension-daemon-auth.test.ts.
- [ ] T003 Implement canonical transcripts, HMAC verification, bounded challenge storage, and response signing in mcp-server/src/bridge-auth.ts.
- [ ] T004 Implement Web Crypto transcript helpers and authenticated HTTP client behavior in extension/lib/daemon-auth.js.

## Phase 2: User Story 1 - Trust the daemon before browser control (Priority: P1)

**Goal**: The extension accepts no daemon greeting or control frame until the daemon is authenticated; the daemon accepts no extension until its proof is valid.

**Independent Test**: A fake listener with a protocol-shaped greeting cannot trigger an acknowledgement, state adoption, or browser handler. A paired peer completes the new handshake.

### Tests for User Story 1

- [ ] T005 [P] [US1] Add protocol-version, altered-proof, missing-proof, and valid-proof cases in tests/protocol-handshake.test.ts.
- [ ] T006 [P] [US1] Add fake-daemon and pre-auth dispatch rejection cases in tests/extension-connection-handshake.test.ts, tests/bridge-multibrowser.test.ts, tests/bridge-vault.test.ts, and tests/wp6-browser-default.test.ts.

### Implementation for User Story 1

- [ ] T007 [US1] Add version 2 authentication transcripts and proof construction/validation in mcp-server/src/protocol.ts and extension/lib/protocol.js.
- [ ] T008 [US1] Require first-frame authInit, authenticate the extension proof, and gate all pending-socket frames in mcp-server/src/bridge.ts and mcp-server/src/bridge-connections.ts; adapt authenticated bridge fixtures in tests/bridge-multibrowser.test.ts, tests/bridge-vault.test.ts, and tests/wp6-browser-default.test.ts.
- [ ] T009 [US1] Generate a fresh client nonce and verify daemon proof before state adoption, hello acknowledgement, or message handling in extension/lib/connection.js.

## Phase 3: User Story 2 - Pair and manage the trusted daemon safely (Priority: P1)

**Goal**: Pairing and popup management use a verified, replay-resistant HTTP exchange without transmitting the enrollment secret or raw token.

**Independent Test**: Forged /pair, /status, and /kill responses are rejected; a matching daemon completes each operation and updates UI/storage only after response verification.

### Tests for User Story 2

- [ ] T010 [P] [US2] Add valid, forged, altered-body/status, expired, and replayed HTTP challenge tests in tests/bridge-http-auth.test.ts.
- [ ] T011 [P] [US2] Update automatic pairing regressions to prove no raw enrollment header is sent and token storage requires a valid response proof in tests/extension-native-pairing.test.ts.

### Implementation for User Story 2

- [ ] T012 [US2] Add the public challenge route, single-use request verification, response signing, and protected-route gating in mcp-server/src/bridge.ts.
- [ ] T013 [US2] Replace raw-secret HTTP calls and verify daemon proofs before consuming /pair, /status, or /kill results in extension/lib/connection.js and extension/popup/popup.js.
- [ ] T014 [US2] Keep endpoint and credential-boundary documentation aligned with the authenticated contract in mcp-server/src/daemon.ts and SECURITY.md.

## Phase 4: User Story 3 - Diagnose port conflicts without trusting the port owner (Priority: P2)

**Goal**: Port ownership is recognized only after daemon proof verification; unknown listeners remain untouched.

**Independent Test**: A fake server cannot be classified as the daemon and receives no raw secret; a real test bridge validates and is identified.

### Tests for User Story 3

- [ ] T015 [P] [US3] Add genuine/fake listener coverage for authenticated port-conflict detection in tests/bridge.test.ts.
- [ ] T016 [P] [US3] Add lifecycle probe coverage for invalid signatures and successful authenticated status in tests/daemon-lifecycle.test.mjs.

### Implementation for User Story 3

- [ ] T017 [US3] Use the shared authenticated HTTP client when probing a port after EADDRINUSE in mcp-server/src/bridge-security.ts.
- [ ] T018 [US3] Authenticate /status responses before lifecycle decisions in scripts/daemon.mjs.

## Phase 5: Polish and cross-cutting verification

- [ ] T019 Update supported protocol and trust-boundary documentation in SECURITY.md and extension/lib/protocol.js.
- [ ] T020 Run focused and full validation from specs/002-daemon-authentication/quickstart.md, inspect the final diff, and record actual results in specs/002-daemon-authentication/verification.md.

## Dependencies & Execution Order

- Foundational T001-T002 establish regression expectations; T003-T004 implement the runtime-local helpers.
- User Story 1 follows the helper phase. T005-T006 precede T007-T009; daemon and extension handshake changes are coordinated, with server gating completed before client activation.
- User Story 2 tests T010-T011 precede T012-T014. It depends on the authenticated protocol helpers but can be tested separately from WebSocket routing.
- User Story 3 tests T015-T016 precede T017-T018 and reuse the HTTP challenge contract.
- T019-T020 run after all behavior changes. User stories are implemented sequentially because they share bridge and extension files.

## Parallel Opportunities

- T001 and T002 are independent test files; T005 and T006 are independent protocol and extension test files; T010 and T011 are independent HTTP and pairing test files; T015 and T016 are independent test files.
- Implementation tasks that touch the same bridge or extension connection file must remain sequential.

## Implementation Strategy

Complete the helper tests and implementations first, then deliver the WebSocket trust boundary (P1), the HTTP pairing/management boundary (P1), and the daemon probe boundary (P2). Run each story's focused tests before continuing, then run the full suite, lint, typecheck, build, and an independent read-only review.
