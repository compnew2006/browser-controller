---
title: Choose the first optimization from measured bottlenecks
type: grilling
status: open
blocked_by:
  - phase-latency-attribution.md
---

## Question

Which measured bottleneck should be addressed first to improve p50/p95 across the agreed suite, and which candidate optimizations should be rejected because their gains are uncertain or their safety/correctness cost is too high?

## Bring to the decision

- Phase-level measurements and benchmark results.
- Estimated gain and affected workflows for each candidate.
- Safety, correctness, and compatibility risks, with a concrete mitigation/test for each accepted candidate.
- Whether the candidate can remain opt-in and preserve current defaults.

## Do not assume

Do not select navigation waits, snapshots, batching, or classifier work as the bottleneck without measurements.
