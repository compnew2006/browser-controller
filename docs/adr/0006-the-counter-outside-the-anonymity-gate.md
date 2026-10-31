# ADR-0006: The hidden-control counter sits outside the anonymity gate

- **Status**: proposed
- **Date**: 2026-10-31
- **Related**: [specs/007-form-shape-facts/spec.md](../../specs/007-form-shape-facts/spec.md) C6, FR-003, FR-004, [research.md](../../specs/007-form-shape-facts/research.md) R-02, [ADR-0003](0003-website-memory-policy-control.md)

## Context

003 applies its anonymity gate where facts are collected: `mcp-server/src/memory/service.ts` enqueues a visit **before** the gate and returns unless `scope.anonymous === true` for anything else. The extension answers `anonymous: false` for a site that keeps anything in `localStorage` or `sessionStorage` (`extension/lib/site-context.js`).

That puts two kinds of stored data on opposite sides of one gate:

- a **fact** — something read from the page (a language, a name, a path). It can carry what the page holds, so it stays behind the gate.
- a **visit** — a number of the times this profile opened the site. It holds no page content, and 003 already stores it on the very sites the gate excludes.

The hidden-control counter of spec 007 is the second kind: a count of the actions this profile saw fail on a control it could not reach. It holds no part of the failed action — not the target, not the role, not the name.

The counter exists because of the measured site of E1/E2, whose local storage makes it `anonymous: false`. A gated counter could never rise there, and the feature's own evidence would be outside its reach.

## Decision

1. The **shape fact** (`ui.form.shape`) passes the anonymity gate, as any fact does. Whether it may pass under OD-1 Option 2 is the owner's decision, and the specification is written for Option 1; both branches exist behind one switch, so the decision is a flip rather than a rewrite ([ADR-0008](0008-the-shape-gate-is-a-switch.md)).
2. The **hidden-control counter** does not pass the anonymity gate. It follows the visit rule: it is stored for an in-scope origin whose probe reports `anonymous: false`.
3. The counter still passes everything else: the scope gate (the credential vault's protection, the exclusion list, the live-connection rules), the deletion tombstones, and the per-site bounds.
4. The counter lives in the **acting profile's own state**, never among the shared facts, because it counts that profile's activity. Another profile's failures never move it.

## Consequences

- The one part of spec 007 that reaches the sites where agents actually fail is the one part that holds no page content.
- A signed-in site's form structure stays behind the gate, so the agent does not learn how many fields a sign-in form has there.
- The counter is an activity count: it never falls, and it is capped at the reviewed maximum.
- A profile that never failed on a control has no counter, and the agent sees nothing.
- The separation is recorded in the spec's Clarifications (C6), in FR-003 and FR-004, and in the reviewed vocabulary, so it is visible to anyone auditing what is stored.
