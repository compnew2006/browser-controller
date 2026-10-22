---
title: Define and run a matched representative benchmark suite
type: task
status: open
blocked_by: []
---

## Outcome

Produce a reproducible comparison of `real-browser-mcp` and Browser Harness on the agreed workload, with the checkbox case retained as a historical row. Cypress may be reported as a separate E2E-runner reference, not blended into the MCP comparison.

## Work

- Match browser version, machine, page state, task steps, and success postconditions as closely as each tool permits; document any unavoidable differences.
- Use an isolated browser profile and disposable/local test data where practical.
- Randomize or alternate run order to reduce warm-cache/order bias, and collect enough repetitions to report p50/p95 and spread.
- Report success rate, end-to-end duration, tool/round-trip count, and response payload size alongside latency.
- Keep Playwright MCP measurements separate if included; do not blend unlike execution paths into the Harness comparison.
- Keep Cypress E2E-runner measurements separate from MCP timing; record browser/profile, cold-start handling, and the runner's timing boundary.

## Acceptance

The benchmark instructions, raw per-run data, environment, versions, and summarized results are reproducible and clearly distinguish measured facts from estimates.
