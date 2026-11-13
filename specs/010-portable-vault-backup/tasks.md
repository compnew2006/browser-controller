# Tasks: Encrypted Portable Credential Vault Backup

**Input**: Design documents in `/specs/010-portable-vault-backup/`

**Prerequisites**: `plan.md`, `spec.md`, `research.md`, `data-model.md`, `contracts/vault-portable.md`, `quickstart.md`

**Tests**: Included because the repository instructions require regression coverage for vault storage, private protocol, timeouts, and credential redaction. Write each regression before its implementation and observe the expected failure when practical.

**Organization**: Tasks follow the three P1 user stories in `spec.md`. The feature adds no package, extension permission, storage directory, public MCP tool, or schema migration.

## Format: `[ID] [P?] [Story?] Description`

- **[P]**: Work can run in parallel because it uses a different file and has no unmet task dependency.
- **[Story]**: User story served by the task (`US1`, `US2`, or `US3`).
- Every implementation or test task names its exact file path.

## Phase 1: Setup

**Purpose**: Prepare project scaffolding.

The existing Node.js/Chrome MV3 project, test runner, vault folders, and manifest already provide the required setup. No setup changes are needed; leave `package.json`, lockfiles, and `extension/manifest.json` unchanged.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Implement the portable archive format and bounded private transfer path required by export and import.

- [x] T001 [P] Add round-trip and portable-field projection tests in `tests/vault-portable-format.test.ts`; assert the archive omits source IDs, namespace, local key, audit, and grants, and observe the expected failure before T003.
- [x] T002 [P] Add private transfer contract tests for 256 KiB chunks, canonical base64, sequential offsets, 10 MiB size, per-connection ownership, and daemon-wide memory limits in `tests/bridge-vault.test.ts`.
- [x] T003 Implement the strict v1 archive schema, portable data projection, fixed-profile async scrypt/AES-256-GCM encryption and decryption, authenticated format metadata, and buffer cleanup in `mcp-server/src/vault/portable-format.ts` (depends on T001).
- [x] T004 Implement bounded export/import chunk sessions and expiry/connection ownership handling in `mcp-server/src/vault/portable-transfers.ts` and route private requests/cleanup in `mcp-server/src/vault/bridge-transport.ts` (depends on T002).

**Checkpoint**: The format and private transfer contract are ready; story work can proceed.

---

## Phase 3: User Story 1 - Export a portable vault copy (Priority: P1)

**Goal**: Let an unlocked vault owner export accounts and always-allowed sites into a passphrase-protected portable file.

**Independent Test**: Export a synthetic vault through the private vault page; verify a protected file is produced, excludes local-only data, and can be read by the portable archive parser.

### Tests for User Story 1

- [x] T005 [P] Add a consistent unlocked-store snapshot test that returns accounts and allowlist without audit data in `tests/vault-store.test.ts`.
- [x] T006 [P] Add private export service tests for locked/unavailable vaults, included/excluded data, and secret-free responses in `tests/vault-service.test.ts`.

### Implementation for User Story 1

- [x] T007 Add an atomic portable-data snapshot method to `mcp-server/src/vault/store.ts` (depends on T005).
- [x] T008 Implement private `portableExportStart` and `portableExportChunk` operations using T003, T004, and T007 in `mcp-server/src/vault/service-private.ts` (depends on T003, T004, T006, and T007).
- [x] T009 Add export controls and summary in `extension/vault/vault.html`, portable export/passphrase/chunk/download handling in `extension/vault/portable-vault-page.js`, vault-state integration in `extension/vault/vault-page.js`, and responsive progress/cancel styling in `extension/vault/vault.css` (depends on T008).

**Checkpoint**: Export works through the private vault UI and produces only the protected archive.

---

## Phase 4: User Story 2 - Import into another profile (Priority: P1)

**Goal**: Preview a valid portable file and, after explicit confirmation, replace the destination accounts and allowlist safely.

**Independent Test**: Import a synthetic valid archive into a second isolated browser identity; verify preview does not mutate data, confirmation replaces account/site data, local audit history remains local, and a local recovery snapshot can restore the previous state.

### Tests for User Story 2

- [x] T010 [P] Add store replacement tests for valid and empty destinations, snapshot creation, audit retention, local size preflight, recovery journal, and incomplete-state refusal in `tests/vault-store.test.ts`.
- [x] T011 [P] Add private import preview/commit tests for counts-only preview, passphrase re-entry, explicit commit, and unchanged destination before commit in `tests/vault-service.test.ts`.

### Implementation for User Story 2

- [x] T012 Implement destination replacement in `mcp-server/src/vault/store.ts`: validate the candidate envelope against the existing 8 MiB cap, snapshot the prior or empty state, preserve destination audit within its retention limit, and commit with the existing recovery journal (depends on T010).
- [x] T013 Implement private import upload completion, preview token, re-decryption/revalidation at commit, fresh destination IDs, audit retention, and grant revocation in `mcp-server/src/vault/service-private.ts` (depends on T003, T004, T011, and T012).
- [x] T014 Add file selection and accessible preview/confirmation structure in `extension/vault/vault.html`, archive upload/preview/re-entry/commit handling in `extension/vault/portable-vault-page.js`, refresh integration in `extension/vault/vault-page.js`, and responsive confirmation/completion styling in `extension/vault/vault.css` (depends on T013).

**Checkpoint**: A valid file can be previewed and imported into a separate profile with a recoverable destination state.

---

## Phase 5: User Story 3 - Recover safely from invalid or interrupted imports (Priority: P1)

**Goal**: Reject invalid archives and interrupted transfers without exposing secrets or leaving a partial vault.

**Independent Test**: Against isolated synthetic vaults, try wrong passphrases, altered/truncated/unsupported/oversized files, invalid data, cancellation, timeout, and connection loss; verify the old vault remains intact or recovery reports a complete pending state.

### Tests for User Story 3

- [x] T015 [P] Add rejection tests for wrong passphrase, tampering, truncation, unsupported format/KDF, duplicate records, and invalid origins in `tests/vault-portable-format.test.ts`, plus destination-size overflow in `tests/vault-store.test.ts`.
- [x] T016 [P] Add cancellation, UI-close, expiry, disconnect, wrong-offset, public-surface, and secret-free-log regression tests in `tests/bridge-vault.test.ts` and `tests/vault-service.test.ts`.

### Implementation for User Story 3

- [x] T017 Make preview/commit and recovery failures fail closed, ensure transfer buffers are cleared on every terminal path, and verify no agent-facing result or log includes passphrases or credentials in `mcp-server/src/vault/service-private.ts` and `mcp-server/src/vault/bridge-transport.ts` (depends on T015 and T016).
- [x] T018 Complete accessible loading, disabled, cancel, invalid-file, wrong-passphrase, storage-limit, and recovery-required UI states; clear password inputs and revoke temporary Blob URLs in `extension/vault/portable-vault-page.js`, with semantic labels in `extension/vault/vault.html` and states in `extension/vault/vault.css` (depends on T017).

**Checkpoint**: All rejection and interruption paths preserve complete prior/imported state and clear sensitive transfer buffers.

---

## Phase 6: Polish & Cross-Cutting Verification

**Purpose**: Validate the complete feature and record reproducible evidence.

- [ ] T019 Run the relevant vault suites, `npm run lint`, `npm run typecheck`, `npm run build`, `npm run test:coverage`, `npm run security:audit`, `npm run context:lint`, `npm run context:measure`, and `npm run arch:check`; record actual outcomes in `specs/010-portable-vault-backup/quickstart.md` (depends on T018).
- [x] T020 Use Playwright with an isolated extension profile and synthetic vault data to review export/import, preview/cancel/error/success states, keyboard focus, narrow layout, and English LTR rendering; record the tested page and results in `specs/010-portable-vault-backup/quickstart.md` (depends on T018).

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No code setup is required.
- **Foundational (Phase 2)**: Archive format and transfer handling block all user stories.
- **User Story 1 (Phase 3)**: Starts after T003 and T004; its store/export tests precede their implementations.
- **User Story 2 (Phase 4)**: Starts after the shared foundation and follows US1 delivery order; it can be tested with a synthetic archive fixture rather than the export UI.
- **User Story 3 (Phase 5)**: Starts after export and import paths exist; adds adversarial and lifecycle coverage before final hardening.
- **Polish (Phase 6)**: Starts after all stories.

### User Story Dependencies

- **US1 (P1)**: Depends on the portable format and transfer foundation; provides the first export increment.
- **US2 (P1)**: Depends on the same foundation and store replacement support. Its parser/commit path can use a synthetic fixture, but the full portability outcome requires US1 and US2 together.
- **US3 (P1)**: Exercises and hardens the complete US1/US2 flow; required before calling the feature complete.

### Task Dependency Graph

```text
T001 -> T003 ─┐
              ├-> US1: (T005 -> T007) + (T006 -> T008 -> T009)
T002 -> T004 ─┘                         |
                                        v
US2: (T010 -> T012) + (T011 -> T013 -> T014)
                                        |
                                        v
US3: (T015 + T016) -> T017 -> T018 -> (T019 + T020)
```

### Parallel Opportunities

- **Foundational**: T001 and T002 touch separate test files and can be authored in parallel. Their implementations T003 and T004 follow their own tests.
- **US1**: After T002/T004, T005 and T006 can be authored in parallel because they cover separate store and service test files.
- **US2**: T010 and T011 can be authored in parallel because they cover separate store and service test files; each implementation follows its corresponding tests.
- **US3**: T015 and T016 use separate portable-format/service/store versus bridge/service cases; avoid editing the same test file concurrently if splitting work.
- The service, bridge, and UI implementation tasks are sequential because each builds on the preceding contract and transfer behavior.

## Parallel Example: User Story 1

```text
Task T005: Add store snapshot tests in tests/vault-store.test.ts
Task T006: Add private export tests in tests/vault-service.test.ts
```

## Parallel Example: User Story 2

```text
Task T010: Add replacement/recovery tests in tests/vault-store.test.ts
Task T011: Add private preview/commit tests in tests/vault-service.test.ts
```

## Parallel Example: User Story 3

```text
Task T015: Add archive validation and store-size rejection tests in the portable-format and vault-store suites
Task T016: Add transfer lifecycle/redaction tests in bridge-vault and vault-service suites
```

## Implementation Strategy

1. Build the archive and private chunk foundation, with tests first.
2. Deliver the export slice (US1) and verify it with synthetic data.
3. Deliver import preview and transactional replacement (US2); treat US1 + US2 as the first complete portability increment.
4. Complete the rejection/interruption hardening (US3) before considering the feature done.
5. Run the required project checks and isolated Playwright review; do not use real credentials or the owner's normal Chrome profile.
