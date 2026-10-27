# Contracts (scaffold)

Art 6 of the proposed Constitution v4.1.0 asks for `specs/contracts/<feature>.<ext>`: a machine-readable contract per feature (JSON Schema, OpenAPI, AsyncAPI, or another approved format), linked to behavioural tests. The Constitution is not adopted. No contract file exists here yet.

## Status per feature

| ID | Feature | Current contract | Gap |
|---|---|---|---|
| F1 | [daemon-lifecycle](../features/daemon-lifecycle.md) | none | IPC hello and version rules are code only. Needs an AsyncAPI or JSON Schema for the IPC frames. |
| F2 | [daemon-auth](../features/daemon-auth.md) | `specs/002-daemon-authentication/contracts/http-auth.md`, `websocket-auth.md` (prose) | Prose is detailed but not machine-readable. Needs HTTP (OpenAPI) and WebSocket auth message schemas. |
| F3 | [bridge-protocol](../features/bridge-protocol.md) | none (constants in `protocol.ts`, `protocol.js`) | No wire contract. Needs frame schemas (AsyncAPI) for hello, call, result, cancel, sessionRoster. |
| F4 | [tab-ownership](../features/tab-ownership.md) | none (zod for `browser_tabs` in `tools/tabs.ts`) | None. Needs lock state and error-code contract (`TAB_LOCKED`, `STATE_UNAVAILABLE`). |
| F5 | [credential-vault](../features/credential-vault.md) | `specs/001-credential-vault/contracts/vault.md` (prose); zod in `tools/vault.ts` | Prose contract plus zod schema for `browser_vault`. Needs a schema file and links to `tests/vault-contracts.test.ts`. |
| F6 | [tool-layer](../features/tool-layer.md) | zod schemas in `mcp-server/src/tools/*.ts` | Zod schemas are the contract (09: 18 of 19 tools). Not exported as files. |
| F7 | [page-interaction](../features/page-interaction.md) | none (zod for click/type/fill in `tools/`) | None. Needs gate receipt and refusal-code contract. |
| F8 | [inspection](../features/inspection.md) | none (zod for snapshot/text/screenshot/navigate/wait in `tools/`) | None. Needs ref format and lifetime rules. |
| F9 | [devtools-surface](../features/devtools-surface.md) | none (zod for logs/mock/evaluate in `tools/`) | None. Needs redaction rule set and evaluate limits. |

## Open items

- Contract fingerprint rules are not in place: sha256 of the staged blob, `.gitattributes` `eol=lf` for contract files, and a CI recompute on the final commit. No contract file exists to fingerprint yet.
- Contract-to-test links (Art 6: each contract tied to behavioural tests) are not recorded.

## Next step

Generate JSON Schema from the tool zod schemas in `mcp-server/src/tools/*.ts`. That needs a script and a build, so it is not done here. No contract is written by hand, because a hand copy could drift from the schemas.
