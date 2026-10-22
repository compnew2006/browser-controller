---
title: Attribute representative workflow latency to phases
type: task
status: open
blocked_by:
  - benchmark-matched-suite.md
---

## Outcome

Identify which phases materially contribute to p50 and p95 before choosing an optimization.

## Work

Measure available boundaries across daemon/MCP round trips, extension dispatch, navigation readiness/settling, target lookup, input dispatch, batch observations/snapshots, and result serialization. Instrument only as much as necessary, and keep instrumentation overhead visible or bounded.

## Acceptance

For each benchmark workflow, report phase distributions and uncertainty sufficient to distinguish dominant costs from noise. If exact boundaries cannot be measured safely, document the remaining blind spots rather than infer them from total time.
