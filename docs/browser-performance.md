# Browser performance options

These options are opt-in. Existing calls retain their normal behavior. The controller already reuses its CDP connection per tab while it remains valid; its registry state is not proof that a connection is live.

## Timing

Set `timings: true` on `browser_click` for numeric phase data in `structuredContent.receipt.timings`. Available fields include `tab_lookup_ms`, `connection_ms`, `target_resolution_ms`, `input_dispatch_ms`, `settle_ms`, and for hover or drag `interaction_ms`. `connection_state` is the connection registry state before setup: 0 new, 1 pending, 2 ready. Unavailable phases are omitted. These measurements do not establish whether an application saved changes.

Set `timings: true` on `browser_batch` for each completed step's `elapsedMs`, plus total, nearest-rank p50/p95 and per-tool summaries in `structuredContent.timings`. Step durations include the full normal tool path and any retries; they do not isolate transport cost. The batch runs sequentially through normal per-action safety and timeout checks.

## Incremental snapshots

Call `browser_snapshot` with `delta: true`. A full response starts with a JSON header containing `kind: "full"` and `revision`, followed by a newline and the full tree. Preserve the text and revision. On the next call use `since: <revision>` with the same tab and scope. A `kind: "delta"` JSON response gives `baseRevision`, `revision`, `startLine` (zero-based), `deleteCount`, and replacement `lines`; apply that splice to the prior full text split on newlines. If a full response arrives, replace the baseline. If `revision` is null, request a new full baseline later.

Baselines expire after 30 seconds and are scoped to the controller host, tab and snapshot options. Navigation, missing baselines, truncated trees, large trees, and changes that would not yield a smaller delta result in a full response. Only digests of already redacted lines are cached. A snapshot still reads the full tree from the page: deltas reduce response size, not page traversal or transport work. Refs must still be checked by the normal action path.

## Preflight and application rejections

A batch may provide caller-observed evidence, for example:

```json
{"tabId": 12, "preflight": {"kind": "freeze_columns", "frozenColumns": 2, "mergedColumns": [{"first": 1, "last": 3}], "evidence": "complete"}, "actions": [{"tool": "browser_click", "params": {"target": "#freeze"}}]}
```

Column numbers are one-based. A span crossing the boundary returns `PREFLIGHT_CONFLICT` before any action. Incomplete or unavailable evidence returns `PREFLIGHT_UNKNOWN` when columns are frozen. This only checks the supplied spans: it does not inspect a live sheet, confirm freshness, or prove that an action actually freezes the declared number of columns. The result explicitly says `liveSheetVerified: false`.

For a known error indicator, `browser_click` accepts `rejectTarget` as a locator string. If it becomes visible after the click, the result is `APPLICATION_REJECTED` with receipt status `application_rejected`. A pre-existing indicator is not attributed to the click; an unavailable observation is reported as such. The click has already been dispatched, so inspect the page before retrying. This is an explicit observation and does not detect every application error.

The local paired benchmark framework and its limitations are described in [browser-performance-guide.md](../scripts/browser-performance-guide.md). It requires trusted, isolated adapters for both tools; no real comparison or speedup has been established by adding the framework.
