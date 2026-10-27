---
version: v0.1.0
mode: EVOLVE
risk_tier: "CRITICAL"
tier_decision: "Owner, 2026-10-27"
status: scaffold
---

# F2 Daemon auth and pairing

Scaffold for Constitution v4.1.0 (PROPOSED, not adopted) Art 2 and Art 6. It lists gaps. It does not claim compliance.

## Goal

Only the paired extension can drive the browser. Peers prove an enrollment secret and a token by HMAC over HTTP and WebSocket.

## Scope

Main files (from 09 section 2, checked to exist):

- `mcp-server/src/bridge-auth.ts`
- `mcp-server/src/bridge-http.ts`
- `mcp-server/src/bridge-security.ts`
- `mcp-server/src/native-host.ts`
- `extension/lib/daemon-auth.js`
- `extension/popup/popup.js`
- `scripts/pairing.mjs`

Out of scope:

- Frame routing after auth (F3), IPC attach (F1).

## Requirements sources

- `specs/002-daemon-authentication/spec.md`, `plan.md`, `data-model.md`, `tasks.md`, `verification.md`
- `specs/002-daemon-authentication/contracts/http-auth.md`, `websocket-auth.md` (prose)
- `docs/audit/10-decision-records.md` ADR-10 (secret rotation)
- `SECURITY.md` "Known Limitations" (first-contact impersonation, residual risk, enrollment secret, breaking change)

## Contract

Prose: `specs/002-daemon-authentication/contracts/http-auth.md` and `websocket-auth.md`. Not machine-readable. Transcripts are hand-duplicated in TS and JS.

## Acceptance criteria

Exist: `specs/002-daemon-authentication/spec.md` (Given/When/Then and success criteria) and `checklists/requirements.md`. `verification.md` exists. T020 in `tasks.md` stays open (per 09 F2-7).

## Open findings from 09

- F2-4 (P3, observed): auth transcripts are duplicated in TS and JS; parity is tested, a shared vector file is optional.
- T020 in `specs/002-daemon-authentication/tasks.md` (09 F2-7).

## Open / not yet specified

- Machine-readable contract for the HTTP and WebSocket auth messages
- Link from each contract step to a behavioural test (Art 6)
- Approver sign-off on the F2-8 protocol change (09 marks it "needs Owner review")
- Contract fingerprint (Art 6): not in place; see `specs/contracts/README.md`

## Approver

Owner.

## Evidence

`specs/evidence/daemon-auth/manifest.json`. Local verification only.
