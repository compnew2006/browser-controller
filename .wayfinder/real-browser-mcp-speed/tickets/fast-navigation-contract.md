---
title: Define an opt-in fast-navigation readiness contract
type: grilling
status: open
blocked_by:
  - phase-latency-attribution.md
---

## Question

If navigation settling is a demonstrated bottleneck, what opt-in readiness modes can reduce waiting without returning control before pages are usable?

## Bring to the decision

- Measurements for document navigation, SPA/hash changes, and same-origin iframe cases.
- Proposed readiness semantics and timeout behavior.
- Safety/correctness invariants and tests proving existing default behavior is unchanged.
- A clear fallback when the faster condition is not reached.

Do not design around a single fast page or weaken the default wait contract as part of this decision.
