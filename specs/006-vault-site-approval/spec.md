# Feature Specification: one vault approval per site, on the page that needs it

**Feature Branch**: Not created; specification is in the current checkout.

**Created**: 2026-10-28

**Status**: Draft; the owner waived the review pauses (see Clarifications).

**Input**: User description (summarized from the session, 2026-10-28): authorization should appear once per site; the authorization prompt should appear as a message on the same page that needs it; and there should be an allowlist system that grants authorization automatically for listed sites. Observed problem: "Vault fills asked for authorization for the username, stopped, then asked again for the password and stopped, and the fields were not filled correctly."

**Builds on**: [001 credential vault](../001-credential-vault/spec.md). This feature changes 001's FR-004 (where consent is given), FR-005 (what a grant is bound to and when it ends) and the fill's field scope. Every other 001 requirement is kept: origin checks before and after reading the secret, document and field identity, no Submit click, output redaction, profile-wide protection, recovery, audit without secrets, and passwords entered only in the private page.

## Evidence that motivated this feature (2026-10-28, `https://arkan-aser.odoo.com`)

- **V1**: Listing accounts and filling a password needed two separate approvals. A `list` approval does not cover `fill`.
- **V2**: A fill writes the password field only. The agent therefore listed the accounts to learn the username, typed it itself, and then asked for the fill.
- **V3**: Every approval is bound to one agent session and to one extension connection. The extension reconnected often during the run, and each reconnect removed every approval, so the owner was asked again.
- **V4**: Every approval opened the separate private vault page and moved the owner away from the page being signed in to.

## Clarifications

### Owner decisions, 2026-10-28

- Q: Where does the approval appear? → A: On the page itself: a card owned by the extension, drawn over the page that needs it. While the card shows, the extension refuses every agent click, typing and key input on that tab, so an agent cannot approve its own request. The site cannot read the card. A visibility check stops the site from hiding or disguising it.
- Q: How long does one approval for a site last? → A: Until the vault locks. One approval covers listing and filling every saved account of that exact site in that browser profile. It survives new agent sessions and extension reconnects, and it ends when the vault locks, when the owner revokes it, or when the vault is restored from a backup.
- Q: What does an allowlisted site get? → A: Listing and filling without any prompt while the vault is unlocked. Every fill is still written to the audit log. Only the owner edits the list, in the private vault page or by the card's own "allow automatically" choice; agent tools can neither read nor change it.
- Q: Should work pause for spec and plan review? → A: No. The owner said: "متوقفش تاني من دلوقتي الا لما تخلص … ولا تسأل ولا اي حاجة" (do not stop until finished; do not ask).

### Defaults chosen without asking

- A fill writes the saved login identifier into the form's username field as well as the password, when the page has exactly one such field next to the password field. On a first step that asks only for the identifier, a fill writes the identifier alone.
- When the vault is locked, the card asks to unlock the vault and allow the site in one decision. A locked vault stays locked for allowlisted sites until the owner unlocks it, because locking is the owner's way to stop all use.
- The agent's `list` or `fill` call waits up to 40 seconds for the owner's decision on the card, so one call usually completes the task. A later call after a timeout continues with the same request.
- If the card cannot be shown or verified (a browser page, a full-screen element, a tab the extension cannot script), the request falls back to the private vault page, as before.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Approve a site once (Priority: P1)

The owner approves `arkan-aser.odoo.com` once. During the rest of the day, any agent session in that browser profile can list its accounts and fill them, even after the extension reconnects, without another prompt.

**Why this priority**: It removes the repeated prompts in V1 and V3.

**Independent Test**: In an isolated vault, approve a site from session A. Session B lists and fills the same site's account with no new request, before and after a simulated extension reconnect. After a lock, the next list asks again.

**Acceptance Scenarios**:

1. **Given** a site approval, **When** any session in the same profile lists or fills that site's accounts, **Then** no new request is made.
2. **Given** a site approval, **When** the extension reconnects with the same unique browser identity, **Then** the approval still applies.
3. **Given** a site approval, **When** the vault locks, the owner revokes the approval, or a backup is restored, **Then** the next list or fill asks again.
4. **Given** a site approval for one origin, **When** a session asks for another origin or another browser profile, **Then** a new approval is required.

---

### User Story 2 - Approve on the page (Priority: P1)

When an approval is needed, a card appears on top of the tab that needs it. It names the site, the browser profile and the requesting agent. The owner chooses Allow or Deny. The agent's call continues as soon as the owner decides.

**Why this priority**: It removes the tab switch in V4.

**Independent Test**: With a mocked extension, a list call on a page without approval shows the card on that tab. A trusted Allow on the card completes the waiting call with the account list.

**Acceptance Scenarios**:

1. **Given** no approval for the site, **When** an agent lists or fills, **Then** the card appears on the requesting tab and the tab is brought to the front.
2. **Given** the card is showing, **When** the agent sends a click, typing, a key or any other input to that tab, **Then** the input is refused with a code that says the owner's decision is pending, and the card is not activated.
3. **Given** the card is showing, **When** a script on the page clicks the card, hides it, covers it or removes it, **Then** no approval is given; a removed card cancels the card and offers the private vault page.
4. **Given** the owner denies, **When** the agent's call returns, **Then** it reports the denial and no grant exists.
5. **Given** the card cannot be shown, **When** an approval is needed, **Then** the private vault page opens as before.
6. **Given** two sessions ask for the same site at once, **When** the owner decides once, **Then** both requests get that decision.

---

### User Story 3 - Sites that are always allowed (Priority: P2)

The owner keeps a list of sites in the private vault page, or ticks "Allow this site automatically" on the card. Agents list and fill accounts on those sites without any prompt while the vault is unlocked.

**Why this priority**: The owner asked for it explicitly; US1 already removes most prompts.

**Independent Test**: Add an origin to the list in an isolated vault. A list and a fill on that origin succeed with no request, and the audit log records a grant for the automatic approval.

**Acceptance Scenarios**:

1. **Given** an allowlisted site and an unlocked vault, **When** an agent lists or fills, **Then** it succeeds without a request and the audit log records the automatic approval.
2. **Given** an allowlisted site and a locked vault, **When** an agent lists, **Then** the card asks to unlock.
3. **Given** the agent tools, **When** an agent tries to read or change the list, **Then** no tool does either.
4. **Given** the owner removes a site from the list, **When** an agent lists, **Then** the automatic approval for that site ends.

---

### User Story 4 - Fill username and password in one step (Priority: P1)

A fill writes the saved username and the password in one call. On a sign-in flow that asks for the username first, the same approval fills the username step and later the password step.

**Why this priority**: It removes V2 and the incorrect fields.

**Independent Test**: On a test form with username and password fields, one fill writes both and reports 2 fields. On a username-only first step, a fill writes the username and reports 1 field.

**Acceptance Scenarios**:

1. **Given** a form with exactly one username field before the password field, **When** the agent fills, **Then** both fields hold the saved values and the result reports 2 fields without either value.
2. **Given** a page with only a username field, **When** the agent fills, **Then** only the username is written and the page is not marked as holding a password.
3. **Given** several possible username fields, **When** the agent fills, **Then** only the password is written.

### Edge Cases

- The owner approves while the requesting session has disconnected: the approval is still recorded for the site; the session's own request ends as cancelled.
- The page navigates or the tab closes while the card shows: the card and the input block end and the request is cancelled.
- The page's own modal dialog or full-screen element covers the card: the card does not accept a decision until it is fully visible; the private vault page stays available.
- The private vault page is closed while a card is showing: only requests shown in the private page are cancelled.
- A copied browser profile connects with the same identity: the identity is ambiguous, and vault use is refused, as in 001.
- An allowlisted site injects instructions into page text: the fill still checks the exact origin, the document and the field, and it never clicks Submit. The allowlist is the owner's statement of trust in that site; the documentation warns about it.
- The vault holds several accounts for one site: the approval covers all of them; the agent chooses an account by its handle.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: A site approval MUST cover listing and filling every saved account of one exact origin in one verified browser profile. It MUST NOT be bound to an agent session or to one extension connection. [US1]
- **FR-002**: A site approval MUST end when the vault locks, when the owner revokes it, when a backup is restored, or when the daemon restarts. A fill MUST still verify that the browser identity is unique and that the connection did not change during that fill. [US1]
- **FR-003**: When no session grant, site approval or allowlist entry applies, the system MUST ask through an in-page card on the requesting tab. The tab MUST be brought to the front. Only when the card cannot be shown MUST the system fall back to the private vault page. [US2]
- **FR-004**: The card MUST be drawn by the extension in a surface that page scripts cannot read. It MUST show the site's origin, the browser profile label, the requesting agent, the purpose and whether the vault will be unlocked. It MUST never show a password. [US2]
- **FR-005**: While a card is showing on a tab, the extension MUST refuse every input that an agent tool would send to that tab, with a specific code. The block MUST end when the card ends. [US2]
- **FR-006**: The card MUST accept a decision only from trusted user input. It MUST NOT accept one until it has been fully visible for at least 600 ms. It MUST NOT accept one while it is covered, transparent, transformed or not in the front tab. A card removed by the page MUST end as cancelled. [US2]
- **FR-007**: One decision MUST settle every pending approval request for the same profile and origin. Allow MUST create one site approval and unlock the vault if needed. Deny MUST end the requests as declined. [US2]
- **FR-008**: An agent's list or fill call that started a card MUST wait up to 40 seconds for the decision and then continue. On a timeout, it MUST return the request as waiting for the owner, as today. [US2]
- **FR-009**: The owner MUST be able to add and remove allowlisted origins in the private vault page, and to add the current site from the card. Agent tools MUST NOT read or change the list. The list MUST be stored inside the encrypted vault. [US3]
- **FR-010**: On an allowlisted origin with an unlocked vault, list and fill MUST proceed without a request and MUST write a grant audit event for the automatic approval. [US3]
- **FR-011**: The private vault page MUST list site approvals with the way each was given and let the owner revoke each one. Revoking MUST stop fills that have not started. [US1, US3]
- **FR-012**: A fill MUST write the saved identifier into the one username field of the same form before the password field, when that field is unambiguous. With no password field and exactly one unambiguous username field, it MUST write the identifier alone and MUST NOT mark the page as holding a password. The result MUST report the number of fields written and never a value. [US4]
- **FR-013**: All 001 protections MUST continue to hold: exact origin, document and field identity, one-time inspections, no Submit click, redaction, profile-wide blocking of unsafe tools while a password may be on a page, and recovery after uncertain outcomes. [all]

### Key Entities *(include if feature involves data)*

- **Site approval**: browser profile scope, exact origin, how it was given (card, private page or allowlist), time; kept in memory only.
- **Allowlist entry**: exact origin and the time it was added; stored in the encrypted vault data.
- **Approval card**: one per tab, bound to a request, the tab's document and a one-time token; it ends on a decision, a timeout, navigation, tab close or removal.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: In an isolated test, one approval followed by 5 sign-ins across 2 new sessions and 1 reconnect needs 0 further approvals while the vault stays unlocked.
- **SC-002**: When the card can be shown, an approval needs no tab switch, and the agent's waiting call completes in the same call in 100% of test runs where the owner decides within 40 seconds.
- **SC-003**: 100% of agent input attempts to a tab with a showing card are refused in tests, and 0 untrusted or early clicks approve a request.
- **SC-004**: On an allowlisted origin, 0 prompts are shown and 100% of fills are audited.
- **SC-005**: One fill call writes both fields on 100% of test forms with one username field and one password field.
- **SC-006**: All existing 001 tests still pass, except those that assert the replaced behaviors (one approval per session and purpose, a password-only fill), which are updated to the new rules.

## Assumptions

- The device, the operating-system account, the extension and the local daemon are trusted, as in 001. A second copy of the browser profile connecting at the same time makes the identity ambiguous, and vault use is refused.
- The card is part of the extension. It follows the existing vault page's visual language and supports Arabic and English with the page direction.
- Unlocking the vault does not need a secret in this version (001); the card's Allow is the owner's consent to unlock.
- Old daemons cannot read a vault that holds an allowlist. The allowlist is written only when it is not empty, so a vault without one stays readable by earlier versions.
