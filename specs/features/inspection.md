---
version: v0.1.0
mode: EVOLVE
risk_tier: "CONTROLLED; CRITICAL parts: ref issuance, page-data handling"
tier_decision: "Owner, 2026-10-27"
status: scaffold
---

# F8 Inspection, navigation, wait

Scaffold for Constitution v4.1.0 (PROPOSED, not adopted) Art 2 and Art 6. It lists gaps. It does not claim compliance.

## Goal

Read pages (snapshot, text, screenshot), navigate and wait. Issue element refs. Hand page-derived data to the model as data.

## Scope

Main files (from 09 section 2, checked to exist):

- `extension/lib/page-dom.js`
- `extension/handlers/inspection.js`
- `extension/handlers/screenshot.js`
- `extension/handlers/navigation.js`
- `extension/lib/page-exec.js`
- `extension/lib/wait-page.js`

Out of scope:

- Input mechanics (F7), CDP logs (F9).

## Requirements sources

- `docs/audit/10-decision-records.md` ADR-09 (inspection format kept; server instruction guards page text)
- `docs/audit/05-architecture-analysis.md` ADR-03 (bundle injected page scripts)
- `specs/webmcp-support/` (superseded; feature removed in 3.0)
- `SECURITY.md` "Known Limitations": sensitive form masking, iframe boundary, frozen-tab navigation

## Contract

None. Zod schemas for snapshot, text, screenshot, navigate and wait are in `mcp-server/src/tools/`. The ref format (`e12`) is not specified outside code.

## Acceptance criteria

Not yet specified.

## Open findings from 09

- F8-1 (P3, KNOWN): `PAGE_DOM_INSTALL` is tested through fake-dom only.
- F8-5 (P3): `browser_wait` hard max 50 s vs tool timeout 55 s; poll loop not fully read in 09.

## Open / not yet specified

- Which parts are CRITICAL, as testable rules (ref validity, REF_GONE, masking)
- G/W/T for snapshot, text, navigate, wait
- Contract for ref lifetime and output format
- Current spec: `specs/webmcp-support/` is superseded (Art 5: not yet recorded as NON_CONFORMITY)
- Approver sign-off
- Contract fingerprint (Art 6): not in place; see `specs/contracts/README.md`

## Approver

Owner.

## Evidence

`specs/evidence/inspection/manifest.json`. Local verification only.
