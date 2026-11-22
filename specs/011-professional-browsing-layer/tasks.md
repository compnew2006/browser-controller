# Tasks: Professional Browsing Layer

**Input**: Design documents in `/specs/011-professional-browsing-layer/` (`spec.md`, `plan.md`)

**Prerequisites**: `PRODUCT.md` (popup mode Operate, dark zinc + indigo identity), `spec.md`, `plan.md`

**Tests**: Write each regression before its implementation and observe the expected failure first (TDD). Task tests live under `tests/tasks/`; UI checks use `impeccable shot` at the shipped sizes and the mechanical detector once at the end.

**Organization**: Tasks follow the seven Design sections in `spec.md`. The feature adds no package, extension permission, or remote service. File paths are exact where the Design fixes them; elsewhere the task names the module directory and the implementer picks the file inside it.

## Format: `[ID] [P?] [Story?] Description`

- **[P]**: Work can run in parallel because it uses a different file and has no unmet task dependency.
- **[Story]**: User story served by the task (`US1`–`US7` in `spec.md`).
- Every implementation or test task names its exact file path or module directory.

## Phase 0: Foundations

**Purpose**: Product context and the spec every later task argues from. (This task.)

- [x] T000 [US1–US7] Write `PRODUCT.md` (popup mode Operate, dark zinc + indigo identity, assumptions labelled) via `impeccable context` + `init`, and `specs/011-professional-browsing-layer/spec.md`, `plan.md`, `tasks.md` from the Design section; guard with `tests/tasks/foundations.test.ts` (`test_product_md_declares_operate_mode`).

## Phase 1: Task Engine Core — Types and Store

**Purpose**: The task model and state machine the whole layer stands on (Design §1).

- [ ] T001 [P] [US1] Add failing-first tests in `tests/tasks/engine.test.ts`: task states `planned → running → paused-question | paused-login → done | failed`; a step advances only after its verification succeeds or its failure is recorded with evidence.
- [ ] T002 [US1] Implement the task types in `mcp-server/src/tasks/types.ts`: `TaskState`, `TaskStep { tool, params, verify, result? }`, `Task { id, goal, constraints, steps, state, evidence }`.
- [ ] T003 [US1] Implement the task store in `mcp-server/src/tasks/` (storage location decided here: daemon memory or local state files, no external service): create/read/update task records and append evidence entries.
- [ ] T004 [US1] Implement the engine step loop in `mcp-server/src/tasks/`: dispatch each step through the tools registered in `mcp-server/src/tools/registry.ts`, pass every result through the verifier (Phase 3), and record the step result before advancing.

## Phase 2: Session & Login Agent

**Purpose**: Detect session state per `(profile, origin)` and pause/resume on expiry without losing progress (Design §2).

- [ ] T005 [P] [US2] Add failing-first tests in `tests/tasks/session.test.ts`: states `unknown | logged-in | login-page | warning-page | expired`; an http security-warning page is classified `warning-page`, never a login page or a successful target; expiry pauses and takeover resumes from the same step.
- [ ] T006 [US2] Implement session detection in `mcp-server/src/tasks/`: match the known login URL from site knowledge (008), or a login form (007), or a redirect to a login page.
- [ ] T007 [US2] Implement the `expired` path: pause the task in `paused-login`, request user takeover, re-check the page after login, and resume from the same step; build on `006-vault-site-approval` for fill approvals.

## Phase 3: Verifier

**Purpose**: Read the page after every mutating step and fail loudly with evidence; navigation success alone is never success (Design §3).

- [ ] T008 [P] [US3] Add failing-first tests in `tests/tasks/verifier.test.ts`: rules `url-contains`, `text-present`, `element-count`, `no-error-text`; an error-text or empty page returns `VERIFY_FAILED` with URL, snapshot reference, and observed text.
- [ ] T009 [US3] Implement the verifier in `mcp-server/src/tasks/`: read snapshot + text after each mutating step, apply the verify rules, return `VERIFY_FAILED` with evidence on failure.

## Phase 4: Evidence Report

**Purpose**: Five fixed sections, literal values, compact text + structured JSON, saved in the task record (Design §4).

- [ ] T010 [P] [US4] Add failing-first tests in `tests/tasks/evidence.test.ts`: a finished task report contains ما تم فحصه، والقيم التي وُجدت، والمصادر، وما بقي غير مؤكد، وما لم يُتحقق منه; values match the step record literally.
- [ ] T011 [US4] Implement the report generator in `mcp-server/src/tasks/`: emit compact text + structured JSON and save it in the task record.

## Phase 5: Question Protocol

**Purpose**: Reach the user with a popup card outside a blocked tab and resume at the same step (Design §5).

- [ ] T012 [P] [US5] Add failing-first tests in `tests/tasks/questions.test.ts`: a question `{ id, taskId, text, options?, kind }` pauses the task in `paused-question`; an answer resumes it in `running` from the same step; no question is asked for a choice that does not change the outcome.
- [ ] T013 [US5] Implement the question path in `mcp-server/src/tasks/` and the popup side in `extension/popup/popup.html` (with `popup.js`): send the question over WebSocket to the extension, render it as a card outside the blocked tab, and return the answer to the engine.

## Phase 6: Recovery Policy

**Purpose**: Bounded retries, immediate stops, and no double execution of unknown-outcome actions (Design §6).

- [ ] T014 [P] [US6] Add failing-first tests in `tests/tasks/recovery.test.ts`: `RetryPolicy { maxAttempts: 3, backoffMs: [500, 1500, 4000], retryableCodes: ["TIMEOUT", "TAB_FROZEN", "NETWORK"] }`; `429`, rate limit, permission denial, and `TAB_LOCKED` stop immediately; an unknown-outcome action is state-checked before any repeat.
- [ ] T015 [US6] Implement the recovery policy in `mcp-server/src/tasks/`: apply the retry budget and backoff, stop immediately on the stop list, and re-read state before repeating an unknown-outcome action.

## Phase 7: MCP Task Tools + Wiring

**Purpose**: Expose the layer to paired agents through the registered tools and wire the engine, session agent, verifier, and recovery together (Design §1–§6).

- [ ] T016 [US1–US6] Register the task tools in `mcp-server/src/tools/registry.ts` (task create/start/pause/resume/status) with schemas under `mcp-server/src/tools/`; keep the read-only default and require explicit approval before any mutating action.
- [ ] T017 [US1–US6] Add failing-first integration tests in `tests/tasks/integration.test.ts`: a full task on a local page runs engine → verifier → evidence end to end, including a simulated session expiry and resume.

## Phase 8: Popup in Operate Mode (Impeccable)

**Purpose**: Responsive popup with Tasks, Questions, and Evidence panels; identity preserved (Design §7).

- [ ] T018 [US7] Run `impeccable shape` for the popup UX layout before code (Tasks/Questions/Evidence panels, breakpoints `320 / 380 / 500 / 640`).
- [ ] T019 [US7] Implement the responsive layout in `extension/popup/popup.html` (with `popup.js`): flexible layout instead of fixed `380px`, minimum `320px`, up to `640px`; touch targets at least `44px`; new Tasks, Questions, and Evidence panels; dark zinc + indigo identity unchanged.
- [ ] T020 [US7] Run `impeccable adapt` for responsiveness, then verify visually with `impeccable shot` at the shipped sizes and run the mechanical detector once at the end; run `impeccable audit` for the quality check.

## Phase 9: Full Verification

**Purpose**: Prove the layer end to end before calling it done (Design §1–§7).

- [ ] T021 [US1–US7] Run the full audit task on a local page (engine + session + verifier + evidence + questions + recovery + popup) and record the result; run the full CI gates (`lint`, `typecheck`, `build`, `test:coverage`, `security:audit`, `context:lint`, `context:measure`, `arch:check`) under `umask 022`.
