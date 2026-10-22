---
title: Set the evidence gate for any future default change
type: grilling
status: open
blocked_by:
  - benchmark-matched-suite.md
  - phase-latency-attribution.md
---

## Question

What repeatability, p50/p95 improvement, success-rate, and safety-regression evidence would justify considering a fast behavior as the default rather than keeping it opt-in?

## Bring to the decision

- Multiple matched benchmark runs across the agreed workflows, not only the checkbox case.
- Confidence/spread and any workload regressions, including tail latency.
- Regression and security tests for behavior affected by the candidate.
- A rollback path and compatibility impact.

Until this is answered and the gate is met, preserve existing defaults.
