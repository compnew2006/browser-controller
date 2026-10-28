# Implementation Plan: one vault approval per site, on the page that needs it

**Spec**: [spec.md](spec.md) · **Created**: 2026-10-28 · **Owner instruction**: no review pauses; no commit.

## Technical context

- Daemon: TypeScript under `mcp-server/src/vault/` (grants, requests, fill workflow, private UI operations, bridge transport). Tests: Vitest with fake transports and isolated `mkdtemp` vaults.
- Extension: Chrome MV3 modules under `extension/lib/`, the private page under `extension/vault/`, CDP input through `extension/lib/cdp-session.js`.
- Compatibility: a new additive capability, `vault-site-approval`, sent by both sides. Without it on the extension's side, the daemon keeps the old surfaces: the private page only and password-only fills. Site approvals work with any extension, because they live in the daemon.

## Decisions

| # | Decision | Why |
|---|---|---|
| D1 | Site approvals are a second kind of grant in `GrantRegistry` (`kind: 'site'`): scope, origin, `via` (`card`, `page`, `allowlist`), created time. They are in memory only. Session and connection revocations skip them; scope revocation (lock, restore) and `clear` remove them. | FR-001, FR-002. Memory-only means a daemon restart, which also locks the vault, ends them. |
| D2 | `GrantRegistry.find` returns a session grant first and then the site grant. `FillWorkflow.grantStillUsable` re-checks a site grant by scope and origin, and still checks that the live browser identity and connection did not change during the fill. | FR-002, FR-013. |
| D3 | Every new approval (card, private page `approve` for list or fill, Save with "allow") creates a site approval. The private page's fill approval still runs the fill it was asked for and records the outcome on the request, so a waiting call returns it instead of filling twice. | FR-001, FR-007. |
| D4 | `RequestJournal.begin` takes a `surface`: `card` asks the extension for the `prompt` vault action, falling back to `openUi` (the private page) when the card is refused or unsupported. Requests remember their surface; closing the private page cancels only `page` requests. A second request for the same scope and origin joins the showing card instead of drawing another. | FR-003, FR-007. |
| D5 | The journal notifies waiters on every terminal state. A public `list` or `fill` that drew a card waits up to 40 s (or until the call is aborted), then retries once with the new approval. | FR-008. |
| D6 | The card's decision reaches the daemon as the private UI operation `cardDecision` (`allow`, `deny`, `page`, `cancel`, plus `always`). The background accepts it only from the card's own content-script sender: same extension, the card's tab, frame 0, the card's document and its one-time token. | FR-004, FR-006, FR-007. |
| D7 | The allowlist is an optional `allowlist` array in the encrypted vault data, written only when it is not empty. Private UI operations `allowlistAdd` and `allowlistRemove`; `getState` returns it. No agent tool reaches it. Removing an origin revokes approvals given `via: 'allowlist'` for it. Audit rows reuse the `grant` and `revoke` actions, so the audit schema does not change. | FR-009, FR-010; keeps old daemons able to read a vault with no allowlist. |
| D8 | The card is a classic content script, `extension/vault/vault-card.js`, injected into frame 0 of the requesting tab in the isolated world. It draws in a closed shadow root on a host under `<html>`. A decision needs `isTrusted`, 600 ms of continuous visibility (IntersectionObserver v2 `isVisible`), the page in front with focus, and for pointer input the host at the click point. Removal of the host is reported as `page`. | FR-004, FR-006. |
| D9 | `cdp-session.js` refuses every `Input.*` CDP command to a tab while its card is open, with `VAULT_APPROVAL_PENDING`. The lock shield lets events aimed at the card through. The card state ends on decision, `promptClose`, navigation of frame 0, tab close, or the request's expiry time. | FR-005. |
| D10 | Inspection takes an optional `withIdentifier` flag. The isolated-world inspector then also looks for one username field in the password field's form, before it (autocomplete `username`/`email`, `type=email`, or a login-like name, id, label or placeholder in English or Arabic). With no password field, exactly one such field in a form makes an identifier-only target. The fill writes the identifier through the same nonce and element identity, and the password as before; identifier-only fills register no secret and do not protect the page. | FR-012, FR-013. |

## Files

- Daemon: `vault/grants.ts`, `vault/fill.ts`, `vault/requests.ts`, `vault/service-common.ts`, `vault/service-core.ts`, `vault/service.ts`, `vault/service-private.ts`, `vault/service-protection.ts`, `vault/bridge-transport.ts`, `vault/store.ts`, `vault/types.ts`, `protocol.ts`, the `browser_vault` tool description.
- Extension: `lib/protocol.js`, `lib/vault-actions.js`, new `lib/vault-card.js` (card state, injection, sender check), `lib/cdp-session.js`, `lib/overlay.js`, `events.js`, new `vault/vault-card.js` (the card UI), `vault/vault-page.js` and `vault/vault.html` (allowlist and site approvals).
- Docs: `agent-config/AGENTS.md`, `agent-config/cursor/rules/browser-controller.mdc`, `CHANGELOG.md`.

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| An agent approves its own request through trusted CDP input. | D9 blocks every `Input.*` command to the tab while the card is open; the card also needs focus and continuous visibility. Tests drive the gate directly. |
| A hostile page disguises or hides the card (clickjacking). | D8 visibility, arming delay and hit test; the private page stays available. |
| A page script fakes a decision message. | Page scripts cannot call the extension's runtime; the background checks the sender, document and token (D6). |
| Approvals outlive what the owner expects. | They end on lock, restore, revoke and daemon restart; the private page lists them with their source. |
| Mixed versions (new daemon, old extension, or the reverse). | The capability gate keeps old surfaces; extension-side inputs are optional keys accepted only by the new extension. |
| Old daemons reading a vault with an allowlist. | Written only when non-empty; noted in the changelog. |

## Test plan

- `tests/vault-grants.test.ts`: site approvals survive session and connection revocation and end on scope revocation.
- `tests/vault-service.test.ts`: card flow (allow, deny, join, timeout, fallback), private-page approvals create site approvals, allowlist auto-approval and removal, reconnect survival, list and fill across sessions.
- `tests/vault-fill.test.ts`: site-grant re-checks; identifier plus password; identifier only.
- `tests/vault-store.test.ts`: allowlist round trip and the empty-list file shape.
- `tests/extension-vault.test.ts`: identifier classifier and fill functions; prompt action state; CDP input gate; card sender checks.
- Full `npm run lint`, `npm run typecheck`, `npm test`, `npm run build`, `npm run context:lint`.
