# Cypress checkbox comparison

## Scope

This is an additional browser-runner reference, not an MCP server comparison. It repeats the historical checkbox scenario on `https://the-internet.herokuapp.com/checkboxes`: load the page, verify checkbox 1 starts unchecked, click it, and verify it is checked. The matching Browser Controller run uses `browser_batch` for the same navigation, click, and postcondition.

The Browser Controller times are host-observed MCP-call wall times. Cypress times start immediately before `cy.visit()` and stop after the click and assertion; they include Cypress task-bridge overhead but exclude Cypress/Chrome process startup. These execution paths are different, so use the measurements as a diagnostic reference, not a claim that one product is universally faster.

## Reproduce

Use Cypress 16.2.0, Chrome 155, and Node 22. From this directory, install the published Cypress package and binary in an isolated temporary folder (npm 12 may block the install script, so install the binary explicitly):

```sh
BENCH_DIR="$(mktemp -d)"
npm install --prefix "$BENCH_DIR" --no-save --no-package-lock cypress@16.2.0
CYPRESS_CACHE_FOLDER="$BENCH_DIR/cache" "$BENCH_DIR/node_modules/.bin/cypress" install
CYPRESS_CACHE_FOLDER="$BENCH_DIR/cache" \
CYPRESS_BENCHMARK_OUTPUT="$BENCH_DIR/cypress-samples.csv" \
  "$BENCH_DIR/node_modules/.bin/cypress" run \
  --browser chrome \
  --config-file cypress.config.cjs \
  --spec checkbox.cy.js
```

The spec defaults to 30 samples (`expose.BENCHMARK_RUNS`). Cypress launches its own isolated Chrome profile; it does not attach to the user's open Chrome profile ([official browser launch docs](https://docs.cypress.io/app/references/launching-browsers)). The repository source checkout was shallow-cloned separately for this request; the run used the official 16.2.0 package and binary rather than building Cypress from source ([official install docs](https://docs.cypress.io/app/get-started/install-cypress)).

## Results — 2026-10-22

Percentiles use nearest rank. Raw per-run values are in `runs-2026-10-22.csv`.

| Runner | Samples | Pass | p50 | p95 | Min / max |
| --- | ---: | ---: | ---: | ---: | ---: |
| Browser Controller 3.0.5 (`browser_batch`) | 30 | 30 | 847 ms | 1,149 ms | 778 / 1,226 ms |
| Cypress 16.2.0 + Chrome 155 (all samples) | 30 | 30 | 281 ms | 942 ms | 248 / 11,514 ms |
| Cypress 16.2.0 + Chrome 155 (excluding first sample) | 29 | 29 | 280 ms | 542 ms | 248 / 942 ms |
| Browser Harness MCP 0.1.13 (previous run; historical only) | 5 | 5 | 199 ms | not recorded | not recorded |

Cypress's first measured page load took 11.514 s; the Cypress run completed 30/30 tests in 23 s. Keep that cold outlier visible: the external test site and its network dependencies make this a noisy single-run result. A separate post-run smoke check returned HTTP 200 with no console errors, but observed two failed third-party analytics DNS requests to `log.optimizely.com`. Browser Controller ran in the user's existing Chrome profile; Cypress ran with its own isolated profile, so browser cache state was not matched. Browser Harness 0.1.13 was not rerun here; its 199 ms median came from five successful prior trials, so do not infer a fresh Harness-vs-Cypress ranking from these numbers.

## Environment and provenance

- macOS 15.7.9; Chrome 155.0.8059.85.
- Cypress source: shallow clone of `cypress-io/cypress`, `develop` commit `8bd3015` (150 MB checkout).
- Runtime: published Cypress npm package and binary 16.2.0; Cypress runner Node 22.22.2.
- Browser Controller: project package 3.0.5, existing browser-controller MCP connection.
- The disposable page tab was closed after the run. No Facebook/login/profile data was accessed, and the project dependency manifests were not changed.
