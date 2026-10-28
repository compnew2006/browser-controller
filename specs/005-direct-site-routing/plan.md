# Implementation Plan: direct routing from the site map

**Spec**: [spec.md](spec.md) · **Builds on**: [004 plan](../004-site-navigation-map/plan.md) · **Created**: 2026-10-28

**Review**: the owner waived the spec and plan review pauses on 2026-10-28 (spec, Clarifications). Decisions below are recorded so they can be reviewed after the fact.

## Root causes, confirmed in source

| Evidence | Cause in source | Fix |
|---|---|---|
| E2 | `browser_click {expect}` runs in the MCP-side wrapper (`tools/action-support.ts`). The daemon sees a click that succeeded without an address change, then the wrapper's `browser_snapshot` calls. `captureRead` uses `pendingClick` only for a read at the same path, and the first such read (the wrapper's own check) clears it. The later read at `/pos/ui/1/floor` finds no pending click. | FR-003: a separate `lateClick` on the tab cache, kept across same-path reads for 120 s and cancelled by any other tab action. A read at a new address emits a second click op with the destination. FR-002 is met through this path, because the daemon never receives `EXPECTATION_FAILED` for a click. |
| E3 | A click from a stub (no read since the last navigation) cannot be attributed, and the reads after it are `refresh` reads. | FR-001 records the page that the agent then reads completely. The click itself stays unattributed, because its control is unknown. |
| E4 | `applyRead` returns early for `reason: 'refresh'` on an unknown page (R-11). | FR-001: `captureRead` sends `reason: 'read'` for a complete read; `applyRead` creates the page with `reason: 'read'`. |
| E5 | `option` is not an eligible role. | No change (spec default). |
| E6 | Controls in table rows are content (R-10); a cross-origin click stores only `{origin}` on the source page. | FR-004: an entrance on the arriving site's record (source origin and masked path only). |

## Decisions per requirement

- **FR-001**: `MapReadOp.reason` gains `'read'`, used when the read is complete (`parseMapSnapshot(...).complete`, which already excludes scoped and truncated reads), and the reason would otherwise be `refresh`. Status ≥ 400 already returns before the read op. Root, destination and landing keep their own reasons. `PageEntry.reason` gains `'read'`. Exception (added during implementation, because 004's privacy test failed): `TabRead.noReadEntry` marks a page the tab reached through a click whose target is no stored control on a page with a snapshot (a content link, R-10/RV-01), or from another origin by a click, a late click or a navigate redirect (RV-05). Reads of that page keep `refresh` until a navigate to it. A click from a page without a snapshot (E3) is unknown, not content, so its target page is still recorded.
- **FR-002/FR-003**: `TabRead.lateClick = { control, fromPath, lang, context, atMs }`, set when a resolved click does not navigate. Same-origin, same-path, non-navigate reads within 120 s carry it forward. A non-navigate read within the window at a new path on the same origin emits `click` op `#late` (navigated, destination path or `{excluded: true}`) before the read op. The read then gets `reason: 'destination'`. A read on another origin emits the click op with `{origin}` and records the entrance (FR-004). `MapService.noteCall` clears `lateClick` for the tab after any daemon call that is not read-only (type, fill, press, scroll, evaluate, dialog, emulate, mock, vault fill, …). `MemoryService.afterCall` calls it before its `observe` check. Navigate reads clear it.
- **FR-004**: `MapRecord.entrances?: Array<{ origin, path, addressable, at }>`, at most 5, newest first, unique by origin and path. It is optional, so `schemaVersion` stays 1 and existing files stay valid. Downgrade note: an older daemon quarantines a file that has `entrances` or a `read` page as `MEMORY_CORRUPT`. Capture: a click whose result leaves for another origin sets `entranceFrom` on the stub, whether or not the control was resolved. The next read on that origin adds `entrance` (with the raw source path, never stored) to its read op. The queue keeps the entrance only when `mapVerdict` for the source origin and path is `ok`. A record with entrances and no pages is still written.
- **FR-005**: `openResult` classifies a same-origin landing whose path looks like a sign-in page (`login`, `signin`, `sign-in`, `auth`, `sso`, `session/new`, `accounts/login` segments) as `sign_in`. `sign_in` is not a failed open (004). Lookups and outlines print one `entered before from …` line for the site's entrances.
- **FR-006**: computed in `map-output.ts`, breadth-first, from every addressable page to the target. Edges are working, non-data-changing controls whose latest destination is a same-origin path. A control inside a menu adds its opener first. At most 4 steps. Routes are printed only for hit pages that are not addressable.
- **FR-007**: one `map pages:` line in the reminder, with up to 3 addressable working pages other than the current page and `/`, ranked by use and recency. It takes the place of one control line, so the reminder stays at 4 lines and 600 characters.
- **FR-008**: `browser_site_map` description; the doc text for `agent-config` is handed to the parent. `tools/list` was at 19,880 of its 20,000-character budget (`tests/v3-server.test.ts`), so the new description adds 70 characters only.
- **FR-009**: `sanitizeRecord` filters entrances through `SanitizePolicy.entranceBlocked` (website-memory exclusion, map path exclusion, map and website-memory tombstones of the source origin). Reads, inspect and export already run it. Owner deletes and exclusions of a source origin (`map delete`, `map exclude-path`, website-memory `delete <origin>`) rewrite the affected records (`scrubEntrances`), so pruned tombstones never bring an entrance back.

## Files

- `mcp-server/src/memory/map-record.ts`: `read` reason, `Entrance`, validation.
- `mcp-server/src/memory/map-reconcile.ts`: `read` pages, entrances, sanitize of entrances.
- `mcp-server/src/memory/map-capture.ts`: `read` reason, `lateClick`, `entranceFrom`, sign-in landing, `noteAction`.
- `mcp-server/src/memory/map-queue.ts`: source verdict for entrances, entrance-only records.
- `mcp-server/src/memory/map-service.ts`: `noteCall`.
- `mcp-server/src/memory/service.ts`: forwards every call to `noteCall`.
- `mcp-server/src/memory/map-output.ts`: routes, entrances line, reminder pages line.
- `mcp-server/src/memory/map-admin.ts`: `scrubEntrances`.
- `mcp-server/src/tools/site-map.ts`: description.
- `specs/004-site-navigation-map/contracts/map-store.schema.json`: mirrors the record change.
- Tests: `tests/map-routing.test.ts` (new), plus updated expectations in `tests/map-service.test.ts` (AC-27 and AC-07, reversed on purpose) and `tests/map-record.test.ts`.

## Risks

- **More stored addresses** (owner decision): every complete read in scope now leaves a page entry. Masking, exclusions, bounds (500 pages, least recent first) and deletion are unchanged.
- **Wrong late attribution**: a timer redirect inside the window could be credited to the click. This is limited by same origin, 120 s, no other action in the tab and a non-navigate read. The result is a hint, and a wrong hint ranks lower after one failed use (004).
- **Cross-origin data in a record**: an entrance stores another origin's masked path. It is never sent to a third party, is removed with either site, and holds no control names.
- **Downgrade**: covered above. No migration is needed for an upgrade.

## Tests

- E2 late attribution: exact replay (click without address change, wrapper snapshot at the same path, snapshot at the new path). Cancelled by `browser_type` in the tab, and expired after 120 s.
- E3: a stub click chain, then a complete read, gives a page entry.
- E4: a complete read by address gives a `read` page. A scoped, truncated or 500 read gives none.
- A page reached through a content link, or a redirect to another site, gets no `read` page until opened by address (004 privacy test unchanged).
- Entrances: recorded without control names. Not recorded from an excluded origin or path. Removed by `map delete` of the source.
- Sign-in landing is classified as `sign_in`, and the lookup shows the entrance line.
- Routes: a two-step route, a menu opener step, and no route through a data-changing or failed control.
- Reminder pages line, within 600 characters.
- Record validation for `read` and entrances.
