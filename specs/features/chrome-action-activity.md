---
version: v0.1.0
mode: EVOLVE
risk_tier: CONTROLLED
tier_decision: "Owner authorized local implementation on 2026-11-09; independent CONTROLLED review pending"
status: implemented locally; formal acceptance pending
baseline: 7b8c7d3e8816229d90b9fff46c867523e002cd0e
---

# Chrome action activity

## Goal

Show the browser owner a bounded, honest timeline of public page tool calls that actually reached the extension, grouped by browser_batch invocation and page visit, beside a privacy-safe summary of the affected page.

## Scope

- A dedicated Actions view in the existing popup.
- Numbered tool steps paired with a page-context summary that shows only the host and latest tool outcome.
- Metadata-only `browser_snapshot` rows; the snapshot contents are never retained.
- Session-only records that survive tab close and extension worker restart, capped at 500 events and cleared at browser-session end.
- Resolved element labels and clicked-element DOM ids by default, with a control that hides and erases both.
- Per-click confirmed and requested counts, including multi-click operations.
- Explicit dispatch status separate from evidence of a site effect.
- Exact participant-scoped batch-end markers; no manifest of planned steps.

## Out of scope

- Persistent history across browser sessions or export/sync.
- Raw tool arguments, typed or form values, page text/snapshots, evaluation results, screenshots, full URLs, titles, or credentials.
- Private vault workflows, authenticated live-site testing, normal-profile Chrome smoke tests.
- Commit, push, deploy, or external service calls.

## Contract

JSON Schema: specs/contracts/chrome-action-activity.schema.json. Contract behavior tests are required before implementation is accepted.

## Acceptance criteria

- Three separate browser_batch calls containing four actually dispatched button clicks yield three groups and four action rows; internal work, skipped steps, and retries do not create duplicates.
- A click that triggers navigation remains attributed to its source document; a SPA history change stays within its current visit.
- Input status says what the extension confirmed and never claims site acceptance from dispatch alone.
- Each click row shows the resolved DOM id when present and the number of confirmed clicks; it never stores the locator string.
- Navigate, snapshot, type, and click calls appear as ordered tool names; page context contains no title, full URL, field values, page text, or screenshot.
- Hiding element details erases stored labels and DOM ids and defeats queued writes; no raw selectors, page text, or input data is persisted.
- Activity survives tab closure and worker restart, ends with the browser session, and has a visible 500-event truncation state.
- Batch end markers reach only the live extension connections that received a child call for that trusted IPC session and batch run.
- English LTR, keyboard access, loading/empty/error states, and the existing popup behavior are verified.

## Evidence

Local evidence manifest: specs/evidence/chrome-action-activity/manifest.json. It records implementation, local checks, and an isolated popup walkthrough. It does not claim full extension end-to-end verification, CI acceptance, independent review, or Owner sign-off.

## Approver

Owner. The Owner authorized execution after the plan preview. The reviewer-owned requirements checklist remains unchecked; independent CONTROLLED review and formal acceptance are pending.
