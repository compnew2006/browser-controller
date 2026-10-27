---
version: v0.1.0
mode: EVOLVE
risk_tier: "CRITICAL"
tier_decision: "Owner, 2026-10-27"
status: scaffold
---

# F5 Credential vault

Scaffold for Constitution v4.1.0 (PROPOSED, not adopted) Art 2 and Art 6. It lists gaps. It does not claim compliance.

## Goal

Store credentials encrypted on the daemon host. Fill them into pages by opaque handle without exposing the secret to the model.

## Scope

Main files (from 09 section 2, checked to exist):

- `mcp-server/src/vault/` (service, store, grants, requests, operations, redaction, fill and related files)
- `extension/vault/vault-page.js`
- `extension/lib/vault-actions.js`
- `extension/lib/vault-connection.js`
- `mcp-server/src/tools/vault.ts`

Out of scope:

- Page input mechanics (F7), redaction of non-vault secrets (F9).

## Requirements sources

- `specs/001-credential-vault/` (spec, plan, data-model, research, quickstart, tasks, verification, checklists)
- `specs/001-credential-vault/contracts/vault.md` (prose)
- `docs/audit/05-architecture-analysis.md` ADR-02 (composition over inheritance)
- `SECURITY.md` "Credential vault"

## Contract

Prose: `specs/001-credential-vault/contracts/vault.md`. Zod schema in `mcp-server/src/tools/vault.ts`. `tests/vault-contracts.test.ts` exists. Not machine-readable as a standalone file.

## Acceptance criteria

Exist: `specs/001-credential-vault/spec.md` (22/22 tasks per 09 section 2) and `verification.md`.

## Open findings from 09

- F5-3 (P3): backups embed the key and keep deleted credentials.
- F5-4 (P3, KNOWN, documented): plaintext `.key` beside the ciphertext, no KDF.
- F5-6 (P3): every get, list and fill decrypts the whole vault.
- F5-8 (P3, KNOWN): service split is an inheritance chain (ADR-02 parked).
- R-1 (partly): split or chunked secret forms are not scrubbed.

## Open / not yet specified

- Machine-readable contract file
- Fingerprint and link from contract to tests
- Approver sign-off
- Backup retention and purge rules are not specified
- Contract fingerprint (Art 6): not in place; see `specs/contracts/README.md`

## Approver

Owner.

## Evidence

`specs/evidence/credential-vault/manifest.json`. Local verification only.
