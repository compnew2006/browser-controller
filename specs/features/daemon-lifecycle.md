---
version: v0.1.0
mode: EVOLVE
risk_tier: "CRITICAL"
tier_decision: "Owner, 2026-10-27"
status: scaffold
---

# F1 Daemon and MCP client lifecycle

Scaffold for Constitution v4.1.0 (PROPOSED, not adopted) Art 2 and Art 6. It lists gaps. It does not claim compliance.

## Goal

One local daemon per user. MCP clients attach over authenticated IPC. The daemon holds the IPC token, the session table and vault routing.

## Scope

Main files (from 09 section 2, checked to exist):

- `mcp-server/src/index.ts`
- `mcp-server/src/daemon.ts`
- `mcp-server/src/daemon-config.ts`
- `mcp-server/src/daemon-reconnect.ts`
- `mcp-server/src/lock-file.ts`
- `mcp-server/src/ipc-hello-timer.ts`
- `scripts/daemon.mjs`
- `deploy/systemd/browser-controller-daemon.service`

Out of scope:

- Wire protocol and bridge (F3), pairing and proofs (F2), vault internals (F5).

## Requirements sources

- `docs/audit/10-decision-records.md`: none for F1 (no ADR covers the daemon lifecycle)
- `SECURITY.md` "Known Limitations": upgrade compatibility (3.0 refuses pre-3.0 peers); enrollment secret printed to stderr on first run
- `specs/002-daemon-authentication/` (token and enrollment files shared with F2)

## Contract

No contract. The IPC hello and version check live in code (`daemon.ts`, `daemon-config.ts`). Not machine-readable.

## Acceptance criteria

Not yet specified for the lifecycle. Lock and hello-timer behaviour is pinned only by tests (see the evidence manifest).

## Open findings from 09

- F1-5 (P3): lock ownership is "pid alive"; pid reuse after a crash can look like a held lock.

## Open / not yet specified

- G/W/T for start, attach, stop, stale-lock takeover, hello timeout
- IPC I/O contract and versioning rules
- Permissions (file modes, who may attach)
- Edge cases beyond the lock tests
- Dependencies on F2/F3/F5 stated
- Approver sign-off
- Contract fingerprint (Art 6): not in place; see `specs/contracts/README.md`

## Approver

Owner.

## Evidence

`specs/evidence/daemon-lifecycle/manifest.json`. Local verification only.
