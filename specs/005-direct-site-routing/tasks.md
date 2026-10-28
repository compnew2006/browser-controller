# Tasks: direct routing from the site map

**Input**: [spec.md](spec.md), [plan.md](plan.md)

- [x] T001 Write regression tests for E2, E3 and E4 in `tests/map-routing.test.ts`, and watch them fail before the fix.
- [x] T002 Record changes: `read` reason, `entrances`, validation (`map-record.ts`), plus tests in `tests/map-record.test.ts`.
- [x] T003 FR-001: `read` reason in `map-capture.ts` and `map-reconcile.ts`.
- [x] T004 FR-002/FR-003: `lateClick` in `map-capture.ts`; `noteCall` in `map-service.ts` and `service.ts`.
- [x] T005 FR-004: `entranceFrom` and the entrance on the arrival read (`map-capture.ts`), applied in `map-reconcile.ts`, source verdict in `map-queue.ts`.
- [x] T006 FR-005: sign-in landing classification (`map-capture.ts`), entrances line (`map-output.ts`).
- [x] T007 FR-006: computed routes in `map-output.ts`.
- [x] T008 FR-007: reminder pages line in `map-output.ts`.
- [x] T009 FR-008: `browser_site_map` description; hand the agent-guidance text to the parent.
- [x] T010 FR-009: sanitize of entrances (`map-reconcile.ts`, `map-queue.ts`), `scrubEntrances` in `map-admin.ts`.
- [x] T011 Update the 004 expectations this feature reverses (AC-27 article fixture, AC-07 other-origin read), with a comment that names spec 005.
- [x] T012 Mirror the record change in `specs/004-site-navigation-map/contracts/map-store.schema.json`.
- [x] T013 Run `npm run lint`, `npm run typecheck`, `npm test` and `npm run build`; record the results in the report.
