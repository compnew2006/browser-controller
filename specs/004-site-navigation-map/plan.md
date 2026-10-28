# Implementation Plan: site navigation map for browser agents

**Branch**: `main` (no feature branch created; Spec Kit resolved `specs/004-site-navigation-map` from `.specify/feature.json`) | **Date**: 2026-10-28 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/004-site-navigation-map/spec.md`

**Status**: Draft plan for owner review. The spec is not yet owner-accepted (gate 1). This plan does not authorize implementation, dependency changes, commits, pushes or real-Chrome runs. Proposed classification: `EVOLVE / CRITICAL`.

## Summary

Agents keep a per-profile, per-origin map of structural pages and the controls on them. It is built only from their own successful navigates, snapshots and clicks. Before exploring a site again, an agent can look up a remembered page and open it directly. It can also use a remembered control in one `browser_click` step, using a ready `{role, name, nth?}` locator and an expected destination.

The map extends 003 website memory. It uses the same daemon module, scope decision, owner confirmation path, IPC kind, local-only rule and failure isolation. Its records are separate files that are never shared across profiles ([research.md](research.md) R-01, R-02).

New surfaces:

- A read-only daemon-owned tool, `browser_site_map`. It looks up the tab's origin or a named origin (R-16).
- A map block in the navigation reminder (R-17).
- `map_*` actions on `browser_memory_policy`, and a `map` sub-command of the owner CLI (R-20).
- Light observation of `browser_click`: the extension adds `fromUrl` and the after URL, with no page probe, behind a new capability `site-map` (R-06).

## Technical Context

**Language/Version**: TypeScript (ES modules) on Node.js ≥ 20 for the daemon and MCP server. CI runs Node 20 and 22; only Node 22 is installed locally. JavaScript for the Chrome MV3 extension.

**Primary Dependencies**: Existing only: `@modelcontextprotocol/sdk`, `zod`, `ws` and Node built-ins. There is no new dependency.

**Storage**: JSON files under `<BC_STATE_DIR or ~/.browser-controller>/memory/`:

- `map-policy.json`.
- `maps/<sha256(browserId)>/<sha256(browserId + "\n" + origin)>.json` (one directory per profile).
- `map-counters.json`.

Writes are atomic, as in 003, through one daemon writer queue (R-02–R-04, [data-model.md](data-model.md)).

**Testing**: Vitest with the existing memory fixtures (`tests/helpers/memory-fixtures.ts`), Chrome mocks and the spawned-daemon harness. Synthetic sites live in `scripts/pages/map/`, and each test gets an isolated `BC_STATE_DIR`. The bench is extended (R-23).

**Target Platform**: Local daemon on macOS, Windows and Linux, with Chrome desktop and the Browser Controller extension, including several profiles and private windows.

**Project Type**: A local MCP server and daemon plus a browser extension.

**Performance Goals** (accepted at gate 4 on 2026-10-28, after the baseline):

- 003's SC-005 limits stay met with the map on: navigate p95 overhead ≤ 25 ms and snapshot ≤ 30 ms.
- Lookup p95 ≤ 50 ms on a map at its limits, for tab lookups, named-origin lookups and the outline.
- Observing a click adds ≤ 5 ms p95.

**Constraints**:

- A map error never changes a browser outcome, timeout, retry or tab ownership.
- Output bounds: the map adds ≤ 4 lines and ≤ 600 characters to a reminder. A lookup page has ≤ 20 entries and ≤ 4,000 characters; an outline ≤ 10 lines and ≤ 1,000 characters.
- Storage bounds: ≤ 500 pages and ≤ 60 controls per page per (profile, origin), with ≤ 1 MiB per file binding first. Per profile ≤ 1,000 files, and ≤ 64 MiB in total.
- The queue holds ≤ 256 groups and commits within 2 s.
- No network I/O. The 600-line module cap holds, and `daemon.ts` gets no edits (R-24).

**Scale/Scope**: One owner, a few profiles, tens of agent sessions, and up to thousands of origins.

No `NEEDS CLARIFICATION` remains. [research.md](research.md) resolves each unknown and proposes answers to checklist items CHK001–CHK040; those items stay unchecked for the reviewer. The items under *Owner review gates* are approvals, not open requirements.

## Constitution Check

*GATE: Check applicable requirements before Phase 0 research and re-check after Phase 1 design.*

Source checked: the SHA-256 of root `constitution.md` is `2b2d4700e6364c1e898c90ddaff5923393bc977d605353286624c1d7b7f40b17`. It matches the fingerprint in `.specify/memory/constitution.md`: version 4.1.0, status *proposed*, not adopted.

### Applicable now (`AGENTS.md`, owner instructions)

| Requirement | Pre-design | Post-design |
|---|---|---|
| Spec Kit pauses for spec and plan review | PASS: draft for review | PASS |
| Schemas in `mcp-server/src/tools/`, registration in `tools/registry.ts`, browser behavior in handlers | — | PASS: `tools/site-map.ts`; extension logic in `extension/lib/site-context.js` |
| Preserve timeouts, tab ownership, retries, protocol compatibility | — | PASS: capture after the outcome; the light click block stays within the 200 ms URL budget; capability `site-map` gates it (R-06, R-21) |
| Vault data never leaks | — | PASS: 003 scope gate, and a named-origin lookup needs vault state `clear` (R-16) |
| No secrets or page data as instructions; untrusted labels | — | PASS: masked structure only, labeled hints, no direct agent writes (R-10–R-12) |
| No installs, upgrades or external services without authorization | PASS | PASS: no new dependency; `security:audit` and real-Chrome smoke stay gated |
| Regression tests for protocol, tab ownership, timeouts, redaction | — | PASS: planned in [quickstart.md](quickstart.md) |
| 600-line module cap; R-16 memory locality test | — | PASS by design: flat `memory/map-*.ts` modules; only call-site hooks in `service.ts`, `router.js`, `site-context.js` and `bridge-frames.ts` (R-01, R-24) |

### Proposed constitution checks (not binding until adopted)

| Article | Check | Status |
|---|---|---|
| 2 Risk tiers | `CRITICAL`: persists structure of signed-in pages from the real profile | Proposed; owner confirms |
| 3 Authorization | Implementation, commits, pushes, real-Chrome runs and the audit each need explicit authorization | Recorded in gates |
| 6 Spec and contract | Machine-readable contracts in [contracts/](contracts/) | Drafted; a contract hash or CI recompute is not available |
| 7 ADR | ADR 0004 (map storage and per-profile boundary, R-02, R-05) and ADR 0005 (click observation, R-06) | To be written with tasks, status `proposed` |
| 16 Testing (`EVOLVE`) | Full regression plus contract, privacy, concurrency, failure and recovery suites | Planned |
| 19/22 Merge and done | Independent review; owner approval; local checks reported apart from CI | Planned |
| 21 Security | No new dependency; untrusted data; local only; the named-origin threat model (R-16) goes into `SECURITY.md` | PASS |
| 24 Token budget | `CRITICAL` needs an owner-set budget | Open: the 2026-10-28 "continue without limits" was given for 003; gate 5 asks whether it covers 004 |

**Gate result**: PASS for planning. *Complexity Tracking* lists the additions that raise complexity.

## Owner review gates (before `$speckit-tasks` / implementation)

1. **Accept or amend [spec.md](spec.md)**, including its three pending decisions:
   - (a) The browser profile is the account boundary for map entries, which deliberately differs from 003 FR-005.
   - (b) Personal names in navigation controls may be stored locally.
   - (c) Structural public addresses may reveal sensitive topics.

   Also confirm the readings in research:
   - A sign-in landing is shown but not ranked lower (R-08, CHK022).
   - Truncated reads never mark not seen (R-10, CHK010).
   - Map disable keeps data (R-05).
   - 003 site deletes also delete maps (R-05).
2. **Approve observing `browser_click`** through the light block and capability `site-map` (R-06). Without it, the map has no destinations, hub pages or click feedback.
3. **Review [contracts/map-allowlist.json](contracts/map-allowlist.json)**: areas, eligible roles, content containers, masking patterns and the English/Arabic data-changing vocabulary.
4. **Confirm or change the provisional limits and thresholds** after the baseline run (R-02, R-23).
5. **Set or confirm the implementation token budget** (Art. 24, proposed).

The reviewer marks [checklists/privacy-lifecycle.md](checklists/privacy-lifecycle.md) against research.md.

**Owner instruction, 2026-10-28**: "run /speckit.analyze, then /speckit.implement, and continue until 004-site-navigation-map is complete." This is recorded as follows:

- **Gates 1–3** are accepted as drafted, unamended. This covers the spec's three pending decisions, the click observation and the allowlist. The owner may still amend any of them; an amendment re-opens the affected tasks.
- **Gate 5**: no token limit. Usage is still recorded per phase where available, and `UNAVAILABLE` where not.
- **Gate 4**: stays open. The thresholds are confirmed after the measurement run.

**Owner instruction, 2026-10-28 (after the T036 review)**: "do what is right, I don't know" (اعمل الصح انا معرفش). The owner delegated the open decisions to the implementer. They are recorded here so the owner can reverse any of them:

- **Gate 4: accepted as drafted.** `baseline.md` (Node 22, in-process) meets every goal with at least 8× margin. With the map on, the call-path p95 is 1.68 ms for a navigation (goal 25 ms), 0.29 ms for a snapshot (30 ms) and 0.24 ms for a click (5 ms). Lookup p95 is 6.1 ms on a map at its limits (50 ms). The storage limits stay as listed; the 1 MiB file bound binds first (45 pages of 60 controls). Commits run off the call path, at about 31 ms p95, and have no goal. These numbers are daemon-side only, not end to end.
- **RV-16: opening `/` is not a hint use.** Any agent can open the root from the origin alone, so counting it would make the counters measure habit, not use of the map (SC-010). The open result is still recorded.
- **RV-18 (gate 3 vocabulary): the spec wins.** `notDataChanging` keeps only false friends (`حول` and its forms, R-15). "Remove filter", "Clear search" and the like stay matched, which costs one reminder line, as the spec's Edge Cases describe.
- **`security:audit`: run** (`npm audit --omit=dev --audit-level=high`). It is a read-only registry query that CI already runs.
- **Real-Chrome run: not done by the implementer.** It restarts the daemon that the owner's live agent sessions use, and it needs the extension reloaded. Turning the map on in the owner's real profile would also record signed-in pages, and that is the owner's choice to make. It stays a manual owner step.
- **Commit: not done.** The working tree also holds earlier uncommitted work, and the owner should choose how to split and commit it.

The instruction authorizes implementation only. Commits, pushes, `security:audit` and real-Chrome runs still need their own authorization. The privacy-lifecycle checklist stays reviewer-owned and unchecked; the owner's instruction is the decision to proceed despite it.

## Project Structure

### Documentation (this feature)

```text
specs/004-site-navigation-map/
├── spec.md
├── plan.md                 # This file
├── research.md             # Phase 0: R-01…R-24 and the CHK resolution map
├── data-model.md           # Phase 1: entities, validation, transitions
├── quickstart.md           # Phase 1: AC → test mapping
├── contracts/
│   ├── README.md
│   ├── browser-site-map-tool.schema.json
│   ├── map-policy-actions.schema.json
│   ├── site-context-click.schema.json
│   ├── map-store.schema.json
│   └── map-allowlist.json  # owner gate 3
├── checklists/requirements.md
├── checklists/privacy-lifecycle.md
└── tasks.md                # $speckit-tasks
```

### Source Code (repository root)

```text
mcp-server/src/
├── memory/
│   ├── map-service.ts        # NEW: MapService facade: beginCall/afterCall/reminder/lookup/admin hooks
│   ├── map-snapshot.ts       # NEW: snapshot line parser, areas, content containers, completeness (R-10)
│   ├── map-text.ts           # NEW: normalizeForMatch, masking, vocabulary matching (R-12, R-14, R-15)
│   ├── map-allowlist.ts      # NEW: mirror of contracts/map-allowlist.json (parity test)
│   ├── map-record.ts         # NEW: MapRecord validation and limits
│   ├── map-store.ts          # NEW: per-(profile, origin) files, LRU cache, quarantine, usage
│   ├── map-queue.ts          # NEW: bounded writer queue, op dedupe, commit-time policy recheck
│   ├── map-reconcile.ts      # NEW: pure applyMapOp (R-18) and use outcomes (R-08)
│   ├── map-output.ts         # NEW: lookup, outline, reminder block and labels
│   ├── map-policy.ts         # NEW: map-policy.json, tombstones, path exclusions
│   ├── map-policy-route.ts   # NEW: map_* actions of browser_memory_policy
│   ├── record-files.ts       # NEW: helpers moved from store.ts (no behavior change)
│   ├── service.ts            # hooks: observe click, failure outcomes, reminder merge, tool route
│   ├── policy-tool-route.ts  # isMemoryTool += browser_site_map; map_* actions to map-policy-route
│   └── admin.ts              # map sub-command; 003 delete also deletes maps
├── tools/site-map.ts         # NEW: browser_site_map ToolDefinition (read-only, daemon-owned)
├── tools/memory-policy.ts    # map_* actions, path, confirmation texts, confirmedPath and confirmedProfile
├── tools/registry.ts         # 21 → 22 tools
├── vault/redaction.ts        # result-field allowlist for browser_site_map
├── vault/bridge-transport.ts # getBrowserContext: supportsSiteMap
├── daemon-config.ts          # memory-admin map sub-command (types)
├── protocol.ts               # capability site-map
└── bridge-frames.ts          # OBSERVABLE_TOOLS += browser_click (map-gated in beginCall)

extension/
├── lib/site-context.js       # buildSiteContext {light} option (R-06)
├── lib/protocol.js           # advertise site-map
└── dispatch/router.js        # OBSERVED_TOOLS += browser_click (light block)

scripts/
├── memory.mjs                # map sub-commands
├── map-bench.mjs             # NEW: map-off/on capture and lookup p95 (R-23)
└── pages/map/                # NEW: synthetic sites (3-hop target, menus, markers, change, read context, vocabulary)

tests/
├── map-text.test.ts, map-snapshot.test.ts, map-allowlist.test.ts
├── map-store.test.ts, map-queue.test.ts, map-reconcile.test.ts
├── map-output.test.ts, map-policy.test.ts, map-service.test.ts
├── map-daemon.test.ts, map-privacy.test.ts
├── extension-site-context.test.ts   # light block cases
└── tools/registry.test.ts           # tool list
```

**Structure Decision**: The single-project layout is kept. Map logic sits in flat `memory/map-*.ts` modules so the R-16 locality test still applies. `daemon.ts` (595 lines) is not edited. Large modules get only call-site hooks.

## Delivery sequence (for `$speckit-tasks`)

1. Run owner gates 1–3. Then finalize the contracts and the allowlist, and write ADRs 0004 and 0005 as `proposed`.
2. Take a baseline with the map absent, using the extended bench on Node 22. Node 20 is reported as not run.
3. Write `map-text`, `map-snapshot` and `map-allowlist` test-first: masking, normalization, vocabulary, areas, completeness.
4. Write `map-record`, `map-store`, `map-queue`, `map-reconcile` and `map-policy`: atomicity, limits, tombstones, eviction, use outcomes.
5. Add the extension light click block and capability, then the daemon observation and tab read cache (R-06, R-07).
6. Wire capture into `MemoryService`: structural pages, controls, destinations, opens and failure feedback.
7. Add retrieval: `browser_site_map`, the reminder block and batch notes.
8. Add owner controls: `map_*` actions with elicitation, the CLI `map` sub-command, and the 003 delete interplay.
9. Add the privacy, injection, concurrency, failure, restart and profile-isolation suites.
10. Measure against the baseline; the owner confirms the limits.
11. Update docs (README map section, `SECURITY.md` threat model, CHANGELOG) and run the full gate: `lint`, `typecheck`, `build`, `test:coverage`, `context:lint`, and `security:audit` only with authorization. Then an independent security review, and `graphify update .`.

## Complexity Tracking

| Addition | Why Needed | Simpler Alternative Rejected Because |
|---|---|---|
| Observing `browser_click` with a light block | Destinations, hub pages and use feedback need the control and both URLs (AC-07, AC-08, AC-31) | Inferring from the next read misattributes after a manual navigation; the MCP-side `expect` result never reaches the daemon |
| Separate `map-policy.json` | 003 validation drops unknown keys; per-profile enable (R-04) | A `policy.json` v2 block is lost on any older-build write and raises 003's schema |
| Separate map queue and store | `queue.ts` (512 lines) and `SiteRecord` are typed to 003; the 64 KiB record and cross-profile sharing do not fit | Extending 003's queue passes the 600-line cap and couples two record kinds |
| In-memory tab read cache | Resolves `eN`/`text=` targets to role and name, and gives source-page context without storing text (R-07) | A probe on each click adds a page script per click; storing snapshot text breaks FR-003 |
| Named-origin lookup | FR-007 and AC-05 need lookups before visiting | A tab-only lookup cannot open a remembered page first; the risk is bounded in R-16 |
| New tool `browser_site_map` | Read-only lookup kept apart from policy changes; clients can auto-allow it | Adding it to `browser_memory` mixes shared facts with profile-only map data and their different rules |
