# Specification Quality Checklist: form shape facts

**Purpose**: Validate specification completeness and quality before and after implementation
**Created**: 2026-10-31
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

- The clarification round of 2026-10-31 (`speckit.clarify 007`) resolved five ambiguities, and they are binding on the requirements: **C1** the agent reads the shape (no tool changes), **C2** the hidden-control counter is per browser profile, **C3** only the form inside `main` is measured, **C4** the commit mode is observed and never inferred, **C5** no staleness marker is added. They are listed in the spec's Clarifications section and in the plan's decisions per requirement.
- A source check the same day found three more places where the spec could not work as written, and they are binding too: **C6** the hidden-control counter is not behind the anonymity gate (the gate would have made it dead on the very site of E1 and E2), **C7** a failed action is attributed through the last observed read of its tab (a failed call carries no `siteContext`), **C8** the commit mode is a positive observation or nothing, so `none` is not a value. Each one is stated with its source evidence in the spec's Clarifications section.
- Two owner decisions are open and are stated as such: **OD-1** (whether the anonymity gate also covers the **shape fact**; the spec is written for Option 1, and the counter is outside the gate either way — C6) and **OD-2** (the shape needs an updated extension in the profile; the feature is specified to work partially without it, FR-003 and FR-009). Neither is a [NEEDS CLARIFICATION] marker in the requirements: the requirements are complete and testable under the stated default, and Option 2 changes FR-004 and SC-003 only.
- Not written for non-technical readers: like 003 and 005, the spec uses the product's vocabulary (origin, path, profile, error codes such as `ELEMENT_HIDDEN`, the lookup tool). These are product terms, not implementation choices.
- The proposed vocabulary ([contracts/interaction-vocabulary.json](../contracts/interaction-vocabulary.json)) is a draft for the owner. It becomes part of the reviewed allowlist only after approval, as version 3 of `specs/003-website-agent-memory/contracts/fact-allowlist.json`.
- Every FR cites a user story. FR-003 and FR-004 apply to all of them.
- The root `constitution.md` is proposed, not adopted (`AGENTS.md` says so). Its Article 6 asks for `specs/features/<feature>.md`, `specs/contracts/<feature>.<ext>` and `specs/evidence/<feature>/manifest.json`; the repository's practice for 001–006 is the numbered-spec layout used here, with the contract mirrored into the spec it extends. The drift test and the mirrored contract are the parts of Article 6 that carry over.
- SC-001 to SC-009 are met by tests: `tests/memory-tab-state.test.ts` (the new file), plus additions in `tests/memory-service.test.ts`, `tests/memory-allowlist.test.ts`, `tests/memory-privacy.test.ts`, `tests/memory-output.test.ts`, `tests/memory-boundaries.test.ts`, `tests/memory-queue.test.ts`, `tests/memory-store.test.ts`, `tests/memory-admin.test.ts` and `tests/memory-policy.test.ts`. SC-007 is the unchanged 003 suite.
- "Feature meets measurable outcomes" stays unchecked until a real-Chrome check runs: the evidence was measured live on 2026-10-31 (E1, E2), and the success criteria are to be measured the same way.
