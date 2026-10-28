# Site map baseline (specs/004-site-navigation-map, R-23)

- **Date**: 2026-10-28
- **Runner**: `node scripts/map-bench.mjs --iterations 200 --routes 20 --write`
- **Node**: v22.23.1 on darwin/arm64, Apple M4, 10 cores
- **Node 20**: not run (not installed on this machine).
- **Method**: in-process on the dist modules, with a fresh temp memory directory per section; no daemon, extension or browser. Times are wall-clock ms from `performance.now()`. Website memory is on in both capture modes, so the difference is the map's own cost.

## Capture (SC-005)

Each iteration is a navigate with a snapshot of the root (20 navigation links), an attributed click to one of 50 section paths, and a snapshot of that page. "On the call path" is the time website memory adds to the agent's call: the reminder (`withReminder`, which reads 003 and the map) and the synchronous `afterCall` enqueue. "Commit" is the `flush()` that follows; in the daemon it runs after the answer, off the call path.

SC-005 targets (accepted at gate 4): p95 at most 25 ms for a navigation and 30 ms for a page read, with the map on.

| Measure | n | p50 ms | p95 ms | p99 ms |
|---|---|---|---|---|
| navigate, on the call path, map off | 200 | 0.408 | 0.902 | 1.01 |
| navigate, on the call path, map on | 200 | 1.43 | 1.68 | 1.80 |
| snapshot, on the call path, map off | 200 | 0.172 | 0.422 | 0.449 |
| snapshot, on the call path, map on | 200 | 0.181 | 0.292 | 0.432 |
| click, on the call path, map off | 200 | 0.002 | 0.006 | 0.007 |
| click, on the call path, map on | 200 | 0.135 | 0.244 | 0.355 |
| navigate commit, map off | 200 | 8.65 | 11.02 | 11.19 |
| navigate commit, map on | 200 | 27.50 | 31.57 | 34.08 |
| snapshot commit, map off | 200 | 8.62 | 10.96 | 11.30 |
| snapshot commit, map on | 200 | 19.79 | 22.89 | 24.82 |
| click commit, map off | 200 | 0.002 | 0.005 | 0.005 |
| click commit, map on | 200 | 20.82 | 23.89 | 28.34 |

Pages learned: 0 with the map off, 51 with it on.

## Lookup (SC-005)

SC-005 target (accepted at gate 4): p95 at most 50 ms on an origin at its limits.

Map file at its limits: 45 pages, 2700 controls, 1029966 bytes after the 1 MiB trim (455 entries trimmed). The first lookup of a fresh service reads the file cold: 18.66 ms. The rest use the store's cache, as a running daemon does.

| Lookup | n | p50 ms | p95 ms | p99 ms |
|---|---|---|---|---|
| by tab, with query | 200 | 4.87 | 5.94 | 7.84 |
| by named origin, with query | 200 | 4.97 | 6.10 | 8.00 |
| outline (named origin, no query) | 200 | 3.61 | 3.89 | 4.18 |

## Page loads to a target three clicks deep (SC-002)

Route: `/` → `/accounts` → `/accounts/team` → `/accounts/team/permissions`, 20 runs per mode. A page load is a navigate or a click that changed the URL.

| Mode | Mean page loads |
|---|---|
| Without the map (navigate to the root, 3 clicks) | 4 |
| With the map (lookup, then one navigate) | 1 |

The lookup returned the target path in 20 of 20 runs with the map.

## Notes

- R-23 planned a synthetic site under `scripts/pages/map/` driven through a fake extension. This runner models the same route in-process instead, so it measures the daemon-side work only, not browser or IPC time.
- The limits in `map-allowlist.ts` and these targets were accepted at plan gate 4 on 2026-10-28 (plan.md).
