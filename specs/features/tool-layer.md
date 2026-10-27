---
version: v0.1.0
mode: EVOLVE
risk_tier: "CRITICAL"
tier_decision: "Owner, 2026-10-27"
status: scaffold
---

# F6 Tool layer and extension dispatch

Scaffold for Constitution v4.1.0 (PROPOSED, not adopted) Art 2 and Art 6. It lists gaps. It does not claim compliance.

## Goal

Expose browser tools to MCP clients with validated schemas, and route each call to its extension handler.

## Scope

Main files (from 09 section 2, checked to exist):

- `mcp-server/src/tools/*.ts`
- `mcp-server/src/register-tools.ts`
- `mcp-server/src/tools/batch.ts`
- `mcp-server/src/tools/action-support.ts`
- `mcp-server/src/wire-tools.ts`
- `extension/dispatch/router.js`

Out of scope:

- Handler behaviour (F7 to F9), transport (F3).

## Requirements sources

- `docs/audit/05-architecture-analysis.md` ADR-05 (router is a composition root)
- `README.md` tool list
- `SECURITY.md` "Optional browser action policy"

## Contract

Zod schemas in `mcp-server/src/tools/*.ts` are the machine-readable contract (09 section 2: 18 of 19 tools). They are not exported as JSON Schema files. `browser_batch` step params are `z.record(z.unknown())` (F6-2).

## Acceptance criteria

Not yet specified.

## Open findings from 09

- F6-2 (P3): batch step params are untyped by design (token trade-off).
- F6-3 (P3): `routeCall` forwards any tool name; validation exists only in the MCP process.
- F6-6 (P3): `browser_batch.timeoutMs` is inert for transport.
- F6-8 (P3): uncoded throws become `INTERNAL_ERROR`; count not measured.

## Open / not yet specified

- G/W/T per tool
- Generated JSON Schema file per tool (next step in `specs/contracts/README.md`)
- Error-code catalogue
- Side effects and permissions per tool
- Approver sign-off
- Contract fingerprint (Art 6): not in place; see `specs/contracts/README.md`

## Approver

Owner.

## Evidence

`specs/evidence/tool-layer/manifest.json`. Local verification only.
