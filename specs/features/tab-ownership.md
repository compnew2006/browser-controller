---
version: v0.1.0
mode: EVOLVE
risk_tier: "CRITICAL"
tier_decision: "Owner, 2026-10-27"
status: scaffold
---

# F4 Tab ownership and Tab Control-Lock

Scaffold for Constitution v4.1.0 (PROPOSED, not adopted) Art 2 and Art 6. It lists gaps. It does not claim compliance.

## Goal

Give each agent session exclusive control of its tabs. The extension is the sole authority; a lock lives until its session ends.

## Scope

Main files (from 09 section 2, checked to exist):

- `extension/lib/state.js`
- `extension/lib/tab-concurrency.js`
- `extension/lib/lock-ops.js`
- `extension/handlers/tabs.js`
- `extension/dispatch/router.js`
- `mcp-server/src/tools/tabs.ts`

Out of scope:

- The daemon does not enforce ownership (ADR-08).

## Requirements sources

- `specs/tab-control-lock/` (spec, plan, tasks, review, audit, implementation report); the spec carries a superseded header
- `docs/audit/10-decision-records.md` ADR-07 (per-call shield and persisted locks supersede the spec), ADR-08 (no TTL; extension is sole authority)
- `SECURITY.md` "Known Limitations": shield hidden during screenshots, emulation on shared tabs, top-frame shield

## Contract

None machine-readable. `browser_tabs` zod schema is in `mcp-server/src/tools/tabs.ts`. The error codes `TAB_LOCKED` and `STATE_UNAVAILABLE` are in code only.

## Acceptance criteria

`specs/tab-control-lock/spec.md` has requirements but is superseded in part (ADR-07). Current acceptance criteria are not yet specified.

## Open findings from 09

- No open finding in 09 for F4. F4-1 to F4-4, F4-6 and F4-7 are resolved.

## Open / not yet specified

- A current spec that replaces the superseded one (Art 5: stale specs are not yet recorded as NON_CONFORMITY)
- G/W/T for lock, release, restore, orphan release
- Contract for lock errors and the `sessionRoster` frame
- Failure and recovery cases beyond F4-3 and F4-2
- Approver sign-off
- Contract fingerprint (Art 6): not in place; see `specs/contracts/README.md`

## Approver

Owner.

## Evidence

`specs/evidence/tab-ownership/manifest.json`. Local verification only.
