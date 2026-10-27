---
version: v0.1.0
mode: EVOLVE
risk_tier: "CONTROLLED; CRITICAL parts: redaction, evaluate"
tier_decision: "Owner, 2026-10-27"
status: scaffold
---

# F9 DevTools surface (CDP)

Scaffold for Constitution v4.1.0 (PROPOSED, not adopted) Art 2 and Art 6. It lists gaps. It does not claim compliance.

## Goal

Expose console, network, response bodies, mocks and evaluate through one CDP session. Redact secrets. Bound evaluate output.

## Scope

Main files (from 09 section 2, checked to exist):

- `extension/lib/cdp-session.js`
- `extension/lib/network-capture.js`
- `extension/lib/response-bodies.js`
- `extension/lib/secret-keys.js`
- `extension/lib/cdp-evaluate.js`
- `extension/handlers/logs.js`
- `extension/handlers/mock.js`
- `extension/handlers/evaluate.js`

Out of scope:

- Safety gate for evaluate lives in F7/F6 (ADR-06).

## Requirements sources

- `docs/audit/10-decision-records.md` ADR-06
- `SECURITY.md` "Known Limitations": evaluation and CSP; evaluate is not a secret-safe channel
- `SECURITY.md` "Credential vault" (redaction)

## Contract

None. The secret-key policy is code in `extension/lib/secret-keys.js`. Tool zod schemas (logs, mock, evaluate) are in `mcp-server/src/tools/`.

## Acceptance criteria

Not yet specified.

## Open findings from 09

- F9-4 remainder: body capture has no TTL while the session is alive.
- F9-5 (P3): a mock with rules pins the debugger; documented.
- F9-6 (P3): evaluate size cap runs after full page-side `JSON.stringify`.
- F9-7 (P3, KNOWN): race helpers duplicated in `cdp-session.js`.
- R-1 (partly): split or chunked secret forms are not scrubbed.

## Open / not yet specified

- Redaction rules as a testable spec (which keys, which scalars, counters excluded)
- Evaluate output limits and error codes as a contract
- G/W/T for logs, mock, evaluate
- Approver sign-off
- Contract fingerprint (Art 6): not in place; see `specs/contracts/README.md`

## Approver

Owner.

## Evidence

`specs/evidence/devtools-surface/manifest.json`. Local verification only.
