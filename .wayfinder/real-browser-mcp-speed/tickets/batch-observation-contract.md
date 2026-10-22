---
title: Define safe batch-level observation and verification options
type: grilling
status: open
blocked_by:
  - phase-latency-attribution.md
---

## Question

If repeated batch observations are a demonstrated bottleneck, which opt-in observation/verification modes can reduce work while keeping failures detectable and actions grounded in current page state?

## Bring to the decision

- Per-step and per-workflow snapshot costs from phase attribution.
- Existing `observe` modes and their actual guarantees.
- Cases where skipping or reusing observation could cause stale-target, occlusion, or wrong-action failures.
- Tests that preserve explicit strict/default behavior and exercise stale state and action failure paths.

Do not propose globally skipping observation or safety checks without evidence and a concrete invariant.
