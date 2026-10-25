# Verification record: Credential vault V1

Updated 2026-10-25. This records observed evidence and remaining gaps; source tests and the isolated browser run are not a proof against arbitrary page transformations or a compromised same-user process.

## Checks performed

| Check | Result | Evidence |
| --- | --- | --- |
| Typecheck | Pass | `npm run typecheck` |
| Build | Pass | `npm run build` |
| Lint | Pass | `npm run lint` |
| Focused vault, daemon, extension and architecture tests | Pass: 125 tests across 10 files; later daemon/router/architecture subset: 41 tests across 3 files | `npx vitest run tests/vault-store.test.ts tests/vault-service.test.ts tests/vault-redaction.test.ts tests/bridge-vault.test.ts tests/daemon.test.ts tests/extension-vault.test.ts tests/extension-shield.test.ts tests/wp5-network-events.test.ts tests/tools/forward-handler.test.ts tests/architecture-maintenance.test.ts --reporter dot`; `npx vitest run tests/daemon.test.ts tests/extension-router.test.ts tests/architecture-maintenance.test.ts --reporter dot` |
| Full suite | Pass: 1,132 tests across 89 files | `npm test -- --reporter dot` |
| Actual MCP and disposable Chrome smoke | Pass | `VAULT_PLAYWRIGHT_MODULE=…/playwright/index.mjs VAULT_CHROME_EXECUTABLE=… npm run smoke:vault-isolated`; Chrome for Testing 145.0.7632.6, Playwright 1.62.1, temporary extension copy/profile, isolated daemon/state/ports, and generated loopback fixture pages at `/login/one` and `/login/two` on `127.0.0.1`. No user profile or live daemon was used. |
| Code knowledge index | Refreshed; artifact persistence uncertain | `codebase-memory-mcp index_repository` (`moderate`, `persistence=false`) and `index_status`: expected repository root/branch, ready, 4,128 nodes and 12,716 edges. Two known parse-partial test files remain; `.codebase-memory` is excluded from indexing. The repository's memory artifacts were already dirty before this implementation and remain unstaged; their current content was preserved. |

The initial smoke made 20 actual MCP fill calls across two fixture pages. A follow-up run after the UI refresh fix repeated the same 20 fills and 20 ready-state list calls. Each password field was cleared before its call and checked immediately through the fixture oracle. On the follow-up run, fill latency was p50 **23.7 ms**, p95 **24.9 ms**; list latency was p50 **6.4 ms**, p95 **11.3 ms**. All 40 measured calls were below two seconds.

The rendered private UI was exercised with keyboard input only for setup, save-and-fill, lock, renewed approval, revoke and delete. The smoke confirmed typed fields and focus survive the five-second refresh, displayed the consent validation error and decline/cancel state, and confirmed closing the private page cancels a pending request. It also confirmed protected evaluation, screenshot and nested batch calls are denied; a page-authored password string is scrubbed; the password is absent from extension storage, daemon state and captured MCP/daemon/browser logs; vault key uploads and symlink aliases are rejected; and internal actions are absent from the MCP tool list.

The smoke uses one generated synthetic password, while unit tests separately cover short, Unicode, overlapping and one-character redaction collisions. Diagnostics are scrubbed before printing; raw fixture credentials are not part of this record.

## Success criteria

| Criterion | Status | Evidence and remaining limit |
| --- | --- | --- |
| SC-001 | Pass | 20/20 actual MCP fills succeeded across two isolated login fixtures, with an immediate page-side check after every fill. |
| SC-002 | Partial | Unit tests cover wrong origin, same-origin and cross-origin frames, stale document/frame targets, connection replacement, foreign session/profile grants and no-write behavior. The isolated browser run did not execute the entire wrong-origin/account/session/profile/document/nonce matrix against the real extension. |
| SC-003 | Partial | Unit tests cover short, Unicode-normalized, overlapping and colliding values. The isolated smoke scanned MCP results, daemon/MCP/browser logs, extension storage and daemon files for its synthetic password and enrollment material. It did not run every sentinel class through every public tool, error, image, network and logging path in the actual MCP process. |
| SC-004 | Partial | Actual MCP attempts to evaluate, screenshot and run a nested batch were denied before an evaluate side effect. Unit tests cover profile-wide gating, mock/raw-log restrictions and recovery protection. Runtime mock/raw-log attempts and return to a protected BFCache/restored document remain unverified. |
| SC-005 | Partial | Unit tests cover separate sessions, connection epochs, browser scope selection and replacement isolation. Runtime smoke exercised two MCP sessions on one disposable browser profile, including explicit cross-session list approval; it did not run ten interleaved cycles across two separate browser identities. |
| SC-006 | Pass | Keyboard-only private UI flow completed save/use/lock/reapprove/revoke/delete. Pending, consent-error, decline/cancel and close-cancellation states were asserted; typed values and focus survived a five-second refresh. |
| SC-007 | Partial | Store/service/extension tests cover concurrent writes, pre-commit failure, lock initialization failure, corrupt or missing keys, permissions/symlinks, explicit recovery restore, cancellation and no automatic retry. A process crash at each restore-journal stage and an end-to-end daemon-restart recovery cycle were not exercised. |
| SC-008 | Pass | 20/20 actual ready-state list calls and 20/20 fill calls were below two seconds; observed p95 was 7.5 ms for list and 23.0 ms for fill. User approval and vault-opening time were excluded. |

## Requirement evidence map

| Requirements | Evidence paths |
| --- | --- |
| FR-001, FR-020–FR-023 | `mcp-server/src/vault/store.ts`, `store-format.ts`; `tests/vault-store.test.ts`; private backup/restore UI. |
| FR-002–FR-014 | `mcp-server/src/tools/vault.ts`, `mcp-server/src/vault/`, `mcp-server/src/vault/bridge-transport.ts`, `extension/lib/vault.js`, `extension/vault/`; contract, service, bridge, extension and actual MCP smoke tests. |
| FR-015–FR-018 | `mcp-server/src/vault/redaction.ts`, `daemon-routing.ts`, `extension/lib/vault.js`, `extension/events.js`; redaction, daemon, extension lifecycle and isolated output-gate tests. |
| FR-019 | `mcp-server/src/vault/service-protection.ts`, `mcp-server/src/bridge-connections.ts`; service/bridge connection-replacement tests. |
| FR-024–FR-025 | `mcp-server/src/vault/service-private.ts`, `service-core.ts`; service/store tests for cancellation, unknown fill outcomes and bounded pseudonymous audit data. |
| FR-026 | `extension/vault/` and private UI; isolated keyboard and focus checks. |
| FR-027 | This record, `quickstart.md`, `README.md` and `SECURITY.md`. |

## Runtime boundaries and remaining work

The fill path uses bounded `chrome.scripting` isolated-world calls targeted to verified document IDs, as documented in the plan. It does not use a CDP transport. It supports inspected same-origin frames and open shadow roots; unrelated cross-origin widgets are ignored and targets inside cross-origin frames are rejected.

During the reported local `VAULT_STORAGE_INVALID` incident, the daemon state directory was owned by the current user but had mode `0755`, which the vault correctly rejects. Its mode was tightened to `0700`; no vault data files existed, and a status check against the same state root returned `empty`. The private page itself was not inspected through browser tools. The UI now also clears a stale storage-error notice on the next successful five-second state refresh. Close and reopen an already-open private vault page after reloading the extension so it loads the updated UI script.

The repository's `scripts/smoke-real-chrome.mjs` targets a real profile and was not used. The isolated harness rewrites only a temporary extension copy to use a generated port and disables its native-pair fallback before browser startup. During the smoke, no user profile, secret files or pairing registration were touched, and temporary smoke data was removed. After verification, the process-managed daemon for this repository was restarted from the current build to activate vault capability. A read-only Browser Controller tab-list request then succeeded. The active Codex MCP tool catalog has not reloaded and still does not expose `browser_vault`; restart the MCP client/Codex session to refresh its tool list. No user tabs were modified.

The code graph refresh used `persistence=false`, but the provider's persisted-artifact effect is uncertain. `.codebase-memory/artifact.json` and `.codebase-memory/graph.db.zst` were already dirty before this work; they were left unstaged and were not reset. The graph remains a best-effort navigation aid, not a completeness or security proof.

Remaining acceptance gaps are the SC-002–SC-005 and SC-007 runtime matrices listed above. Source-level coverage is useful evidence but does not convert those runtime rows to pass.
