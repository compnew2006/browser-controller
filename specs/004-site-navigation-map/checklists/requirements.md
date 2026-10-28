# Specification Quality Checklist: site navigation map for browser agents

**Purpose**: Validate specification completeness and quality before proceeding to planning
**Created**: 2026-10-28
**Feature**: [spec.md](../spec.md)

## Content Quality

- [x] No implementation details (languages, frameworks, APIs)
- [x] Focused on user value and business needs
- [x] Written for non-technical stakeholders
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
- [x] Feature meets measurable outcomes defined in Success Criteria
- [x] No implementation details leak into specification

## Notes

- Validation pass 1 (2026-10-28) found two gaps, fixed in the spec: page titles of content pages could carry user content (AC-14 and FR-003 now exclude pages reached only through content-area controls and drop titles of paths with placeholders); FR-008 (navigation reminder) had no acceptance scenario (AC-26 added). FR-009 now cites AC-03. Pass 2: every FR cites at least one AC, and every AC-01–AC-26 is cited by an FR.
- Validation pass 3 (2026-10-28, review of "signed-in pages are included"): the spec never limited the map to signed-in pages; wording now says public and signed-in pages alike. Fixes from the review: only structural pages are recorded (AC-01, FR-002, AC-27); read context from 003's verdict, never called a login state, separates signed-out and signed-in views for not-seen marking (FR-001, FR-010, AC-18, AC-28); a direct open that lands elsewhere is recorded on the page entry (AC-19); the reminder merges with 003's shared facts for the tab's origin only (FR-008, AC-26); the enable prompt states that page addresses are recorded (FR-006, AC-17); sensitive public paths are a stated residual risk (Assumptions); SC-008 added. All AC-01–AC-28 are cited by an FR; no clarification markers.
- Validation pass 4 (2026-10-28, site changes): the map updates from agents' browsing, never from direct agent writes (FR-002). Gaps fixed: a moved page is recorded at its landing address and lookups order by last seen (AC-19, AC-30, FR-007); a not-found answer is recorded without deleting the entry (AC-29, FR-010); a destination seen in another read context, such as a sign-in page reached while signed out, no longer replaces the real one (AC-20, FR-010); output tells the agent that a complete read updates the map when a hint does not match (FR-009). SC-009 added. All AC-01–AC-30 are cited by an FR.
- Validation pass 5 (2026-10-28, owner additions 1–6): ready locator with expected destination and no separate verifying read (AC-09, FR-009, SC-003); use feedback ranks failed hints lower without marking them not seen (AC-31, FR-010); data-changing controls are marked, kept out of reminders and returned with a confirm notice (AC-32, FR-015, SC-011); ranking by working status, use count and recency, plus a 10-page outline (AC-33, FR-007, SC-006); single page-entry deletion and path-prefix exclusion (AC-16, AC-34, FR-006); local aggregate counters without addresses or names (AC-35, FR-016, SC-010). AC-30 now states that the old address lands elsewhere, so ranking by use count cannot list the old page first. All AC-01–AC-35 are cited by an FR; no clarification markers.
- Domain terms such as origin, path, tab, profile and page area are part of the product's vocabulary, not implementation choices.
- Defaults taken from the request instead of clarification markers are listed under Clarifications; the owner may change any of them at spec review.
- Owner decisions required before planning: approve the deliberate difference from 003 FR-005 (the browser profile is the account boundary for map entries, FR-005), the residual risk that personal names in navigation controls may be stored locally, and the residual risk that structural public page addresses may reveal sensitive topics (Assumptions).
- Provisional limits (FR-004, FR-011, SC-005, SC-006) are confirmed in the plan after measurement, as in 003.
- The spec is a draft. The root constitution is proposed, not adopted.
