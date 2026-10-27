# Specification quality checklist: shared website memory

**Purpose**: Review the draft specification before formal planning.
**Created**: 2026-10-27
**Feature**: [spec.md](../spec.md)

Checkboxes describe specification quality, not implementation or formal acceptance.

## Content quality

- [x] The main specification describes outcomes and behavior without selecting a storage engine or integration mechanism.
- [x] User value, actors and primary journeys are described.
- [x] Mandatory template sections are present and the implementation outline is a separate draft.

## Requirement completeness

- [x] No unresolved `[NEEDS CLARIFICATION: ...]` markers are present; provisional assumptions are identified explicitly.
- [x] Every requirement is ready for implementation without further decisions: the safe observation allowlist, public-status verification, account-separation proof, shared-fact deletion and backup handling have reviewed contracts (fact-allowlist.json approved 2026-10-27, T007).
- [ ] All acceptance limits are final: performance, output-size, queue and timeout thresholds require a baseline and owner review in the plan.
- [x] Acceptance scenarios cover sharing, freshness, privacy, batch, injection, failure and recovery.
- [x] Scope excludes background news monitoring and cross-origin sharing; only verified public, non-personal facts may be shared across profiles.
- [x] Dependencies, assumptions, edge cases and unknown privacy state are documented.

## Feature readiness

- [x] Functional requirements have traceable acceptance scenarios.
- [x] The owner has reviewed and accepted the specification and its provisional defaults (accepted 2026-10-27, unamended).
- [ ] A formal implementation plan, contracts and testing limits have been reviewed.

## Notes

- The spec and implementation outline are drafts, not evidence that the feature or Mnemon integration exists.
- The root constitution is proposed, not adopted. Classification is `EVOLVE / CRITICAL` proposed for the feature because it handles potentially sensitive browser data.
- Preserve the existing project sources, Graphify data, codebase-memory index and pending `constitution.md` changes.
- Resolve unchecked items before claiming readiness for implementation. Formal planning follows the repository's spec review gate.
