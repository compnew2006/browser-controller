# Tasks: one vault approval per site, on the page that needs it

**Input**: [spec.md](spec.md), [plan.md](plan.md)

## Daemon

- [x] T001 D1/D2: site approvals in `vault/grants.ts` (`createSite`, `findSite`, `getSite`, `activeSitesFor`, `revokeSiteVia`); `find` falls back to the site approval; scope revocation and `clear` end it, session and connection revocation keep it. Tests in `tests/vault-grants.test.ts`.
- [x] T002 D2: `grantStillUsable` in `vault/fill.ts` re-checks a site approval by scope and origin. Tests in `tests/vault-fill.test.ts`.
- [x] T003 D7: the optional `allowlist` in `vault/types.ts` and `vault/store.ts` (`allowlist`, `allowlistAdd`, `allowlistRemove`), written only when not empty. Tests in `tests/vault-store.test.ts`.
- [x] T004 D4/D5: `RequestJournal.begin` with the card surface, joining a showing card, fallback to the private page, `moveToPage`, `waitForEnd`; `closeCard` on every terminal state (`vault/requests.ts`).
- [x] T005 D3/D5: `grantOrAsk` in `vault/service.ts`: existing approval, then the allowlist, then a card awaited for 40 s.
- [x] T006 D6/D7: private UI operations `cardDecision`, `allowlistAdd`, `allowlistRemove`; site approvals and the allowlist in `getState`; every private-page approval creates a site approval (`vault/service-private.ts`).
- [x] T007 D9/D10: the `vault-site-approval` capability (`protocol.ts`), the `prompt` and `promptClose` actions and `withIdentifier` inspections (`vault/bridge-transport.ts`, `vault/service-core.ts`).
- [x] T008 FR-012: identifier fills in `vault/fill.ts`: username with the password, or the username alone on a first sign-in step, with field counts in the result.
- [x] T009 Service tests for the card flow, private-page site approvals, the allowlist, reconnects and list or fill across sessions (`tests/vault-service.test.ts`, `tests/bridge-vault.test.ts`).

## Extension

- [x] T010 D8: the card UI, `extension/vault/vault-card.js` (closed shadow root, top layer, 600 ms arming, visibility and hit checks, Arabic and English).
- [x] T011 D6/D9: card state, the CDP input gate and the sender check in `extension/lib/vault-card.js`; the gate in `extension/lib/cdp-session.js`; the lock shield lets events aimed at the card through (`extension/lib/overlay.js`).
- [x] T012 D4: `prompt` and `promptClose` actions in `extension/lib/vault-prompt.js`; `prompt` runs under the tab's lock (`extension/dispatch/router.js`).
- [x] T013 D6/D9: decisions relayed from the card, cancel on navigation and tab close (`extension/events.js`); every card ends with the daemon connection (`extension/lib/connection.js`).
- [x] T014 D10: identifier inspection and fill in `extension/lib/vault-page-scripts.js` and `extension/lib/vault-actions.js`.
- [x] T015 FR-009/FR-011: Site access section in the private vault page (`extension/vault/vault.html`, `vault-page.js`, `vault.css`) and the new approval wording.
- [x] T016 Extension tests: identifier classifier and fills, prompt validation and state, card sender checks (`tests/extension-vault.test.ts`); CDP input gate (`tests/v3-cdp-session.test.ts`).
- [x] T017 Keep every production module under 600 lines: `vault-actions.js` split into `vault-exec.js`, `vault-page-scripts.js` and `vault-prompt.js`; owner-only file helpers moved from `vault/store.ts` to `vault/store-files.ts`.

## Documentation and checks

- [x] T018 `browser_vault` tool description, `agent-config/AGENTS.md`, `agent-config/cursor/rules/browser-controller.mdc` and `CHANGELOG.md`.
- [x] T019 Run `npm run lint`, `npm run typecheck`, `npm test`, `npm run build`, `npm run test:coverage` and `npm run context:lint`; record the results in the report.
- [ ] T020 Real-Chrome check of the card, the input gate and a two-field fill. Needs a daemon restart and an extension reload by the owner. The same flow passed in `scripts/smoke-vault-isolated.mjs` on Chrome for Testing 151 with a disposable profile; the owner's own Chrome profile is still unchecked.
- [x] T021 Independent review fixes: card arming measured on the whole card and reset when it is covered, restyled, resized or moved; a moved card falls back to the vault page; "Always" takes the same input checks as Allow; agent locators skip the card; stale cards closed on a new daemon connection; joined requests move to the vault page when the card's own request ends; an "Always" approval comes from the list and grants nothing when the list is full; one page inspection per call; several username-like fields fill the password alone; no password write after the page swapped its field. `scripts/smoke-vault-card.mjs` covers the card guards.
- [x] T022 Edge case "the owner approves while the requesting session has disconnected": the session's request ends as cancelled, and its card stays held for the site decision until a decision, its expiry, a new request for the site (which gets its own card and takes over the waiting requests), or the end of its connection or vault scope (`RequestJournal.cancelSession`, `takeHeld`, `replaceHeld`, `heldCardDecision`). This also covers a session that ends while the card is drawn or while the owner's Allow runs. Allow approves the site and settles the requests that joined the card; no page check runs through the ended session. Decisions on a card whose request already ended are refused with `VAULT_REQUEST_EXPIRED`. Cards are taken down through the connection that drew them (`VaultBridgeTransport.closeCard`). Tests in `tests/vault-service.test.ts` and `tests/bridge-vault.test.ts`.
- [x] T023 Second review fixes: revoking a site approval also removes the site from the always-allowed list, and removing a site from the list ends every approval of it in that profile (`GrantRegistry.revokeSite`); an "Always" decision writes one `grant` audit row. Tests in `tests/vault-service.test.ts` and `tests/vault-grants.test.ts`.
