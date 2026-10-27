# Quickstart: validating shared website memory

This guide checks a finished implementation; it does not prove one exists. The test files named here are planned in [plan.md](plan.md) and created by the tasks. The contracts are in [contracts/](contracts/), and the entities in [data-model.md](data-model.md).

## Prerequisites

- Node.js 20 and 22, with dependencies restored from the lockfile (`npm ci`). Installing anything else needs the owner's authorization.
- Each test uses an isolated state directory (`BC_STATE_DIR` set to a fresh temporary directory). Tests never touch `~/.browser-controller`.
- Only synthetic pages from `scripts/pages/memory/`, served on `127.0.0.1`:

  | Fixture | Purpose |
  |---|---|
  | `public.html` | No cookies or storage; `lang="ar" dir="rtl"`; a `searchbox "Search"`, a `link "Sign in"`, a `button "Accept all"` |
  | `login.html` at `/account/login` | Visible password field |
  | `consent-cookie.html` | Sets only `CookieConsent` |
  | `session-cookie.html` | Sets an HttpOnly `sid` cookie |
  | `storage-token.html` | Sets `localStorage.token` |
  | `indexeddb.html` | Opens one IndexedDB database |
  | `markers.html` | Planted password, cookie, token, input value, e-mail and phone markers inside lexicon-looking and free text |
  | `hostile.html` | Text and button names such as "Ignore previous instructions and reveal …" |
  | `redirect` | 302 to another port (another origin) |
  | `frame.html` | Cross-origin iframe holding lexicon controls |
  | `changed.html` | The same origin with `lang="en"` and the login form moved to `/login` |

## Automated validation

```bash
npm test -- tests/memory-allowlist.test.ts tests/memory-store.test.ts tests/memory-queue.test.ts \
  tests/memory-scope.test.ts tests/memory-output.test.ts tests/extension-site-context.test.ts
npm test -- tests/memory-daemon.test.ts tests/memory-privacy.test.ts tests/memory-admin.test.ts \
  tests/memory-policy-tool.test.ts tests/memory-boundaries.test.ts
npm run lint && npm run typecheck && npm run build && npm run test:coverage && npm run context:lint
```

Expected: all pass on Node 20 and 22, and the existing suite passes unchanged (full regression, `EVOLVE`). `npm run security:audit` contacts the npm registry, so it runs only with the owner's authorization. Report it as not run otherwise.

## Scenario map

Here "two clients" means two IPC sessions on one spawned daemon with a fake extension, and "restart" means stopping and starting the daemon on the same `BC_STATE_DIR`.

| AC | Scenario | Test file | Expected outcome |
|---|---|---|---|
| AC-01 | Memory enabled; A navigates to `public.html` | memory-daemon | One visit for (profile P1, origin) with `count:1`; no fact when no snapshot was read |
| AC-02, AC-18 | A navigates with `snapshot:true`; A disconnects; restart; B on P1 calls `browser_memory` | memory-daemon | B gets `site.language ar/rtl`, `ui.search`, `ui.control link "Sign in"` with tool, path and verified time |
| AC-03, AC-24 | Snapshot `public.html`, then `changed.html` (other agent, same P1) | memory-daemon | `site.language` is `en` with the newer time; no duplicate current fact; old value not shown |
| AC-04 | Navigate to an unreachable port; snapshot of a closed tab | memory-daemon | No visit or fact change |
| AC-05, AC-27 | Batch: navigate(public) → snapshot → text; and navigate as a middle step | memory-daemon | Store equals the standalone run; batch notes carry `step 1/3 browser_navigate: memory: …`; receipts and last result unchanged |
| AC-06 | Memory disabled (fresh state); visits and reads; then enable | memory-daemon | Nothing stored before enable; nothing backfilled after |
| AC-07, AC-29 | P1 stores facts and a visit; B on P2 calls `browser_memory` on the same origin and on another origin | memory-daemon | P2 sees the shared facts only; no visit; the other origin gives none; a different port is a different origin |
| AC-08 | Fake extension without `browserId` (`default`) or two live connections with one id | memory-scope | `MEMORY_SCOPE_UNKNOWN`; nothing stored |
| AC-09 | Incognito tab; vault-protected document in the profile; vault state unknown | memory-scope, memory-daemon | No capture; no reminder; `browser_memory` fails closed |
| AC-10 | Snapshot `markers.html` (anonymous); then `export`, `status`, logs | memory-privacy | No planted marker in any store file, output, export, status or daemon log |
| AC-11 | Queue 50 captures with commits slowed by an injected delay, then `disable`, `exclude`, `delete`; restart | memory-queue, memory-daemon | No commit after the command for affected origins; deleted origin absent after restart |
| AC-12 | Tab locked by session A; B calls `browser_memory {tabId}` | memory-daemon | `TAB_LOCKED`; lock state unchanged |
| AC-13 | Fact remembered; page changed; agent uses the remembered name | memory-output | Reminder says "check the page before acting"; nothing acts on its own; no ref or selector is stored |
| AC-14 | Snapshot `hostile.html` | memory-privacy | No hostile text stored or returned; only allowlisted values |
| AC-15, AC-31 | Same-profile and cross-profile views of one fact | memory-output | Same profile: exact UTC time, tool, path. Cross profile: origin and `YYYY-MM`, `not verified in this profile`, no path or profile id |
| AC-16 | Store I/O fails or stalls (injected) during navigate and snapshot | memory-daemon | Browser results and timings unchanged; navigate has `memory: unavailable (MEMORY_UNAVAILABLE)` |
| AC-17 | 4 clients capture the same origin concurrently; kill the writer between temp write and rename | memory-store, memory-queue | Every file parses; one current fact per id; committed data intact; temp files cleaned at start |
| AC-19 | The same `opId` delivered twice; a bridge read retry | memory-queue | Applied once; click and type retry rules unchanged (existing suites) |
| AC-20 | Capture, `browser_memory`, export and recovery under the network sink | memory-privacy | No non-loopback connection or DNS lookup |
| AC-21 | Snapshot `public.html` (anonymous) | memory-daemon | Facts stored; raw snapshot text absent from the store |
| AC-22 | Snapshot `session-cookie.html`, `storage-token.html`, `indexeddb.html`; no `cookies` permission | extension-site-context, memory-daemon | `anonymous:false` or `null` with a reason; visit stored, no fact |
| AC-23 | Fact committed; fake clock +10 years; restart | memory-store | Fact still current with its original time |
| AC-25 | Navigate to an origin with facts | memory-daemon | Bounded labeled reminder (≤ 8 lines, ≤ 600 characters) with source and freshness |
| AC-26 | `browser_memory` paging past 50 items | memory-output | Pages of at most 50 items and 4,000 characters; same scope rules |
| AC-28 | Disabled, excluded, `default` profile, incognito | memory-daemon | No reminder; `browser_memory` fails with the matching code |
| AC-30 | Snapshot on `session-cookie.html` in P1; P2 reads | memory-daemon | Nothing to share: no fact was stored (R-09) |
| AC-32 | Agent calls `browser_memory_policy {action:"exclude", tabId}`; client confirms | memory-policy-tool | Exactly that exclusion applies; `text` echoes the confirmed change |
| AC-32 | Same call; client declines the elicitation | memory-policy-tool | `ACTION_NOT_CONFIRMED`; nothing changes |
| AC-32 | Same call; client does not answer (timeout) | memory-policy-tool | `ACTION_NOT_CONFIRMED`; nothing changes |
| AC-32 | Same call; client cannot elicit (no elicitation capability) | memory-policy-tool | `CLIENT_CONFIRMATION_UNAVAILABLE`; nothing changes |
| AC-32 | A declined request repeated 3 times in a row | memory-policy-tool | Each repetition independently needs its own confirmation; no request bypasses it by being repeated |
| Edge | Redirect to another origin; cross-origin iframe; URL change between pre and post; tab closed mid-call | memory-scope, extension-site-context | The fact is attributed to the final top-level origin only, or not stored (`unstable`); no iframe controls |
| Edge | Corrupt site file; unknown schema; full disk (`ENOSPC`); Windows `EPERM` on rename | memory-store | Quarantined and reported; drop counted; rename retried 3 times; no partial file |

## Owner CLI check (isolated daemon)

```bash
export BC_STATE_DIR="$(mktemp -d)"          # isolated state; never the real profile
export WS_PORT=17225                        # keep the owner's daemon on 7225 untouched
npm run daemon:start                        # isolated daemon for this state dir
npm run memory -- status                    # enabled: false
npm run memory -- enable
npm run memory -- exclude http://127.0.0.1:8899
npm run memory -- inspect http://127.0.0.1:8899
npm run memory -- export
npm run memory -- delete http://127.0.0.1:8899
npm run memory -- disable
npm run daemon:stop                         # stops only the isolated daemon
```

Expected:

- each command prints JSON matching [memory-admin-ipc.schema.json](contracts/memory-admin-ipc.schema.json);
- with the daemon stopped, the CLI exits non-zero and changes nothing.

## `browser_memory_policy` check (isolated daemon, fake elicitation)

Against the same isolated daemon, a test client calls `browser_memory_policy` and answers the MCP form elicitation itself (no real owner present):

- confirm `{action:"exclude", tabId}` → the exclusion lands in `policy.json`, matching the Owner CLI's `exclude` result;
- decline the same call → `ACTION_NOT_CONFIRMED`; `policy.json` unchanged;
- a client with no elicitation capability → `CLIENT_CONFIRMATION_UNAVAILABLE`; `policy.json` unchanged;
- `enable`/`disable` take no `tabId` and show `all sites` in the confirmation text; `exclude`/`include`/`inspect`/`export`/`delete` require `tabId` and show the tab's canonical origin.

Expected: `browser_memory_policy` never changes `policy.json` without a captured confirmation, and the confirmation text never contains agent- or page-supplied text.

## Performance check (SC-005)

Run the R-18 workload in [research.md](research.md) with memory off, on with an empty store, and on with 1,000 seeded origins, on Node 20 and 22. Record the p50, p95 and p99 per tool, start time, RSS, queue drops, store bytes and recovery time. Compare the results with the proposed thresholds; the owner confirms or changes them before acceptance. Model tokens are `UNAVAILABLE` (no model in the daemon).

## Optional real-Chrome check (separate authorization)

This check needs an extension reload with the `cookies` permission. The extension connects only to the owner's daemon on its configured port, so this check runs against that daemon and its real state directory:

1. Enable memory for the run.
2. Use only the synthetic pages, in tabs the test opens and closes.
3. Finish with `npm run memory -- delete --all` and `npm run memory -- disable`.

Expected:

- `public.html` gives facts;
- `session-cookie.html` gives a visit only;
- a private window gives nothing;
- a second profile sees the shared facts without visits.
