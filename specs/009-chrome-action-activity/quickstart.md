# Quickstart: Chrome action activity

The feature is implemented locally. These steps describe the acceptance flow; the complete three-batch extension walkthrough and formal review are still pending.

## Local checks

1. Use the repository's already-installed dependencies; do not install or upgrade anything.
2. Run focused Vitest suites for batch metadata, bridge participant routing, extension activity storage, input outcomes, and popup rendering.
3. Run npm run lint, npm run typecheck, npm run build, npm run test:coverage, npm run context:lint, npm run context:measure, and npm run arch:check.
4. Open the extension popup in an isolated local test profile and select Actions.

## Acceptance walkthrough

1. On a local fixture page, run three separate browser_batch calls with four button clicks total.
2. Confirm the popup displays three batch groups and exactly four dispatched action rows. Each click row should show the resolved DOM id when present and the confirmed/requested click count for that call. No preflight, delay, skipped child, or retry should appear as another row.
3. Exercise a confirmed click, a pre-send refusal, a two-click operation stopped before its second click, and a send with no confirmation. Confirm click counts reflect confirmed/uncertain/not-sent inputs and English status wording does not claim site acceptance.
4. Navigate the top-level document and perform another action. Confirm the earlier click remains on the source visit. Use SPA history navigation and confirm it remains in the same document visit.
5. Close a fixture tab and reopen the popup. Confirm its history remains available; restart only the extension worker and confirm it still loads.
6. Hide element details, then inspect the isolated session store. Confirm old and new target labels and DOM ids are absent and no selectors, form values, or page output are present. Re-enable details and confirm only newly captured records may contain them.
7. Clear the history; confirm events and truncation notices disappear.
8. Use a controlled test with two mock extension connections to prove a batch finish marker reaches only the connection selected for that child call. Verify reconnecting does not inherit a marker.
9. Verify keyboard navigation, focus visibility, English LTR, loading/empty/storage-error states, and the popup's narrow layout.

Do not run these actions against an authenticated site or the Owner's normal Chrome profile. The real-Chrome smoke script restarts the daemon and uses the normal profile, so it is outside the approved verification scope.
