---
version: v0.1.0
mode: EVOLVE
risk_tier: "CRITICAL"
tier_decision: "Owner, 2026-10-27"
status: scaffold
---

# F7 Page interaction and trusted input

Scaffold for Constitution v4.1.0 (PROPOSED, not adopted) Art 2 and Art 6. It lists gaps. It does not claim compliance.

## Goal

Click, type, fill, drag and upload through real input, behind an optional action-safety policy that fails closed.

## Scope

Main files (from 09 section 2, checked to exist):

- `extension/lib/trusted-input.js`
- `extension/handlers/interaction.js`
- `extension/handlers/interaction-advanced.js`
- `extension/handlers/action-safety.js`
- `mcp-server/src/tools/fill.ts`
- `mcp-server/src/tools/safety.ts`
- `mcp-server/src/tools/action-support.ts`

Out of scope:

- Ref issuance (F8), vault secrets (F5).

## Requirements sources

- `docs/audit/10-decision-records.md` ADR-06 (`browser_evaluate` gated by the site action)
- `SECURITY.md` "Optional browser action policy" and residuals for `SAFETY_TARGET_CHANGED`
- `docs/audit/05-architecture-analysis.md` ADR-03 (bundle injected page scripts; not done)

## Contract

None. Tool zod schemas (F6) cover inputs. The internal wire field `expectFingerprints` and the codes `ACTION_BLOCKED`, `SAFETY_CHECK_FAILED`, `SAFETY_TARGET_CHANGED` are in code only.

## Acceptance criteria

Not yet specified.

## Open findings from 09

- F7-4 (P3, KNOWN): `trusted-input.js` mixes CDP plumbing with locate policy.
- F7-6 (P3): `screenshot.js` and `inspection.js` import input internals from `trusted-input.js`.
- Residual in `SECURITY.md`: a same-element in-place change keeps its fingerprint; select, picker and file fields are checked up front only.

## Open / not yet specified

- Spec for the safety policy (allow, block, ask) and the classify-then-act check
- G/W/T, side effects, edge cases
- Contract for gate receipts (`not_dispatched`) and refusal codes
- Approver sign-off
- Contract fingerprint (Art 6): not in place; see `specs/contracts/README.md`

## Approver

Owner.

## Evidence

`specs/evidence/page-interaction/manifest.json`. Local verification only.
