# Verification quickstart: خزنة تسجيل الدخول بطريقة Hermes

This is a verification recipe, not evidence of passed implementation. Use generated synthetic credentials only and a temporary `BC_STATE_DIR`. Never inspect real Chrome password databases, project secret files or users' saved credentials.

## Prerequisites

Restore existing dependencies only if missing. Build the current source. Start an isolated daemon with separate state/IPC/WebSocket settings supported by the project, plus a disposable extension-enabled Chrome profile and loopback fixture. Do not restart or re-pair the user's live daemon. Verify actual endpoint/profile identity and cleanup ownership before mutating tabs.

The reusable integration harness is `npm run smoke:vault-isolated`. Build first, then set `VAULT_PLAYWRIGHT_MODULE` and `VAULT_CHROME_EXECUTABLE` to the host's existing Playwright module and Chrome for Testing binary if they are not resolvable from the project. The harness creates a temporary daemon state directory, disables native-pair fallback in a disposable extension copy, uses a separate port/profile and synthetic enrollment, runs actual MCP tool calls, and removes its temporary state. It must never be pointed at a real profile or existing daemon.

For local page inspection use the available Playwright MCP. For extension/real transport validation use the isolated Chrome harness and actual MCP client calls; internal handler calls alone do not satisfy integration acceptance. If the current MCP cannot attach to the isolated profile, document that exact gap and continue isolated automated checks.

## Required scenarios

1. Add a synthetic login through the private extension UI; verify masked entry, verified host/profile, keyboard/focus access, waiting/cancel/error states, correct RTL/LTR behavior where applicable, typed save fields and focus surviving a five-second state refresh, and no secret in Chrome storage or generic MCP forms.
2. Approve the current session, list permitted metadata, type the identifier normally, then fill by handle through MCP. Repeat 20 independent ready-fixture fills; record per-call time/p50/p95 and outcomes. Values are checked by a test oracle, not echoed into the conversation.
3. Try wrong scheme/host/port, unapproved origin/account, changed tab/document/nonce, hidden/readonly/new-password/ambiguous control and a password target inside a cross-origin iframe. Confirm no field write. Also verify an unrelated cross-origin widget does not prevent a verified same-origin target from being inspected.
4. Use two browser identities and sessions (including colliding tab IDs), revoke grants, switch profile and test duplicate/uncertain browser identity. Confirm no cross-scope metadata or fill.
5. After fill, attempt evaluate with a side-effect marker, screenshot after reveal-password, raw logs/network, mock injection and nested batch variants. Assert refusal happens before side effects. Read snapshot/text and inject literal/normalized sentinels into structured results/errors/console/network to verify the daemon output boundary.
6. Exercise hash/SPA changes, worker recycle, tab-ID reuse, full navigation/BFCache restoration, daemon restart, lock/delete while page retains a password. Confirm no premature clearing of protection and fail-closed recovery.
7. Cancel/expire a save request, close its UI, disconnect the initiating session and induce fill timeout. Confirm no human wait holds a tab mutex, no duplicate save/fill, and no secret-bearing retry.
8. With temporary stores, fault-inject write interruption, simultaneous changes, corrupt/oversized envelopes, missing/invalid key, wrong ownership/mode, symlink paths and unsupported versions. Backup/restore synthetic data explicitly and confirm no silent reset or lost committed change.

## Commands and evidence

Run targeted vault tests first, then `npm test`, `npm run typecheck`, `npm run build`, `npm run lint`. Use the configured coverage command if source-critical gaps remain; do not repeat passed suites without new changes/evidence. Review the actual diff.

Record each SC in `verification.md` with its real result and evidence source. Include localhost URL without secrets, actual browser MCP/profile identity, commands, counts and timing methodology. Keep unmet criteria visible. Close owned test tabs/browser processes, stop fixture/isolated daemon, and remove synthetic upload/state fixtures after evidence is collected.
