# Feature specs (scaffold)

Constitution v4.1.0 is PROPOSED, not adopted. These files scaffold Art 2 (risk tiers) and Art 6 (spec, contract, evidence per feature) for the nine audited features and proposed F10. They make gaps explicit. They do not claim compliance.

## Owner tier decision (2026-10-27)

- F1 to F7 are CRITICAL.
- F8 and F9 are CONTROLLED, except ref issuance and page-data handling (F8) and redaction and evaluate (F9), which are CRITICAL.

This follows the tiers proposed in 09 section 2. Per Art 2, a tier is not lowered after work starts without the Owner.

## Index

| ID | Feature | Tier | Mode | Existing spec | Contract | Evidence |
|---|---|---|---|---|---|---|
| F1 | [daemon-lifecycle](daemon-lifecycle.md) | CRITICAL | EVOLVE | none | none | [manifest](../evidence/daemon-lifecycle/manifest.json) |
| F2 | [daemon-auth](daemon-auth.md) | CRITICAL | EVOLVE | `specs/002-daemon-authentication/` | prose (specs/002/contracts) | [manifest](../evidence/daemon-auth/manifest.json) |
| F3 | [bridge-protocol](bridge-protocol.md) | CRITICAL | EVOLVE | none | none | [manifest](../evidence/bridge-protocol/manifest.json) |
| F4 | [tab-ownership](tab-ownership.md) | CRITICAL | EVOLVE | `specs/tab-control-lock/` (superseded in part) | none | [manifest](../evidence/tab-ownership/manifest.json) |
| F5 | [credential-vault](credential-vault.md) | CRITICAL | EVOLVE | `specs/001-credential-vault/` | prose (specs/001/contracts) | [manifest](../evidence/credential-vault/manifest.json) |
| F6 | [tool-layer](tool-layer.md) | CRITICAL | EVOLVE | none | zod schemas (tools/*.ts) | [manifest](../evidence/tool-layer/manifest.json) |
| F7 | [page-interaction](page-interaction.md) | CRITICAL | EVOLVE | none | none | [manifest](../evidence/page-interaction/manifest.json) |
| F8 | [inspection](inspection.md) | CONTROLLED; CRITICAL parts: ref issuance, page-data handling | EVOLVE | `specs/webmcp-support/` (superseded; feature removed) | none | [manifest](../evidence/inspection/manifest.json) |
| F9 | [devtools-surface](devtools-surface.md) | CONTROLLED; CRITICAL parts: redaction, evaluate | EVOLVE | none | none | [manifest](../evidence/devtools-surface/manifest.json) |
| F10 | [chrome-action-activity](chrome-action-activity.md) | CONTROLLED (implemented locally; formal review pending) | EVOLVE | `specs/009-chrome-action-activity/` | [JSON Schema](../contracts/chrome-action-activity.schema.json) (draft) | [manifest](../evidence/chrome-action-activity/manifest.json) |

All entries use version v0.1.0 and Owner review; F1–F9 remain scaffolds. F10 has a local implementation and verification record, but no independent review or formal Owner sign-off yet.

## Layout

- `specs/features/<slug>.md`: feature spec scaffold.
- `specs/contracts/README.md`: contract status per feature.
- `specs/evidence/<slug>/manifest.json`: local evidence references. Not CI, not Owner acceptance.

## Not done

- F10 has a draft machine-readable internal event contract and local behavior tests; its final contract review and Owner sign-off remain pending. F1–F9 contract gaps remain listed in `specs/contracts/README.md`.
- Given/When/Then scenarios exist in `specs/001-credential-vault/`, `specs/002-daemon-authentication/`, and the draft F10 spec. They are linked, not copied into these feature scaffolds.
- Stale specs are not yet recorded as `NON_CONFORMITY` (Art 5; 09 F4-1, F4-7, F8-4).
