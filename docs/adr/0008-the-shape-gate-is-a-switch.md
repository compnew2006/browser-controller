# ADR-0008: The shape's gate is a switch, not a baked-in decision

- **Status**: proposed
- **Date**: 2026-10-31
- **Related**: [specs/007-form-shape-facts/spec.md](../../specs/007-form-shape-facts/spec.md) OD-1, FR-001, FR-002, US3, [research.md](../../specs/007-form-shape-facts/research.md) D-01..D-10, [ADR-0006](0006-the-counter-outside-the-anonymity-gate.md), [tasks.md](../../specs/007-form-shape-facts/tasks.md) T018

## Context

OD-1 asks whether the form's shape fact passes 003's anonymity gate, and it was never answered by the owner. Two readings are defensible:

- **Option 1** — the shape is a fact like any other, so it stays behind the gate: only a page with no visible login state is measured. This is what the specification was written for.
- **Option 2** — the shape holds counts and closed-vocabulary words only and no content from the page, so it may be stored for every in-scope site, like the visit counter.

Choosing one branch and deleting the other would close the owner's gate with the implementer's hand. Baking Option 1 into the code without the other branch would make the decision a rewrite rather than a flip.

## Decision

1. The gate is an explicit option on the memory service: `MemoryServiceDeps.shapeGate`, of type `ShapeGate` (`'option1' | 'option2'`), with `DEFAULT_SHAPE_GATE = 'option1'` in `mcp-server/src/memory/allowlist.ts`.
2. **Option 1** (the default, and what ships): the shape fact stands behind the anonymity gate like every other fact. A page whose probe reports `anonymous: false` stores no shape.
3. **Option 2**: the shape fact alone passes the gate. Every other fact — the language, the search box, the login path, the control names — stays behind it, so a non-anonymous page stores the shape and nothing else.
4. Both branches are covered by tests with their own privacy assertion (`tests/memory-service.test.ts` and `tests/memory-shape-privacy.test.ts`), so whichever branch is in force, the claim "counts and reviewed words only" is proven for it, not for the other one.

## Consequences

- The owner's decision is one line in `mcp-server/src/memory/allowlist.ts` plus a rebuild; it is not a rewrite.
- Flipping to Option 2 widens what the memory holds on signed-in sites: the *number* of fields a sign-in form has, their types, and whether one is hidden. It still holds no label, no name, no value and no selector, and the tests for Option 2 assert exactly that.
- The default is Option 1, so nothing widens without the owner saying so. The README's statement that the memory stores facts "only from a page read while no login state is visible" is true of the default and must be amended if the owner flips it.
- The switch is a code constant, not a runtime setting: it is not reachable from `browser_memory_policy` or the owner CLI, so it cannot be flipped by an agent.
