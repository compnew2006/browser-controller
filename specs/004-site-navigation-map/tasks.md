---
description: "Task list for the site navigation map"
---

# Tasks: site navigation map for browser agents

**Input**: Design documents from `specs/004-site-navigation-map/`

**Prerequisites**: [plan.md](plan.md), [spec.md](spec.md), [research.md](research.md), [data-model.md](data-model.md), [contracts/](contracts/), [quickstart.md](quickstart.md)

**Tests**: Requested. FR-014 and SC-001 require deterministic tests, and `AGENTS.md` asks for regressions on protocol, tab ownership, timeouts and redaction. Write each test before or with its module, and observe it failing where practical.

**Organization**: Pure modules and storage are foundational. User-story phases wire capture, retrieval and owner control in priority order.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: can run in parallel (different files, no dependency on an incomplete task).
- Paths are relative to the repository root.

---

## Phase 1: Setup

- [X] T001 [P] Create the synthetic snapshot and outcome builders in `tests/helpers/map-fixtures.ts`. They provide the home, profile, content, articles, moved, signin, hostile and arabic texts from quickstart.md, in the real `lineOf` format (two-space indent, `role "json-name" [eN]`, `page: <title> — <url>` header, truncation marker), plus `navigateOutcome`, `snapshotOutcome` and `clickOutcome` builders.
- [X] T002 [P] Write `docs/adr/0004-site-map-storage-and-profile-boundary.md` (R-02, R-04, R-05; the profile is the account boundary) and `docs/adr/0005-observing-clicks-for-the-site-map.md` (R-06, R-07). Both have status `proposed`.

---

## Phase 2: Foundational (blocks every story)

- [X] T003 [P] Implement `MAP_ALLOWLIST` in `mcp-server/src/memory/map-allowlist.ts`, mirroring `contracts/map-allowlist.json` v1: areas, eligibleRoles, openedOnly, contentContainers, ignoredLineFields, masking rules, limits, arabicProclitics, dataChanging and notDataChanging. Parity test: `tests/map-allowlist.test.ts`.
- [X] T004 [P] Implement `normalizeForMatch`, `maskText`, `maskPath`, `boundTitle`, `isDataChanging`, `queryWords`/`matchesWords`, `canonicalPrefix`, `pathUnderPrefix` and `controlKey` in `mcp-server/src/memory/map-text.ts` (R-12–R-15).
  - Limits: "names to 80 characters (longer ones are skipped)", "titles to 120 (truncated with `…`)", "masked paths to 200 (a longer path is not recorded)".
  - Tests: `tests/map-text.test.ts`, covering masking order, the slug false positive, year handling, the Arabic letter forms, proclitic matching (`والغاء`, `حول` excluded) and segment-boundary prefixes.
- [X] T005 [P] Implement `parseMapSnapshot(text, opts)` in `mcp-server/src/memory/map-snapshot.ts` (R-10).
  - It reads only depth, role, JSON name, `[eN]` and the `expanded`/`collapsed` flags, and never `value=` or `context=`.
  - It also handles: area by nearest landmark; content containers inside `main`/`page`; eligible roles by area; dialog and menu subtrees; the duplicate-name `nth`; title from the `page:` header; completeness (no `query`, no `target`, no marker); and `navigate {snapshot:true}` text.
  - Tests: `tests/map-snapshot.test.ts`.
- [X] T006 [P] Implement the types, limits, `emptyMapRecord`, `mapFileName(profile, origin)` (`<sha256(browserId)>/<sha256(browserId + "\n" + origin)>.json`) and `validateMapRecord` in `mcp-server/src/memory/map-record.ts`. Validation uses `onlyKeys` and per-field types per data-model.md; a failure is `MEMORY_CORRUPT`. Tests: `tests/map-record.test.ts`.
- [X] T007 Move the private-directory check, the quarantine naming and the temp cleanup from `mcp-server/src/memory/store.ts` into `mcp-server/src/memory/record-files.ts`, with no behavior change. `tests/memory-store.test.ts` must still pass unchanged.
- [X] T008 [P] Implement `MapPolicy` in `mcp-server/src/memory/map-policy.ts` (R-04, R-13).
  - Read/write, cached by inode, with quarantine.
  - `defaultMapPolicy`, `validateMapPolicy` ("≤ 16 profiles", "≤ 32 prefixes per origin", "≤ 1,024" tombstones), `enableProfile`, `disableProfile`, `excludePath`, `includePath`, `addTombstone`, `pruneMapTombstones`, `mapVerdict(memoryPolicy, mapPolicy, op)` and `tombstoneBlocks`.
  - Tests: `tests/map-policy.test.ts`.
- [X] T009 Implement `JsonMapStore` in `mcp-server/src/memory/map-store.ts`: `getMap`, `putMap`, `deleteMap`, `deleteProfile`, `deleteOrigin(origin, profiles)`, `listMaps(profile?)`, `getCounters`, `putCounters`, `status` and `warm`.
  - Writes are atomic through `atomicWriteFile`, with an LRU cache of 128.
  - Limits: "≤ 1 MiB per map file", "≤ 1,000 map files per profile", "≤ 64 MiB for all map files". `MEMORY_FULL` applies to new files only.
  - Corrupt files are quarantined.
  - Tests: `tests/map-store.test.ts`.
- [X] T010 Implement the pure `applyMapOp(record, op, now)` and `enforceMapLimits(record)` in `mcp-server/src/memory/map-reconcile.ts`. Cover the `read`, `click`, `clickFailed` and `open` ops, the state transitions in data-model.md, R-08 outcomes and R-18 eviction, plus the `pageStatus` and `controlStatus` helpers. Tests: `tests/map-reconcile.test.ts`.
- [X] T011 Implement `MapQueue` in `mcp-server/src/memory/map-queue.ts` (R-03).
  - Groups by map file, "≤ 256 pending groups", opId dedupe (1,024 remembered) and a 2 s commit timeout.
  - The policy is checked again at commit through `mapVerdict`, and counter ops are folded.
  - Also `dropPending`, `settle`, `drain` and `stats`.
  - Tests: `tests/map-queue.test.ts`.
- [X] T012 [P] Add capability `site-map`:
  - Add `SITE_MAP_CAPABILITY` to `mcp-server/src/protocol.ts` `EXTENSION_PROTOCOL_CAPABILITIES`, and add `'site-map'` to `extension/lib/protocol.js`.
  - Add `supportsSiteMap` to `getBrowserContext` in `mcp-server/src/vault/bridge-transport.ts` and to `MemoryConnection` in `mcp-server/src/memory/service.ts`.
  - Update the parity tests that compare the two capability lists.
- [X] T013 Add the light `siteContext` for clicks (R-06, `contracts/site-context-click.schema.json`):
  - `extension/lib/site-context.js` gets the `buildSiteContext(tabId, {light, urlBefore})` option. It returns `url`, `fromUrl`, `incognito`, `topLevel: true`, `stable`, `anonymous: null` and `anonymityReason: 'not_probed'`, with no probe or cookie read.
  - `extension/dispatch/router.js` adds `browser_click` to `OBSERVED_TOOLS` and uses the light option for it.
  - Tests in `tests/extension-site-context.test.ts`: no `executeScript` and no `cookies.getAll` for a click; navigate and snapshot unchanged.
- [X] T014 Add `browser_click` to `OBSERVABLE_TOOLS` in `mcp-server/src/bridge-frames.ts`. `MemoryService.beginCall` observes a click only when the map is effective for the session's profile and the connection has `supportsSiteMap`. Update `tests/memory-protocol.test.ts`.

**Checkpoint**: the pure modules, storage, policy, queue and observation plumbing pass their suites.

---

## Phase 3: User Story 1 — open a remembered page directly (P1) 🎯 MVP

**Goal**: record structural pages and look them up, by tab or by named origin.

**Independent Test**: agent A reaches a target three hops from the root; after a restart, agent B in the same profile finds it by a title word and reaches it in one navigation.

- [X] T015 [US1] Implement the in-memory `TabReadCache` and the outcome → op translation for navigates and snapshots in `mcp-server/src/memory/map-capture.ts`: structural pages (R-11), open results (R-08) and `readChars`. The cache holds "at most 64 entries" and is cleared on a connection change.
- [X] T016 [US1] Implement the `MapService` facade in `mcp-server/src/memory/map-service.ts`: `wantsObserve`, `afterCall`, `lookup` (tab or named origin, R-16), `status`, `flush`, and the map part of admin.
- [X] T017 [US1] Implement `buildMapLookup` and `buildMapOutline` in `mcp-server/src/memory/map-output.ts`. Ranking follows R-16 ("at most 20 entries and 4,000 characters per page", outline "at most 10 pages", "at most 100 characters per line"); the label, the `p<n>` cursor and the no-map line (CHK029) are included.
- [X] T018 [US1] Wire `MemoryService` in `mcp-server/src/memory/service.ts`: construct `MapService`, observe clicks in `beginCall`, call `map.afterCall` before the 003 early return in `afterCall`, and route `handleTool('browser_site_map')`.
- [X] T019 [US1] Add the routing of `browser_site_map` in `mcp-server/src/memory/map-tool-route.ts`:
  - `tabId` goes through `CONTEXT_ACTION`; `origin` goes direct.
  - Add the tool to `isMemoryTool` and `routeMemoryToolCall` in `mcp-server/src/memory/policy-tool-route.ts`.
- [X] T020 [US1] Add the MCP tool and its registrations:
  - `mcp-server/src/tools/site-map.ts` (zod: `tabId` or `origin`, `query` "≤ 100 characters", `cursor` `^p\d{1,4}$`).
  - Register it in `mcp-server/src/tools/registry.ts` (22 tools) and add its result fields in `mcp-server/src/vault/redaction.ts`.
  - Update `tests/tools/registry.test.ts` and `tests/extension-router.test.ts`.
- [X] T021 [US1] Write the tests in `tests/map-service.test.ts` (US1 part) and `tests/map-tool.test.ts`: AC-01–AC-05, AC-27, AC-33 and SC-002.

---

## Phase 4: User Story 2 — use the right control (P1)

**Goal**: controls with areas, menus, destinations, ready locators, use feedback, a reminder and data-changing marks.

**Independent Test**: agent A opens the header menu and clicks two controls; agent B's lookup shows both, with their areas, the menu parent and their destinations.

- [X] T022 [US2] Add click attribution to `mcp-server/src/memory/map-capture.ts` (R-07): ref, `{role, name, nth}` and `text=` targets; a `fromUrl` match; the destination in the source context (R-09); hub pages; `opens` menu or dialog through the pending click (R-11).
- [X] T023 [US2] Add use outcomes in `mcp-server/src/memory/map-capture.ts` and `map-reconcile.ts` (R-08): worked, failed (locator codes, `MISMATCH`) and undecided. A click error is attributed through the cache alone ("≤ 120 s old, same connection").
- [X] T024 [US2] Add `buildMapReminder` to `mcp-server/src/memory/map-output.ts` ("at most 4 lines and 600 characters", no data-changing controls, no 003 duplicates). `MemoryService.withReminder` merges it, and `map: unavailable (<CODE>)` covers a timeout or error.
- [X] T025 [US2] Write the tests in `tests/map-service.test.ts` (US2 part) and `tests/map-output.test.ts`: AC-06–AC-10, AC-26, AC-31, AC-32, SC-003 and SC-011.

---

## Phase 5: User Story 3 — private and under the owner's control (P1)

**Goal**: off by default, isolated per profile, owner-confirmed changes, path exclusions, counters.

**Independent Test**: the privacy fixture in two profiles, a private tab and a vault-protected page. Then inspect every record, lookup, reminder and export.

- [X] T026 [US3] Implement the `map_*` actions in `mcp-server/src/memory/map-policy-route.ts` (R-20).
  - The preview answer carries the action, the origin, the path, the profile id and the label.
  - The confirmed call is checked against `confirmedOrigin`, `confirmedPath` and `confirmedProfile`.
  - Call it from `routeMemoryPolicyTool` in `policy-tool-route.ts`, with one shared action list.
- [X] T027 [US3] Add the MCP side in `mcp-server/src/tools/memory-policy.ts`: the map actions, `path`, the confirmation texts from `contracts/README.md`, and `confirmedPath`/`confirmedProfile`. The rate limit is shared.
- [X] T028 [US3] Add the `map` sub-command to the admin path:
  - `mcp-server/src/daemon-config.ts` gets the types and `parseMemoryAdminRequest`.
  - `mcp-server/src/memory/admin.ts`: 003 `delete` also deletes maps (R-05), and `map` goes to `MapService.admin`.
  - Add the CLI `map` commands to `scripts/memory.mjs`.
- [X] T029 [US3] Add the counters (R-19): `lookups`, `usesWorked`, `usesFailed` and the estimates, in `map-service.ts`/`map-queue.ts`. Status exposes them through `map status`, and delete-all resets them.
- [X] T030 [US3] Write the tests in `tests/map-policy-tool.test.ts`, `tests/map-admin.test.ts` and `tests/map-privacy.test.ts`: AC-11–AC-17, AC-34, AC-35, SC-004 and SC-010. The privacy test includes a network sink and a scan of every output.

---

## Phase 6: User Story 4 — correct when the site changes (P2)

- [X] T031 [US4] Write the site-change scenarios in `tests/map-service.test.ts` and `tests/map-reconcile.test.ts`: AC-18–AC-22, AC-28–AC-30, SC-007, SC-008 and SC-009. Fix any reconciliation gaps they expose.

---

## Phase 7: User Story 5 — browsing continues when the map fails (P2)

- [X] T032 [US5] Write the failure, concurrency and limit tests in `tests/map-service.test.ts` and `tests/map-queue.test.ts`: AC-23–AC-25. They inject a store failure, a slow store, corrupt files, a full queue and a replayed opId.

---

## Phase 8: Polish and cross-cutting

- [X] T033 [P] Write `scripts/map-bench.mjs` (R-23), run it on Node 22 and record `specs/004-site-navigation-map/baseline.md`. Node 20 is recorded as not run.
- [X] T034 [P] Update the docs: the `README.md` map section and the tool count (22), the `SECURITY.md` threat model for named-origin lookups, `CHANGELOG.md` (Unreleased) and the agent-config tool lists, if any. Done 2026-10-28, except the agent-config lists: they already listed 17 tools and none of the vault, safety or memory tools before 004, so they are left for the owner.
- [X] T035 Run the full local gate: `npm run lint`, `npm run typecheck`, `npm run build`, `npm run test:coverage` and `npm run context:lint`. `security:audit` is not run (not authorized).
- [X] T036 Independent review of the diff against the spec and security (a fresh reviewer agent), recorded in `specs/004-site-navigation-map/review.md`. Fix the findings and rerun the affected checks. Done: RV-01–RV-16 and RV-18 fixed with tests (RV-16 and RV-18 by the owner's delegated decision, plan.md), RV-17 recorded (see the review's Resolution section); full gate green afterwards on Node 22 and Node 20.
- [X] T037 Refresh the code indexes (`graphify update .`, codebase-memory) and record the status. 2026-10-28, after the last code change: `graphify update .` rebuilt 4,745 nodes and 11,088 edges; codebase-memory `index_repository` (fast) indexed 8,397 nodes and 28,984 edges, status `indexed`, 4 files partially parsed (two `.specify` shell scripts, `tests/extension-router.test.ts`, `tests/v3-lifecycle.test.ts`).

---

## Dependencies & Execution Order

- Phase 1 has no dependencies.
- Phase 2:
  - T003–T006 and T008 are parallel.
  - T007 comes before T009; T009 and T010 come before T011.
  - T012 comes before T013 and T014.
- Phase 3 depends on Phase 2.
- Phases 4 and 5 depend on Phase 3, because they share `map-service.ts` and `map-capture.ts`.
- Phases 6 and 7 depend on Phases 3–5.
- Phase 8 comes last.

## Parallel Example: Phase 2

```text
Task: T003 map-allowlist.ts + parity test
Task: T004 map-text.ts + tests
Task: T005 map-snapshot.ts + tests
Task: T006 map-record.ts + tests
Task: T008 map-policy.ts + tests
```

## Implementation Strategy

The MVP is Phases 1–3: pages are recorded and looked up. Then add controls (US2) and owner control (US3), the remaining P1 stories. Then add change handling and failure handling (P2), then polish. Each phase ends with its suite and `npm run typecheck`.

## Notes

- No commit or push without the owner's authorization.
- Every test uses an isolated state directory.
- The 600-line module cap and the R-16 locality test apply to every new module.
