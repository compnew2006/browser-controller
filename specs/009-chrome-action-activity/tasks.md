# Tasks: Chrome action activity

**Input**: Design documents from specs/009-chrome-action-activity/

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, quickstart.md, and specs/contracts/chrome-action-activity.schema.json

**Authorization**: The Owner previewed the plan and said “نفذ الخطة” on 2026-11-09. Local implementation is authorized. The reviewer-owned requirements checklist remains unchecked, and independent CONTROLLED review is still required before formal acceptance.

## Phase 1: Setup

**Purpose**: Establish the internal activity contract and test fixtures.

- [x] T001 Add contract validation fixtures for ActionEvent and BatchFinished in tests/extension-activity-log.test.ts.
- [x] T002 Add test helpers for isolated chrome.storage.session behavior in tests/extension-activity-log.test.ts.

## Phase 2: Foundational

**Purpose**: Define stable activity context and source-page visit identity before story implementation.

- [x] T003 [P] Add the bounded event store, current-visit map, deduplication, and storage queue in extension/lib/activity-log.js.
- [x] T004 Add top-frame pageVisitId creation and restoration in extension/events.js and extension/lib/activity-log.js.
- [x] T005 Extend the internal protocol capability and finish-marker schema in mcp-server/src/protocol/capabilities.ts, mcp-server/src/protocol/frames.ts, extension/lib/generated-contract.js, and specs/contracts/chrome-action-activity.schema.json.

## Phase 3: User Story 1 — See page actions (Priority: P1)

**Goal**: Capture only actual dispatched page actions and group batch children accurately.

**Independent Test**: Three separate browser_batch calls with four actual click calls produce three distinct groups and four action events, with no internal or duplicate events.

### Tests for User Story 1

- [x] T006 [P] [US1] Add batch event-ID and actual-child metadata tests in tests/tools/batch.test.ts.
- [x] T007 [P] [US1] Add targeted batch-finish and participant-isolation tests in tests/bridge.test.ts.
- [x] T008 [P] [US1] Add dispatch filtering and event deduplication tests in tests/extension-router.test.ts and tests/extension-activity-log.test.ts.

### Implementation for User Story 1

- [x] T009 [US1] Pass immutable per-child activity metadata and a stable batchRunId through mcp-server/src/tools/types.ts and mcp-server/src/tools/batch.ts.
- [x] T010 [US1] Track live extension participant connections and send a bounded batch-finished marker in mcp-server/src/bridge.ts.
- [x] T011 [US1] Record public action dispatches and ignore daemon-only probes in extension/dispatch/router.js and extension/lib/activity-log.js.
- [x] T012 [US1] Capture resolved control labels, click target DOM ids, and explicit input counts/statuses at the dispatch boundary in extension/handlers/interaction.js, extension/handlers/interaction-advanced.js, and extension/lib/trusted-input.js.
- [x] T013 [US1] Apply batch-finished markers only to matching actual event groups in extension/dispatch/router.js.

## Phase 4: User Story 2 — Find activity by page visit (Priority: P2)

**Goal**: Keep bounded activity across tab closure and associate each event with the document that received it.

**Independent Test**: A click remains on its source visit after navigation, SPA history stays in the same visit, and a closed tab's activity remains through a worker restart.

### Tests for User Story 2

- [x] T014 [P] [US2] Add host-only visit, SPA/document rotation, tab-close, worker-restart, 500-event trim, and incomplete-group store tests in tests/extension-activity-log.test.ts.

### Implementation for User Story 2

- [x] T015 [US2] Persist event and visit state through extension/lib/activity-log.js and extension/events.js; event writes are fire-and-forget from dispatch.

## Phase 5: User Story 3 — Honest, private popup status (Priority: P3)

**Goal**: Render useful grouped history with clear status, privacy, clear, truncation, and accessible states.

**Independent Test**: The owner can understand a confirmed, partial, refused, and unknown input, the resolved click DOM id and count; hide element details and clear the log; keyboard navigation works in English LTR.

### Tests for User Story 3

- [x] T016 [P] [US3] Add grouped renderer, click id/count, status, privacy, escaping, loading/empty/error, truncation, and incomplete-batch tests in tests/popup-activity.test.ts; popup controls and keyboard are exercised in T021.

### Implementation for User Story 3

- [x] T017 [US3] Add the Actions view and status/privacy controls in extension/popup/popup.html and extension/popup/popup.js.
- [x] T018 [US3] Implement grouped event rendering and incomplete batch indicators in extension/popup/activity-view.js.

## Phase 6: Polish and cross-cutting checks

**Purpose**: Verify compatibility, update evidence, and complete independent review.

- [x] T019 [P] Update specs/features/chrome-action-activity.md, specs/features/README.md, specs/contracts/README.md, and specs/evidence/chrome-action-activity/manifest.json with implementation evidence.
- [x] T020 Run focused suites and repository checks from specs/009-chrome-action-activity/plan.md; record exact results in the evidence manifest.
- [ ] T021 Run the isolated Playwright walkthrough from specs/009-chrome-action-activity/quickstart.md and record the tested URL and outcomes.
- [ ] T022 Obtain an independent CONTROLLED review of the complete diff and fix findings before reporting formal acceptance.
- [x] T023 [US3] Show each click's resolved DOM id and confirmed/requested click count; erase ids with labels when element details are hidden.

## Dependencies and execution order

- T001–T005 establish the contract, fixtures, and identity model.
- User Story 1 depends on T003 and T005; T006–T008 precede T009–T013.
- User Story 2 depends on T003–T004 and can begin after the foundational phase.
- User Story 3 depends on the event contract and store; T016 precedes T017–T018.
- T019–T022 follow implementation. The independent review and CI/Owner gates are required for formal acceptance.

## Implementation strategy

Implementation slices T001–T020 and T023 are locally complete. The full isolated extension walkthrough, independent CONTROLLED review, and formal acceptance remain open; do not mark T021–T022 complete until their recorded evidence satisfies the full task descriptions.
