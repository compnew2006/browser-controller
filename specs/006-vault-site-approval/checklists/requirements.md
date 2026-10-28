# Specification Quality Checklist: one vault approval per site, on the page that needs it

**Purpose**: Validate specification completeness and quality before and after implementation
**Created**: 2026-10-28
**Feature**: [spec.md](../spec.md)

## Content Quality

- [x] No implementation details (languages, frameworks, APIs)
- [x] Focused on user value and business needs
- [ ] Written for non-technical stakeholders
- [x] All mandatory sections completed

## Requirement Completeness

- [x] No [NEEDS CLARIFICATION] markers remain
- [x] Requirements are testable and unambiguous
- [x] Success criteria are measurable
- [x] Success criteria are technology-agnostic (no implementation details)
- [x] All acceptance scenarios are defined
- [x] Edge cases are identified
- [x] Scope is clearly bounded
- [x] Dependencies and assumptions identified

## Feature Readiness

- [x] All functional requirements have clear acceptance criteria
- [x] User scenarios cover primary flows
- [ ] Feature meets measurable outcomes defined in Success Criteria
- [x] No implementation details leak into specification

## Notes

- Not written for non-technical readers: like 001, the spec uses the product's vocabulary (origin, browser profile, tab, grant, error codes). These are product terms, not implementation choices.
- Review pauses were waived by the owner on 2026-10-28 (spec, Clarifications). Defaults chosen without asking are listed there.
- FR-010 was narrowed during implementation: the automatic approval is audited as a `grant` event, because the audit schema has no separate action for it and an older daemon must still read the audit rows.
- Every FR cites a user story. FR-013 applies to all of them.
- SC-001, SC-003, SC-004, SC-005 and SC-006 are met by tests with mocked transports and isolated vaults: `tests/vault-service.test.ts`, `tests/vault-grants.test.ts`, `tests/vault-fill.test.ts`, `tests/vault-store.test.ts`, `tests/bridge-vault.test.ts`, `tests/extension-vault.test.ts` and `tests/v3-cdp-session.test.ts`.
- SC-002 and the card's own guards (FR-006: trusted input, arming, visibility, hit test) run only in a real browser. `scripts/smoke-vault-isolated.mjs` passed on Chrome for Testing 151 with a disposable profile: the agent's click on the tab was refused with `VAULT_APPROVAL_PENDING`, the owner's keyboard Allow on the card was accepted, and the waiting `list` call completed. `scripts/smoke-vault-card.mjs` covers the card's guards in the same browser with real mouse input: an early click, a restyled, partly covered, moved or resized card, and "Always". The owner's own Chrome profile is still unchecked (T020), so "Feature meets measurable outcomes" stays unchecked until that check.
- Known limit: while the debugger is attached, Chrome's focus emulation makes `document.hasFocus()` true, so the card's focus check does not catch a first click into an unfocused window. The arming time, the whole-card visibility check and the hit test still apply. Checking window focus in the background would not help: the click that focuses the window is the click on the card.
- Known limit: the agent name on the card is the name its MCP client reports. The README calls it a label, not proof of who asks.
- A decision that reaches the daemon after the card's own request ended (the daemon's close message was still on its way) is refused with `VAULT_REQUEST_EXPIRED`: the card says the choice could not be saved and offers the vault page. Since T022, the end of the asking session keeps the card up and its Allow approves the site.
- Known limit: if the vault locks between an "Always" decision's list entry and its audit row, the decision fails but the site stays on the always-allowed list, because a locked vault cannot remove it. The owner chose "Always" on that card. The list entry also writes a `grant` audit row that looks like the approval's own row (FR-010 note above).
