---
version: v0.1.0
mode: EVOLVE
risk_tier: "CRITICAL"
tier_decision: "Owner, 2026-10-27"
status: scaffold
---

# F3 Bridge, wire protocol, multi-browser

Scaffold for Constitution v4.1.0 (PROPOSED, not adopted) Art 2 and Art 6. It lists gaps. It does not claim compliance.

## Goal

Carry tool calls from the daemon to the paired extension and results back, over one versioned WebSocket protocol, with several browsers.

## Scope

Main files (from 09 section 2, checked to exist):

- `mcp-server/src/bridge.ts`
- `mcp-server/src/bridge-connections.ts`
- `mcp-server/src/bridge-frames.ts`
- `mcp-server/src/bridge-tabs.ts`
- `mcp-server/src/protocol.ts`
- `extension/lib/connection.js`
- `extension/lib/protocol.js`

Out of scope:

- Proof exchange (F2), tool schemas (F6).

## Requirements sources

- `docs/audit/05-architecture-analysis.md` ADR-01 (one source of truth for the wire protocol), ADR-04 (split `ExtensionBridge`)
- `SECURITY.md` "Known Limitations": upgrade compatibility
- `specs/002-daemon-authentication/contracts/websocket-auth.md` (auth steps only)

## Contract

None for the wire protocol. Constants live in `mcp-server/src/protocol.ts` and `extension/lib/protocol.js`; a parity test compares validators and capability lists (09 F3-1).

## Acceptance criteria

Not yet specified.

## Open findings from 09

- F3-4 (P3): cancel is broadcast to every browser; 09 calls it a design note.
- F3-7 (P3): `connection.js` mixes transport with pairing, badge and popup setters.
- ADR-04 (split `ExtensionBridge`) is not done: pending-call extraction only.

## Open / not yet specified

- Goal-level spec and G/W/T for hello, call, result, cancel, reconnect, multi-browser
- Frame schemas (AsyncAPI or JSON Schema)
- Side effects, limits (4 MiB buffer is in code only), error codes
- Version-compatibility rules as a contract
- Approver sign-off
- Contract fingerprint (Art 6): not in place; see `specs/contracts/README.md`

## Approver

Owner.

## Evidence

`specs/evidence/bridge-protocol/manifest.json`. Local verification only.
