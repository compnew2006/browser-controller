# Implementation Plan: shared website memory for browser agents

**Branch**: `main` (no feature branch created; Spec Kit resolved the feature directory `specs/003-website-agent-memory` from `.specify/feature.json`) | **Date**: 2026-10-27 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/003-website-agent-memory/spec.md`

**Status**: Draft plan for owner review. The spec checklist still records the spec as not owner-accepted; this plan does not authorize implementation, dependency changes, commits or pushes. Classification proposed: `EVOLVE / CRITICAL`.

## Summary

Agents that drive the owner's Chrome through Browser Controller get a small, local, owner-controlled memory per website. It is off until the owner enables it once; the owner can exclude sites, inspect, export and delete. Two kinds of record exist:

- **Visit observation**: per verified profile and origin, the count and time of successful tool navigations. Never shared across profiles and never contains page content.
- **Site fact**: a structural, non-personal interface or navigation detail (for example a `Sign in` link, a search box, a login form path, the page language) taken from a snapshot the agent already requested, only when the page was read in a verified anonymous context. Facts can be shared across profiles for the same origin with minimized provenance.

The daemon owns everything: scope checks, the allowlist, a bounded single-writer queue and a dependency-free on-disk store under the daemon state directory. The extension adds a `siteContext` block (final URL, incognito state, top-level document, language, anonymity verdict) to navigate and snapshot results only when the daemon asks for it. Agents get a bounded, labeled reminder after a successful navigation, also inside a batch. A daemon-owned `browser_memory` tool returns more detail for the tab's verified origin. Owner controls go through a local CLI over daemon IPC, or through a separate daemon-routed MCP tool, `browser_memory_policy`: an agent may request `enable`, `disable`, `exclude`, `include`, `inspect`, `export` or `delete`, but the request applies only after the owner confirms it in the agent client through MCP form elicitation (the `registerTools` confirmation path in `mcp-server/src/register-tools.ts`); an agent-supplied `ownerConfirmed` value is always dropped (2026-10-27 clarification, FR-004, AC-32). `browser_memory_policy` is kept apart from the read-only `browser_memory` tool so a client can auto-allow reads while still prompting for policy changes.

Mnemon is an optional, separately authorized experiment within this feature: the requirements are keyed lookups over small allowlisted records, which do not need its full-text index, child process or native SQLite driver ([research.md](research.md) R-01, R-02). The store sits behind a `MemoryStore` interface selected by `BC_MEMORY_STORE`; the default JSON store ships without it, and a Mnemon adapter is adopted only after it passes every existing suite and the owner approves the SC-005 comparison (2026-10-27 clarification, FR-013).

## Technical Context

**Language/Version**: TypeScript (ES modules) for the daemon and MCP server on Node.js ≥ 20 (CI: Node 20 and 22); JavaScript for the Chrome MV3 extension.

**Primary Dependencies**: Existing only: `@modelcontextprotocol/sdk`, `zod`, `ws`, Node built-ins (`fs/promises`, `crypto`, `path`). No new npm dependency (R-01).

**Storage**: JSON files under `<BC_STATE_DIR or ~/.browser-controller>/memory/`: `policy.json` plus one record per origin under `sites/`. Each write is temp file → fsync → atomic rename → directory fsync, with one writer in the daemon process (R-03, [data-model.md](data-model.md)).

**Testing**: Vitest (`npm test`, `npm run test:coverage`) with the existing Chrome mocks, fake DOM, spawned-daemon harness and IPC clients. Synthetic pages live in `scripts/pages/memory/`. Each test uses an isolated `BC_STATE_DIR`. An optional real-Chrome smoke check uses those pages; it needs a separate run authorization.

**Target Platform**: Local daemon on macOS, Windows and Linux. Chrome desktop with the Browser Controller extension (normal and private windows, several profiles).

**Project Type**: Local MCP server and daemon plus a browser extension. The feature adds a daemon module, one MCP tool, one IPC message kind and one extension result block.

**Performance Goals**: Proposed for owner confirmation after a baseline (SC-005, R-18): navigate p95 overhead ≤ 25 ms and snapshot p95 overhead ≤ 30 ms with memory on; capture commit p95 ≤ 50 ms; daemon start overhead ≤ 50 ms; idle RSS growth ≤ 10 MiB; zero queue drops with 4 concurrent IPC clients.

**Constraints**:
- Memory never changes a browser outcome, timeout, retry or tab ownership.
- Bounded output: reminder ≤ 8 lines and ≤ 600 characters; `browser_memory` ≤ 50 items and ≤ 4,000 characters per page.
- Bounded queue of 256 operations and a 2 s commit timeout.
- Store capacity: ≤ 64 facts per origin, ≤ 5,000 origins, ≤ 32 MiB in total; at capacity, new captures are dropped and existing records are kept.
- Local only: no network I/O in the memory module.
- Fail closed when profile, origin, privacy or vault state is unknown.

**Scale/Scope**: One owner, up to a few connected profiles, up to tens of concurrent agent sessions on one daemon; thousands of origins at most.

No `NEEDS CLARIFICATION` remains: each unknown is resolved in [research.md](research.md). The items in *Owner review gates* below are approvals, not open requirements.

## Constitution Check

*GATE: Check applicable requirements before Phase 0 research and re-check after Phase 1 design.*

Source checked: root `constitution.md` SHA-256 `2b2d4700e6364c1e898c90ddaff5923393bc977d605353286624c1d7b7f40b17` matches the fingerprint recorded in `.specify/memory/constitution.md` (version 4.1.0, status *proposed*, not adopted). The constitution's checks are listed separately from the requirements that apply today.

### Applicable now (`AGENTS.md`, owner instructions)

| Requirement | Pre-design | Post-design |
|---|---|---|
| Spec Kit pauses for spec and plan review | PASS: this plan is a draft for review | PASS |
| Keep schemas in `mcp-server/src/tools/`, registration in `register-tools.ts`/`tools/index.ts`, browser behavior in handlers | — | PASS: `tools/memory.ts`; extension logic in `extension/lib/site-context.js` |
| Preserve timeouts, tab ownership, retries, protocol compatibility | — | PASS: memory runs after the outcome; old extensions fail closed through capability `site-context` (R-04, R-15) |
| Vault fill never clicks Submit; vault data never leaks | — | PASS: no capture or reminder while the profile has a protected or unknown vault document (R-06) |
| No secrets in commits, logs or memory; page data is not instructions | — | PASS: values come only from fixed lexicons; cookie and storage values are never read into results (R-07, R-08) |
| No installs, upgrades or external services without authorization | PASS | PASS: no new dependency; Mnemon prototype and `npm run security:audit` stay gated (R-01, R-19) |
| Regression tests for protocol, tab ownership, timeouts, redaction; CI scripts on Node 20 and 22 | — | PASS: test plan in [quickstart.md](quickstart.md) |
| 600-line module cap (`tests/architecture-maintenance.test.ts`) | — | PASS by design: new logic goes into new modules; `bridge.ts` (593 lines) gets no logic, and its call-site change goes through `bridge-frames.ts` |

### Proposed constitution checks (not binding until adopted)

| Article | Check | Status |
|---|---|---|
| 2 Risk tiers | `CRITICAL` (persists data from authenticated contexts, changes the extension permission set) | Proposed; owner confirms |
| 3 Authorization | Implementation, the `cookies` permission, commits, pushes, the Mnemon prototype and the audit each need explicit owner authorization | Recorded in *Owner review gates* |
| 6 Spec and contract | Machine-readable contracts in [contracts/](contracts/) | Drafted; the contract hash and CI recompute are not available until the CI policy exists |
| 7 ADR | ADRs for the storage choice (R-01), the `cookies` permission (R-07) and the owner-control channel (R-13) | To be written with tasks; status `proposed` |
| 16 Testing (`EVOLVE`) | Full regression plus contract, integration, concurrency, failure, recovery and privacy tests | Planned |
| 19/22 Merge and done | Independent review; owner approval on the PR; local checks reported apart from CI | Planned; formal acceptance pending |
| 21 Security and licenses | No new dependency; untrusted page data; local only | PASS |
| 24 Token budget | `CRITICAL` needs an owner-approved implementation budget | Proposed: owner sets it before implementation; usage is recorded per phase, `UNAVAILABLE` where the provider gives none |

**Gate result**: PASS for planning. No unjustified violation. Additions that raise complexity are listed in *Complexity Tracking*.

## Owner review gates (before `$speckit-tasks` / implementation)

1. Accept or amend [spec.md](spec.md), including the conservative reading of AC-22/AC-30 (R-09). **Accepted 2026-10-27, unamended.**
2. Approve adding the `cookies` extension permission (R-07). Without it, page-content facts stay off and only visit observations are recorded. **Approved 2026-10-27.** See [docs/adr/0002-extension-cookies-permission.md](../../docs/adr/0002-extension-cookies-permission.md) (status updated to `accepted`).
3. Review [contracts/fact-allowlist.json](contracts/fact-allowlist.json): roles, the English and Arabic phrase lexicon, path segments, and consent or analytics cookie and storage names. **Approved 2026-10-27, unamended** (roles, EN/AR phrase groups — account, consent, navigation, commerce, forms —, path segments, and the cookie/storage anonymity names reviewed as drafted).
   - Amended 2026-10-28 at the owner's request (widen coverage); additions listed in contracts/fact-allowlist.json v2, chosen from a names-only survey of public sites; the owner may trim any entry.
4. Confirm or change the proposed thresholds after the baseline run (R-18).
5. Set the implementation token budget (constitution Art. 24, proposed). **Approved 2026-10-27: 2,000,000 tokens total for Phases 2–8 (T013–T074)** — Phase 2 (daemon memory core: store.ts, queue.ts, policy) ~500K, Phase 3 (extension site-context + IPC wiring) ~400K, Phase 4 (`browser_memory`/`browser_memory_policy` tools) ~350K, Phase 5 (tests: protocol/boundaries/policy-tool) ~450K, Phases 6–8 (docs sync, optional Mnemon experiment, polish) ~300K. Usage recorded per phase in this file as work proceeds; `UNAVAILABLE` where no figure exists.
   - **Phase 2 usage**: 6 forks reported `subagent_tokens` of 189,346 + 199,192 + 201,068 + 180,763 + 252,933 + 279,305 = 1,302,607, against a ~500K allocation. The figure is the harness's per-agent total and probably counts the conversation context each fork inherits, so it overstates new work; the main session's own usage is `UNAVAILABLE`. Treat the Phase 2 allocation as exceeded and review the remaining split with the owner before Phase 3.
   - **Phase 3 usage**: 2 forks reported 272,400 + 315,824 = 588,224 `subagent_tokens` (same caveat), against ~400K (extension/IPC wiring) + ~350K (tools) allocated. Cumulative forks: 1,890,831 of the 2,000,000 total, with Phases 4–8 still to do. The main session's own usage is `UNAVAILABLE`. The owner has not yet answered the budget question; the remaining phases need a revised budget.
   - **Phase 4 usage**: 2 forks reported 302,103 + 284,625 = 586,728 `subagent_tokens` (same caveat). Cumulative forks: 2,477,559, which is **over** the approved 2,000,000. Work continued on the owner's repeated 'start phase N' instructions, and on 2026-10-28 the owner lifted the token limit ("continue without limits"). Usage is still recorded per phase. This lifts only the token budget: commits, pushes, real-Chrome runs, `security:audit` and the Mnemon experiment still need their own authorization.

## Project Structure

### Documentation (this feature)

```text
specs/003-website-agent-memory/
├── spec.md                       # Draft spec (owner review pending)
├── implementation-outline.md     # Earlier discussion aid (superseded by this plan where they differ)
├── plan.md                       # This file
├── research.md                   # Phase 0 decisions R-01…R-20
├── data-model.md                 # Phase 1 entities, validation, state transitions
├── quickstart.md                 # Phase 1 validation guide (AC → test mapping)
├── contracts/
│   ├── README.md                                  # Behavior, formats, error codes
│   ├── browser-memory-tool.schema.json            # MCP tool input and result
│   ├── browser-memory-policy-tool.schema.json     # NEW: browser_memory_policy MCP tool input/result (FR-004, AC-32)
│   ├── site-context.schema.json                   # Extension → daemon result block
│   ├── memory-admin-ipc.schema.json               # CLI ↔ daemon IPC messages
│   ├── memory-store.schema.json                   # On-disk policy and site records
│   └── fact-allowlist.json                        # Reviewed allowlist (owner gate 3)
├── checklists/requirements.md
├── baseline.md                    # NEW: T012 baseline measurements (memory off, Node 20 and 22)
├── review.md                      # NEW: T072 independent security review
└── tasks.md                      # Phase 2 ($speckit-tasks)
```

```text
docs/adr/
├── 0001-website-memory-store.md           # NEW: storage choice, Mnemon as optional experiment (R-01)
├── 0002-extension-cookies-permission.md   # NEW: cookies permission (R-07)
└── 0003-website-memory-policy-control.md  # NEW: owner CLI + confirmed agent requests (R-13)
```

### Source Code (repository root)

```text
mcp-server/src/
├── memory/                       # NEW: daemon-owned website memory
│   ├── service.ts                # MemoryService facade: afterCall, handleTool, admin, status
│   ├── scope.ts                  # Profile/origin/privacy/vault eligibility (fail closed)
│   ├── facts.ts                  # Snapshot → candidate facts through the allowlist
│   ├── allowlist.ts              # The reviewed allowlist as code; a test keeps it equal to contracts/fact-allowlist.json
│   ├── queue.ts                  # Bounded single-writer queue, op-id dedupe, commit-time policy recheck
│   ├── store.ts                  # Per-origin JSON records: atomic replace, quarantine, LRU cache (MemoryStore interface)
│   ├── mnemon-store.ts           # NEW, optional experiment: MemoryStore adapter, selected only via BC_MEMORY_STORE=mnemon (FR-013)
│   ├── policy.ts                 # policy.json: enabled, exclusions, deletion tombstones
│   ├── output.ts                 # Reminder and browser_memory text (bounds, provenance, labels)
│   └── admin.ts                  # memory-admin IPC handler (enable/disable/exclude/inspect/export/delete/status)
├── tools/memory.ts               # NEW: browser_memory ToolDefinition, read-only (daemon-owned, like browser_vault)
├── tools/memory-policy.ts        # NEW: browser_memory_policy ToolDefinition; owner-confirmed policy changes (FR-004, AC-32)
├── tools/index.ts                # register browser_memory and browser_memory_policy
├── tools/batch.ts                # carry a step's memory lines into the batch notes (AC-27)
├── daemon.ts                     # construct MemoryService; route browser_memory, browser_memory_policy and memory-admin; afterCall hook
├── daemon-config.ts              # IPC message kind memory-admin (types only)
├── protocol.ts                   # capability names site-context / memory-admin
├── bridge-frames.ts              # carry the observe flag on the extension request
├── wire-tools.ts                 # internal action browser_memory_internal_context
└── vault/
    ├── daemon-routing.ts         # pass observe; take siteContext out of the result before sanitizing
    └── service-protection.ts     # read-only memoryEligibility(browserId, tabId)

extension/
├── manifest.json                 # + "cookies" permission (owner gate 2)
├── lib/site-context.js           # NEW: siteContext (URL, incognito, top-level, lang/dir, password-field flag, anonymity verdict; anonymity names kept equal to the contract by a test)
├── lib/protocol.js               # advertise capability site-context
└── dispatch/router.js            # attach siteContext for navigate/snapshot when the request says observe; internal context action

scripts/
├── memory.mjs                    # NEW: owner CLI over daemon IPC (npm run memory -- <command>)
├── memory-bench.mjs              # NEW: R-18 workload runner; baseline and on/seeded measurements (T012, T065)
└── pages/memory/                 # NEW: synthetic fixtures (public, cookie, storage, planted markers, hostile text, redirect, iframe)

tests/
├── memory-allowlist.test.ts      # lexicon, normalization, path segments, fact identity
├── memory-store.test.ts          # atomic replace, crash points, corrupt file quarantine, capacity, Windows rename retry
├── memory-queue.test.ts          # bounds, dedupe, disable/exclude/delete vs queued work, timeouts
├── memory-scope.test.ts          # profile/origin/incognito/vault/redirect/iframe fail-closed rules
├── memory-output.test.ts         # reminder and tool output bounds, labels, cross-profile provenance
├── memory-daemon.test.ts         # agent A → B across sessions and restart; batch; tool; admin IPC
├── memory-privacy.test.ts        # planted markers absent from store, outputs, export, diagnostics; network sink
├── memory-boundaries.test.ts     # NEW: FR-012 — no procedures stored; memory module never touches skill/agent-config paths
├── extension-site-context.test.ts # anonymity verdict, pre/post URL check, cookie and storage name rules
└── helpers/memory-fixtures.ts
```

**Structure Decision**: Single project, matching the existing layout. Memory logic lives in a new `mcp-server/src/memory/` module owned by the daemon. The extension change is limited to one new library module and router wiring. Large modules near the 600-line cap (`bridge.ts` 593, `inspection.js` 588, `daemon.ts` 574) only get call-site hooks.

## Delivery sequence (for `$speckit-tasks`)

1. **Contracts and allowlist** (owner gates 1–3): finalize the schemas and fixtures; write the three ADRs as `proposed`.
2. **Baseline**: measure the current daemon on the synthetic workload (R-18) on Node 20 and 22.
3. **Store, policy and queue**, test-first: atomicity, crash recovery, tombstones, capacity, Windows rename.
4. **Scope and siteContext**: extension block and capability, daemon eligibility, vault query, fail-closed matrix.
5. **Capture**: visits from navigate; facts from snapshot (standalone, `navigate {snapshot:true}`, batch steps).
6. **Retrieval**: reminder on navigate, batch notes, `browser_memory`, cross-profile provenance.
7. **Owner CLI and `browser_memory_policy`**: enable, disable, exclude, include, inspect, export, delete, status; MCP-side owner confirmation through `register-tools.ts` elicitation.
8. **Privacy, injection, failure and concurrency suites**, network sink, restart.
9. **Measure against baseline**; owner confirms thresholds.
10. **Docs** (README memory section, SECURITY.md threat model, CHANGELOG), full gate (`lint`, `typecheck`, `build`, `test:coverage`, `context:lint`; `security:audit` only with authorization), independent security review.

## Complexity Tracking

| Addition | Why Needed | Simpler Alternative Rejected Because |
|---|---|---|
| `cookies` extension permission | Public status must account for HttpOnly cookies the page cannot see (FR-006, AC-22) | Page-side `document.cookie` misses HttpOnly session cookies; CDP `Network.getCookies` needs a debugger attach (banner) on every read; webRequest `extraHeaders` adds overhead to every request and misses tokens kept in storage |
| New IPC message kind `memory-admin` | The owner CLI controls policy over daemon IPC, apart from the agent-facing tool (FR-004) | Editing `policy.json` directly races the daemon writer; routing the CLI through the same `MemoryService.admin` path as the MCP tool keeps one code path for every policy change |
| New MCP tool `browser_memory_policy`, kept apart from `browser_memory` | An agent may request a policy change, but only the owner's confirmation in the agent client makes it effective (2026-10-27 clarification, FR-004, AC-32) | Letting `browser_memory` itself accept policy actions would force every client to prompt on a read tool; applying a request without confirmation would let a prompt-injected agent enable memory or remove exclusions |
| New wire field `observe` and result block `siteContext` | Origin, incognito and anonymity must come from the browser, not caller params (FR-005) | Parsing the result text is brittle and cannot tell incognito state or anonymity; a separate probe call adds a round trip and a race |
| Daemon-owned `browser_memory` tool plus internal context action | Detail retrieval bound to the tab's verified origin (FR-011, AC-26) | Accepting an origin parameter lets an agent read other origins' memory; reusing `browser_tabs list` exposes unrelated tabs |
