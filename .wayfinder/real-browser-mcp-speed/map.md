# Wayfinder map: real-browser-mcp speed

## Destination

Reduce end-to-end p50/p95 latency for representative `real-browser-mcp` browser workflows, measured against a fair, matched `browser-use/browser-harness` comparison, without weakening safety or correctness.

## Agreed constraints

- Cover navigation, interactions, forms, SPA routes, and same-origin iframes; retain the checkbox workflow as a historical comparison.
- Preserve current defaults. Explore an opt-in fast mode first; do not change defaults without strong, repeatable evidence.
- Charting only: this map and its tickets do not authorize implementation, external issue creation, pushing, or changing defaults.

## Decisions so far

- **Closed — success criterion:** Optimize p50/p95 under a fair Harness comparison while preserving safety and correctness. See `tickets/decision-success-criterion.md`.
- **Closed — workload and rollout:** Use the representative suite plus the historical checkbox case, and keep any fast behavior opt-in initially. See `tickets/decision-workload-and-rollout.md`.

## Current evidence

- The previous checkbox-only comparison reported a 1.125 s median for this project versus 0.199 s for Browser Harness 0.1.13 (about 5.65×). It used only five successful trials and was not a matched, representative suite; treat it as a historical signal, not a general performance claim.
- A fresh 30-run checkbox sample on `the-internet.herokuapp.com` measured Browser Controller 3.0.5 at p50 847 ms / p95 1,149 ms, and Cypress 16.2.0 at p50 281 ms / p95 942 ms (nearest rank). Cypress's warm samples after its first cold 11.5 s sample had p50 280 ms / p95 542 ms. All 30 runs passed for each runner; see `cypress/README.md` and the raw CSV.
- Cypress is included as a separate E2E-runner reference, not folded into the MCP-vs-MCP comparison. It drove its own isolated Chrome profile, while Browser Controller used the existing Chrome profile; cache state therefore was not matched. Browser Harness was not rerun in this turn, so its 199 ms / five-trial number remains historical and cannot support a current ranking against Cypress.
- The prior investigation found the page-load timing itself close (~0.18–0.19 s). Candidate costs include navigation settling and repeated snapshots around observed batch steps, but phase-level timings are needed before selecting an optimization.
- The classifier is disabled by default, so it is not an evidenced explanation for the baseline gap.
- Relevant source paths: `extension/handlers/navigation.js`, `extension/handlers/interaction.js`, `mcp-server/src/tools/batch.ts`, and `mcp-server/src/tools/action-support.ts`.

## Unspecified / fog

- Which phase dominates p50 and which dominates p95 in the representative suite.
- Whether the highest-value fast path belongs in navigation readiness, batch observation, or another measured phase.
- Exact latency targets and the amount of variance that should count as meaningful improvement.
- The final safety and verification contract for each opt-in fast path.

Do not resolve these by guessing. Use the open tickets to gather local evidence and make the decisions explicit.

## Ticket convention

This is a local Markdown tracker because no project tracker was provided. Ticket state and dependencies live in each ticket's frontmatter. Open tickets are intentionally not duplicated here; find the current unblocked frontier with:

```sh
rg -n '^(title|type|status|blocked_by):' .wayfinder/real-browser-mcp-speed/tickets
```

The first work item is the benchmark protocol; continue only after its matched workload, postconditions, environment, and sampling are documented. Work remains planning-only until the user asks to implement a selected change.
