# Research: site navigation map for browser agents

**Feature**: [spec.md](spec.md) · **Plan**: [plan.md](plan.md) · **Date**: 2026-10-28

Sources are this repository at `92012c4` plus the uncommitted allowlist changes and Spec Kit files, read through codebase-memory, graphify and the source itself. No external service was contacted. Graph results were checked against source.

Baseline facts used by the decisions:

- **Capture hook.** `Daemon.routeCall` (`mcp-server/src/daemon.ts:406`) is the only caller of `MemoryService.afterCall` (codebase-memory `trace_path`). It calls `beginCall` (`:450`), routes through `routeVaultAwareCall` with `observe` (`:454-463`), adds the reminder only on success (`:466`), sends the result and then calls `afterCall` (`:468`).
  - `afterCall` returns early without an observation (`memory/service.ts:198`). An observation exists only for a successful observed call (`vault/daemon-routing.ts:110-117`), so failed calls never reach capture today.
- **Observed tools.** Only `browser_navigate` and `browser_snapshot` are observed: `OBSERVABLE_TOOLS` (`mcp-server/src/bridge-frames.ts:53`) and `OBSERVED_TOOLS` (`extension/dispatch/router.js:96`). `browser_click` is not observed.
  - `withObserve` strips any caller-supplied `observe` (`bridge-frames.ts:60-71`). Action tools' own `observe: 'diff'` is removed on the MCP side before dispatch (`tools/action-support.ts:269`), so the two never meet on the wire.
- **Batch.** `browser_batch` runs in the MCP process; each step is its own daemon call (`tools/batch.ts:58`). Earlier steps' `memory` lines go into the batch notes (`tools/batch.ts:159-162`).
- **Click `expect` and `observe:'diff'`.** These run in the MCP process. They take `browser_snapshot {maxChars: 50000}` before and after the click (`tools/action-support.ts:221-231`), and those snapshots are observed daemon calls. The daemon sees the click itself without `expect`.
- **Click result** (`extension/handlers/interaction.js:101-113`, `:258-312`): `{success, text, input, at, navigated?, dialog?, download?}`. `navigated` is set only when the tab URL changed within the settle window. The result has no `url` field.
  - Locator failures: `NOT_FOUND`, `AMBIGUOUS` (up to 5 candidates), `ELEMENT_HIDDEN`, `ELEMENT_DISABLED`, `ELEMENT_COVERED`, `REF_GONE`, `REF_NOT_FOUND` and `CLICK_MISSED`.
  - Other failures: `INPUT_BLOCKED`.
- **`{role, name, nth}` resolution** (`extension/lib/target.js:20-41`, `extension/lib/page-dom.js:477-530`). The role must match exactly. The name must match the whole name, ignoring case. Hidden elements are skipped and all roots are searched. Without `nth`, 0 hits is `NOT_FOUND`, 1 hit is used and more than 1 is `AMBIGUOUS`.
- **Snapshot format** (`extension/handlers/inspection.js:349-550`):
  - The first line is `page: <title> — <URL>`.
  - Then one line per printed node: `indent role ["name"] [eN] [value="…"] flags [context="row text"]`.
  - An unlabelled landmark prints with no quotes.
  - Links carry no href.
  - Truncation adds the line `… truncated (N more chars): narrow with query or target` and sets `truncated: true`.
  - `refs[{ref, role, name}]` comes with the result.
  - A scoped read is visible only through `params.query` or `params.target`.
  - `browser_navigate {snapshot:true}` appends at most 8,000 characters. It does not pass `truncated` through; only the marker line shows it.
- **Navigate result** (`extension/handlers/navigation.js:476-488`): `{success, url, tabId, status?, requestedUrl?, …, text}`.
  - `url` is the final URL. `status` is the last main-frame HTTP status. `requestedUrl` appears only when the final URL differs from the request.
  - A 404 is a success with `status: 404`. A network failure is `NAVIGATION_FAILED`.
- **Profile identity.** The profile is the authenticated connection's `browserId`, and `decideScope` (`memory/scope.ts:71-96`) fails closed on `default` or duplicate ids.
  - Without a tab, `deps.connection(sessionId)` gives `{browserId, connectionId, ambiguous, supportsSiteContext}` (`memory/service.ts:32-43`).
  - `BridgeConnections.forSession` (`mcp-server/src/bridge-connections.ts:109-130`) resolves the session's selected or pinned browser.
  - `vault.memoryEligibility(browserId, tabId?)` accepts a missing tab.
- **003 storage** (`memory/store.ts`, `memory/site-record.ts`, `memory/queue.ts`):
  - There is one file per origin, keyed by `sha256(origin)`. A record is capped at 64 KiB; the store at 5,000 origins and 32 MiB.
  - The queue lives in memory only and holds up to 256 pending origin groups. Duplicate `opId`s are dropped (1,024 remembered). A commit times out after 2 s, and the policy is checked again before each write (`policyVerdict`, `queue.ts:78-87`).
  - Corrupt files are quarantined as `*.corrupt-<ts>`.
  - `atomicWriteFile` (`memory/atomic-file.ts:59-79`) is generic.
- **003 policy** (`memory/policy.ts:24-109`): `{schemaVersion: 1, enabled, enabledAt, excluded, deletions, updatedAt}`. Validation drops unknown keys without an error. `disable` keeps records (`memory/admin.ts:59-63`); `delete` writes a tombstone and then deletes.
- **Policy tool.** `browser_memory_policy` actions are listed in three places: `memory/policy-tool-route.ts:15`, `tools/memory-policy.ts` and `daemon-config.ts:215`. Confirmation is an MCP form elicitation built from the action and origin (`tools/memory-policy.ts:75`). Declined or unanswered prompts are rate-limited, 3 per 10 minutes per host.
- **Module limits.**
  - `tests/architecture-maintenance.test.ts:39-49` caps every production module at 600 lines. `daemon.ts` is at 595, `inspection.js` 588, `queue.ts` 512, `navigation.js` 503 and `router.js` 496.
  - The R-16 locality test (`:57-75`) lets `mcp-server/src/memory/**` import only `node:fs`, `node:fs/promises`, `node:path` and `node:crypto`, `./` paths, and four named `../` siblings. The walk is recursive, so a subdirectory module that imports `../store.js` would fail.
- **Tool routing.** `isMemoryTool` (`memory/policy-tool-route.ts:163`) decides daemon routing at `daemon.ts:452` and `:332`. A new daemon-owned tool can be added there without editing `daemon.ts`. `allTools` has 21 tools (`tools/registry.ts:32-54`; name list in `tests/tools/registry.test.ts:17`).
- **Graphify blast radius** (`graphify affected`, depth 2):
  - `buildSiteContext` is called by `withSiteContext` and by `handleMemoryContext` (`extension/handlers/memory-context.js:12`, the `browser_memory_internal_context` action). Seven extension test files import it dynamically.
  - `buildReminder` is called by `MemoryService.reminderLines`/`withReminder` and tested in `memory-output`, `memory-admin`, `memory-cr-fixes`, `memory-privacy` and `memory-service`.
  - `runAdminCommand` is called by `adminFromWire` and `MemoryService.admin`.
  - `withObserve` is called by `routeVaultAwareCall` and `Daemon.routeCall`, and tested in `memory-protocol` and `vault-service`.
  - `isMemoryTool` is called by `Daemon.routeCall` and `Daemon.handleNewClient`.

## R-01 Where the map lives

- **Decision**: New flat modules `mcp-server/src/memory/map-*.ts`, composed by `MemoryService` through a `MapService` facade. No new dependency.
- **Rationale**: The map shares 003's scope decision, policy gate, IPC, confirmation path, failure isolation and local-only rule. Flat files keep the R-16 locality test valid, because sibling imports are `./`. Hooking through `MemoryService` keeps `daemon.ts` (595 lines) unchanged: its calls at `:450-468` already reach `beginCall`, `withReminder` and `afterCall`, and `isMemoryTool` routes a new tool.
- **Alternatives considered**: A `memory/map/` subdirectory would need `../` imports and a change to the locality test. A separate daemon service would need new call sites in `daemon.ts`, which has 5 lines of headroom.

## R-02 Storage layout and limits

- **Decision**:
  - One JSON file per (profile, origin): `memory/maps/<sha256(browserId)>/<sha256(browserId + "\n" + origin)>.json`, with one directory per profile, so a per-profile count, a profile delete-all and an origin delete across profiles need no file reads. It holds pages, controls, use results and counts for that pair (data-model.md).
  - Per-profile counters: `memory/map-counters.json`.
  - The writes and quarantine work as in 003: `atomicWriteFile`, the private-directory check and `*.corrupt-<ts>`. The shared helpers move from `store.ts` into `memory/record-files.ts` without changing behavior; the existing store suite covers the move.
  - Limits, provisional and confirmed after the baseline (gate 4; accepted as listed on 2026-10-28):
    - ≤ 500 pages per map file, ≤ 60 controls per page.
    - ≤ 1 MiB per map file. The byte limit is the binding one: at about 250 bytes per control, it holds about 4,000 controls.
    - ≤ 1,000 map files per profile, ≤ 64 MiB for all map files.
  - Within a file, the least recently seen-or-used page goes first (R-18). At the profile or total limit, observations for a new (profile, origin) are dropped and status reports `MEMORY_FULL`, as 003 does for new origins.
- **Rationale**:
  - Each read and each write touches one (profile, origin). The file name hides both. A map never mixes profiles (FR-005).
  - 500 × 60 controls would be about 7.5 MB, too large to rewrite per observation, so the byte limit bounds rewrite time. Typical sites stay far below it.
  - The LRU cache keeps lookups in memory, so the 50 ms p95 lookup target (SC-005) does not depend on parse time once warm.
- **Alternatives considered**:
  - Sharding one file per page: writes would be small, but a word lookup would read up to 500 files or need a duplicate name index.
  - Putting maps inside 003's `SiteRecord`: it is capped at 64 KiB and shared across profiles.
  - Evicting the least recently used origin at the profile limit: this was rejected for consistency with 003. Deleting whole sites silently is a larger surprise than a full status that the owner can act on.

## R-03 Writer and queue

- **Decision**: A separate `MapQueue` (`memory/map-queue.ts`) with 003's contract:
  - Groups are keyed by map file. At most 256 pending groups; extra work is dropped and counted.
  - Duplicate `opId`s are dropped, with 1,024 remembered.
  - One read and one atomic write per group, with a 2 s commit timeout.
  - The policy is checked again at commit (R-04). `dropPending` and `settle` are used by owner commands.
- **Rationale**: `queue.ts` (512 lines) is typed to `SiteRecord` and `applyOp`. Adding a second record kind would pass the 600-line cap and couple the two kinds. The pattern is small and well tested, and the map queue copies its tests.
- **Alternatives considered**: A generic queue refactor of 003. It was rejected for 004 because it changes accepted 003 code paths without a behavior gain. It can be proposed later as a separate refactor.

## R-04 Map policy

- **Decision**: A separate file `memory/map-policy.json`:
  - `profiles: {[browserId]: {enabled, enabledAt}}`
  - `excludedPaths: {[origin]: prefix[]}`
  - `deletions: Tombstone[]`
  - `updatedAt`

  The map is effective for a call only when all of these hold:
  - 003 `enabled` is true.
  - The map is enabled for the call's verified `browserId`.
  - The origin is not in 003 `excluded`.
  - The path is not under an excluded prefix (R-13).
  - No tombstone newer than the operation applies.

  Enabling is per profile. The prompt names the profile's label (FR-006, AC-17).
- **Rationale**:
  - 003's `validatePolicy` drops unknown keys, so a map flag inside `policy.json` would be erased by any 003 write in an older build. A separate file also keeps 003's schema version 1 unchanged.
  - Per-profile enabling matches the enable prompt ("pages agents visit in this profile"). Enabling the map for a work profile must not enable it for a personal one.
- **Alternatives considered**: `policy.json` schema v2 with a `map` block; it has the downgrade-loss problem and would raise 003's schema version. A single global switch; the prompt could not name one profile.

## R-05 Disable, delete and 003 interplay (CHK001, CHK002)

- **Decision**:
  - **Map disable** stops collection for that profile, drops its pending work and hides the map from lookups and reminders. Existing data is kept until it is deleted, as 003 `disable` keeps records. The disable prompt says that data is kept and names the delete action.
  - **003 disable** stops the map too (FR-006).
  - **003 site delete** also deletes that origin's map files in every profile.
  - **003 `delete --all`** also deletes every map file and every counter.
  - **Map deletions** never delete 003 records.
  - Every delete writes its tombstone before removing files, so queued work cannot bring entries back (AC-16).
- **Rationale**: The owner reads "delete this site's memory" as covering everything Browser Controller remembers about it. Keeping data on disable matches 003 and lets the owner re-enable without relearning.
- **Amendment after the T036 review (2026-10-28)** (RV-06, RV-12):
  - Lookups, reminders, `inspect` and `export` apply the tombstones and path exclusions to what they read, so an entry whose file rewrite failed is never shown.
  - A page delete or path exclusion re-checks the file after the rewrite. If entries are still there, the command answers `MEMORY_UNAVAILABLE`, says the change is saved and asks the owner to run it again.
  - Tombstones are pruned only once the queue has drained past them and they are older than 7 days (`MAP_TOMBSTONE_RETENTION_MS`).
  - The commit check applies both 003 tombstones, the origin's and `*`, so an older site delete does not hide a newer delete-all.

## R-06 Observing clicks

- **Decision**:
  - Add `browser_click` to `OBSERVABLE_TOOLS` and `OBSERVED_TOOLS`. The daemon asks for it only when the map is effective for the session's profile; 003 never captures from a click.
  - The extension answers an observed click with a light `siteContext`:
    - `url` (after), `fromUrl` (the tab URL captured before the handler), `incognito`.
    - `topLevel: true`, because these are tab-level URLs.
    - `stable`: the URL after the handler equals a second read.
    - `anonymous: null` and `anonymityReason: 'not_probed'`.
  - The light block runs no page script and reads no cookies or storage. `buildSiteContext` gets an opt-in `light` option, and its other callers (`withSiteContext` for navigate and snapshot, `handleMemoryContext`) are unchanged.
  - A new extension capability `site-map` (`extension/lib/protocol.js`, `mcp-server/src/protocol.ts`) advertises it. Without it, clicks are not observed. The map then learns pages and controls from reads but no destinations or hub pages.
- **Rationale**:
  - Destinations and hub pages (AC-07, AC-08, FR-002) need to know which control was used and where the tab went.
  - The destination's read context comes from the source page's read (R-09), so the click needs no anonymity probe. That keeps clicks within a few milliseconds of extra time: two `chrome.tabs.get` calls bounded by `URL_BEFORE_BUDGET_MS`.
  - `fromUrl` from the browser, not from the daemon's cache, ties the click to the page it happened on.
- **Alternatives considered**:
  - Inferring the destination from the next observed read: a manual navigation in between would misattribute it.
  - Using the MCP-side `expect` result: the daemon never sees it.

## R-07 Attributing a click to a control (CHK012)

- **Decision**: The daemon keeps an in-memory **tab read cache**.
  - Key: (connection id, tab id). Size: at most 64 tabs, least recently used first.
  - Content: the last observed read of each tab, holding origin, raw and masked path, read context, language, completeness, `readChars` and the parsed eligible controls (R-10). The cache never holds page text.
  - It is cleared on a connection change, on any policy change and on map deletion. The entry for a tab is replaced by each observed read, navigate or click that changes its path.

  A click target resolves to a control as follows:
  - `eN` ref: the cached snapshot's `refs`.
  - `{role, name, nth?}`: directly.
  - `text=Name`: the single cached eligible control with that name.
  - CSS selector or coordinates: not attributable.

  A successful click is attributed only when `siteContext.fromUrl` has the cached origin and path.

  A **use** is an attributed click on a control that already has an entry, or a navigate whose requested path is an existing page entry, with or without a prior lookup.

  **Amendment after the T036 review (2026-10-28)** (RV-16): a navigate to `/` is not a use. Its open result is still recorded, but it counts toward no counter and sets no `lastUse`. Any agent can open the root from the origin alone.
- **Rationale**: The snapshot's `refs` give role and name without storing text, and `fromUrl` stops stale cache attribution for successes.

## R-08 Use outcome (AC-19, AC-29, AC-31; CHK022, CHK027, CHK030)

- **Decision**:

  | Event | Outcome | Recorded |
  |---|---|---|
  | Attributed click navigates to the expected destination path, or the expected destination is a menu or dialog and the tab stays | worked | use count +1, last use `worked` |
  | Attributed click navigates to a different same-origin path or another origin | failed | last use `failed (mismatch)`; the new destination replaces the old one for that read context (AC-20) |
  | Click by `{role, name}`, `text=` or a ref that fails with `NOT_FOUND`, `AMBIGUOUS`, `ELEMENT_HIDDEN`, `ELEMENT_DISABLED`, `ELEMENT_COVERED`, `REF_GONE`, `REF_NOT_FOUND` or `CLICK_MISSED` | failed | last use `failed (<code>)`; attributed through the tab cache alone (≤ 120 s old, same connection), because errors carry no `siteContext` |
  | Click without a known expected destination, or with `INPUT_BLOCKED`, a dialog, a download or a timeout | undecided | the destination is learned when there is one; no use counted |
  | Navigate to a remembered path; final path equal, status < 400 | worked | use count +1, page refreshed |
  | Final URL on the same origin, different path | failed | last open `elsewhere` + masked path; the landing page gets an entry (AC-19, AC-30) |
  | Final URL on another origin | failed | last open `other_origin` + that origin only |
  | Landing page has a visible password field, or status 401/403 | **not** failed | last open `sign_in` (+ path or origin); rank unchanged |
  | Status 404 or 410 | failed | last open `not_found` |
  | Status 5xx, 429 or another 4xx | not failed | last open `error` + status class; rank unchanged |
  | `NAVIGATION_FAILED` or a cancelled step | — | nothing (FR-002) |

  A failed use never marks an entry not seen (FR-010). A locator that matches a same-named control in another page area is judged only by its destination (CHK030).
- **Rationale**:
  - **CHK022.** AC-19 asks lookups to show a sign-in landing, and AC-31 lowers the rank of mismatches. A page behind sign-in is still valid, so a sign-in landing is shown but not ranked lower. This is how the two criteria are read together; the owner may decide otherwise at gate 1.
  - **CHK027.** Temporary errors must not demote a page.
- **Error attribution limit**: Errors carry no `siteContext`, so the cache could be stale after a manual navigation in that tab. The impact is bounded to a rank change of an entry with that exact role and name; nothing is deleted or marked not seen. A later change can attach `fromUrl` to click errors if tests show misattribution.

## R-09 Read context (CHK011, CHK037)

- **Decision**:
  - A read's context is the `siteContext.anonymous` of that navigate or snapshot: `true` is `public`, `false` is `not_public` and `null` is `unknown`. Output labels are "verified public", "not verified public" and "unknown"; no output says signed in or signed out (AC-28).
  - A destination learned from a click is stored under the read context of the cached read of the page the control was on. This resolves CHK011: a sign-in page reached while signed out is stored in the signed-out context, so it never replaces the signed-in destination (AC-20).
  - An allowlist change that flips a site's verdict does not rewrite stored contexts. New reads fill the new context, and marking compares only within one context, so nothing is falsely marked not seen.

## R-10 Snapshot parsing, page areas and completeness (CHK009, CHK010)

- **Decision**: A new parser `memory/map-snapshot.ts` with its own line grammar. It handles unnamed landmarks, refs and flags. It reads only role, name, depth and the `expanded`/`collapsed` flags, and it never reads `value="…"` or `context="…"`.
  - **Area** comes from the nearest landmark ancestor (by indentation):

    | Landmark | Area |
    |---|---|
    | `banner` | `header` |
    | `navigation` | `nav` |
    | `complementary` | `sidebar` |
    | `contentinfo` | `footer` |
    | `main` | `main` |
    | `dialog`, `alertdialog` | `dialog` |
    | `menu` | `menu` (a popup; recorded only when opened by an attributed click) |
    | `menubar` | `nav` (a persistent navigation bar) |
    | `search` | `nav` |
    | No landmark | `page` (treated like `main`) |

  - **Content area** (CHK009): inside `main` or `page`, a subtree rooted at `article`, `feed`, `table`, `grid`, `treegrid`, `row`, `rowgroup`, `cell`, `gridcell`, `listitem`, `log`, `comment` or `document`. Nothing in it is recorded, and a page reached only from it is not recorded. A main-area button is in the content area exactly when one of those roles is its ancestor; otherwise it is a main-area button. Lists inside `nav`, `header`, `sidebar` and `footer` are navigation, not content.
  - **Eligible roles**:
    - In `header`, `nav`, `sidebar` and `footer`: `link`, `button`, `tab`, `menuitem`.
    - In `main` and `page`: `button`, `tab`, `menuitem`.
    - In a `dialog` or `menu` opened by an attributed click: `link`, `button`, `tab`, `menuitem`, recorded with that click's control as their parent (AC-08).
    - Inputs are never recorded.
  - **Names**:
    - A control with no name is skipped.
    - Names are masked (R-12). A name that contains a placeholder after masking, or is longer than 80 characters, is skipped: the ready locator could not match it, and it probably carries data.
    - When several eligible lines share a role and normalized name, they are stored once, with `nth` from a complete read (R-11).
  - **Complete read**: a `browser_snapshot` with no `query` or `target` and `truncated: false`, or `browser_navigate {snapshot:true}` whose text has no truncation marker.
- **CHK010**: The spec forbids marking from truncated reads (FR-010), and this plan keeps that. Pages longer than the default 8,000-character snapshot will seldom give a complete read, so not-seen marks on them will be rare. Two mitigations:
  - Lookup and reminder text tells the agent that a complete read (`browser_snapshot` with a larger `maxChars`) updates the map.
  - Clicks with `expect` already take 50,000-character snapshots.

  Per-landmark completeness for truncated reads would need a spec change. It is offered to the owner as an optional amendment, not planned.
- **Amendment after the T036 review (2026-10-28)** (RV-01, RV-03, RV-13):
  - A content role anywhere on a line's ancestor stack makes the line content, in every area, not only in `main` and `page`. So a `table` in a sidebar or an `article` in a dialog stays out of the map. A `listitem` is exempt only in `header`, `nav`, `sidebar` and `footer`.
  - The extension follows HTML-AAM: a `<header>` or `<footer>` inside `article`, `aside`, `main`, `nav` or `section` is `generic`, not `banner` or `contentinfo`. `<article>` maps to `article`. `PAGE_DOM_VERSION` is 18. `browser_text` article mode now keeps a header inside an article.
  - A name of 80 or more characters is skipped, because the snapshot may have cut it.

## R-11 Structural pages and ready locators (AC-01, AC-09, AC-14, AC-27; CHK005, CHK030)

- **Decision**: A page entry is created when an observed in-scope read or navigate lands on one of these:
  - The origin root `/`.
  - A path that is the recorded destination of the attributed click that just happened in that tab.
  - A page from which an eligible control was just used (hub). The entry is created from the cached read when the click is attributed.
  - The same-origin landing page of a direct open of a remembered page.

  Any read of a path that already has an entry refreshes it (AC-01). Reads of other pages only update the tab cache, so 100 articles opened by address and read leave no entries (AC-27). Controls are stored only for pages that have entries. A path with a placeholder is stored without its title (FR-003).

  - **Ready locator**: `{role, name}`, plus `nth` when the last complete read had more than one eligible line with that role and normalized name. `nth` is their order in the snapshot, which `byRole` also uses, since both skip hidden nodes.
  - **Expected destination**: `{path}` (same origin, masked), `{origin}` (other origin) or `{opens: "menu" | "dialog"}`. An `opens` destination is recorded when an attributed click does not navigate and the next read of the same path in that tab shows the clicked control `expanded`, or a new `dialog` or `menu` subtree (CHK005).
  - Lookup output shows the locator as `browser_click` arguments, plus the expected destination for `expect.urlIncludes` when it is a path. The agent then finds, uses and checks the control in one step (AC-09, SC-003).
- **Amendment after the T036 review (2026-10-28)** (RV-05, RV-07, RV-09, RV-11, RV-14):
  - A `dialog` or `menu` counts as opened by the click only when it was not in the read before the click (its control keys and the container count are cached). A cookie dialog that was already open is not credited to the clicked control.
  - A `destination` page entry needs the same origin as the page the click left. A page on another origin gets no entry.
  - `expect.urlIncludes` is offered only for a path with no placeholder.
  - A failed use or open lowers a page's status only while it is newer than the page's last-seen time, so a page seen again is current again.
  - A lookup word that matches the name of a control leading to a page also returns that page.

## R-12 Masking (FR-004; CHK017, CHK031)

- **Decision**: Rules are applied in this order to paths, titles and names. They are listed in `contracts/map-allowlist.json` and mirrored in code with a parity test.
  1. Email addresses become `{email}`.
  2. Phone numbers become `{phone}`: an optional `+`, then at least 7 digits with spaces, dots, dashes or brackets between them.
  3. Long identifiers become `{id}`:
     - A UUID.
     - A run of at least 12 hexadecimal characters with at least one digit.
     - A word or path segment of at least 16 characters from `[A-Za-z0-9_-]`, with at least one letter and one digit.
     - A pattern for letter-only runs is deliberately absent: it would mask ordinary slugs such as `/terms-and-conditions-of-use`.
  4. Runs of 4 or more digits become `{n}`.

  Then lengths are bounded: names to 80 characters (longer ones are skipped, R-10), titles to 120 (truncated with `…`) and masked paths to 200 (a longer path is not recorded). Query, fragment and userinfo are never read into the map.
- **CHK031**: A year such as `2026` in a title is masked. In a path it makes the page not directly addressable. In a control name it drops the control. The loss is accepted: the alternative of keeping digits could store account or order numbers.
- **Amendment after the T036 review (2026-10-28)** (RV-02): the phone and digit-run rules match every decimal digit (`\p{Nd}`), including Arabic-Indic and full-width digits, not only ASCII `0-9`.

## R-13 Path-prefix exclusion (AC-34; CHK014)

- **Decision**: A prefix is a path that starts with `/`, is not `/` itself (use the site exclusion for that), has no query or fragment, and is stored without a trailing slash.
  - A path is excluded when, ignoring case, it equals the prefix or starts with the prefix followed by `/`. So `/health` excludes `/health` and `/health/x`, but not `/healthy`.
  - The test is applied to the raw path before masking and to the masked path. Either match excludes, and over-exclusion is the safe direction.
  - An excluded path gets no page entry, appears in no `via`, and is never stored as a destination. Such a destination is stored as `{excluded: true}` with no path.
  - Excluding writes a tombstone and deletes matching entries in every profile.
  - At most 32 prefixes per origin.
- **Amendment after the T036 review (2026-10-28)** (RV-04): paths and prefixes are compared percent-decoded and in NFC (`readablePath`), so an Arabic prefix typed by the owner matches the browser's encoded path.

## R-14 Matching normalization (FR-007, FR-015; CHK016)

- **Decision**: `normalizeForMatch` in `memory/map-text.ts` applies these steps in order:
  1. NFKC, then lowercase.
  2. Remove Arabic tashkeel (U+064B–U+065F, U+0670) and tatweel (U+0640).
  3. Map `أ إ آ ٱ` to `ا`, `ة` to `ه`, `ى` to `ي`, `ؤ` to `و` and `ئ` to `ي`.
  4. Collapse whitespace and strip trailing `.:…`.

  It is used for lookup words, control identity and vocabulary matching. 003's `normalizeText` is unchanged, so 003 fact identities do not shift.

## R-15 Data-changing vocabulary (FR-015, AC-32; CHK013)

- **Decision**: `contracts/map-allowlist.json` `dataChanging` lists English and Arabic phrases, including common verb forms (imperative, verbal noun, first-person present). The owner reviews it at gate 3.
  - **Matching**: the normalized name is split into words. A phrase matches when its words appear consecutively in the name. A name word matches a phrase word when the two are equal, or when they are equal after one leading proclitic is removed from the name word with at least 2 letters left. The proclitics are `و ف ب ل ك`, the article `ال`, and `وال، بال، فال، كال، لل`. Phrase words are never stripped, so `الغاء` still matches `الغاء`, and `والغاء` matches it too.
  - Known false friends are listed under `notDataChanging`; for example `حول` ("about") is not a form of `حوّل` ("transfer").
  - **Amendment after the T036 review (2026-10-28)** (RV-18): `notDataChanging` holds false friends only. Names such as "Remove filter" and "Clear search" really use a listed verb, so they stay matched; the spec's Edge Cases accept that over-match.
  - A match keeps the control out of reminders and adds the confirm-with-user notice in lookups. Over-matching loses only a reminder line. A missed match changes nothing about the agent's normal confirmation rules.

## R-16 Lookup tool `browser_site_map` (FR-007, AC-02, AC-05, AC-33; CHK015, CHK026, CHK029, CHK033, CHK040)

- **Decision**: A new read-only, daemon-owned MCP tool `browser_site_map`. Input: `{tabId}` or `{origin}` (exactly one), plus optional `query` (≤ 100 characters) and `cursor`.
  - **With `tabId`**, the origin and profile come from the tab, through 003's context action and scope decision.
  - **With `origin`** (CHK040), the profile comes from `connection(sessionId)`. It requires a `browserId` that is not `default`, a connection that is not `ambiguous`, `supportsSiteContext`, and `vault.memoryEligibility(browserId)` equal to `clear`. Otherwise the lookup fails with `MEMORY_SCOPE_UNKNOWN` and a reason.
  - **Naming** (CHK015):
    - An `http(s)` origin is used as given.
    - A bare host such as `example.com` tries `https://<host>`, then the `www.` form, or the host without `www.` when it had one. The first one with a map answers, and the result names the origin used.
    - `http` is used only when given explicitly.
  - **Ranking**: entries come in two groups.
    - Working entries come first: not marked not seen in the context of their latest complete read, and whose last use or open did not fail.
    - Then the others.

    Within each group: use count (descending), then max(last seen, last used) (descending), then path.
  - **Outline**: without `query`, at most 10 pages, one line each, at most 100 characters per line (CHK008): `N. <path or (not addressable)> "<title>" · <working | not seen | last open: …> · seen <date> · used <n>`.
  - **Bounds**: at most 20 entries and 4,000 characters per page. `cursor` is an offset `p<n>`, as in 003.
  - **No map yet** (CHK029): success with `pages: 0` and the line `no map entries for this site; browser_memory shows its website-memory facts`.
  - **Errors**: `MEMORY_DISABLED`, `MAP_DISABLED`, `MEMORY_EXCLUDED`, `MEMORY_SCOPE_UNKNOWN`, `MAP_UNAVAILABLE` and `INVALID_ARGUMENT`.
  - **Latency** (CHK026): the 50 ms p95 target covers a tab lookup, a named-origin lookup and the outline alike.
- **Threat model** (CHK033): A hostile page can tell the agent to look up another site's map and repeat it.
  - The map holds only masked structure that the same agent could read live from that site in the same profile. A paired client already has that power (`AGENTS.md`: pairing grants trusted clients unsandboxed browser control). The lookup does not raise what an agent can reach.
  - Agents cannot list origins. A lookup needs the exact origin, and output is labeled as untrusted site data.
  - **Residual risk**: a hit or miss reveals whether agents used that site in this profile. This is documented in `SECURITY.md` and in the enable prompt's details link.
- **Alternative considered**: A tab-bound lookup only, as 003 chose for `browser_memory`. FR-007 and AC-05 require lookups before the visit, which is the point of the feature.

## R-17 Navigation reminder and batch notes (FR-008, AC-26; CHK007, CHK020)

- **Decision**: After 003's reminder lines, the map adds a block of at most 4 lines and 600 characters.
  - It lists the navigated page's working controls that are not data-changing and not already among 003's shared facts. Control facts are compared by role and normalized name.
  - It ends with `map: <N> known pages for this site (untrusted hints) — browser_site_map`.
  - The bound is separate from 003's: total memory text stays at most 1,200 characters (CHK020).
  - The map read runs in parallel with 003's site read inside the same 50 ms reminder timeout. On timeout or error the block is one line, `map: unavailable (<CODE>)`.
  - The lines join the same `memory` array, so batch notes carry them with no change to `batch.ts` (CHK007).

## R-18 Reconciliation (FR-010, FR-011; CHK019, CHK028)

- **Decision**:
  - **Identity**: a page by its masked path; a control by (page, area, role, normalized name).
  - **Re-observation** refreshes an entry and never duplicates it.
  - **Complete reads** in context C mark each eligible control of that page as seen or not seen for C. Only controls whose last-seen language equals the read's `lang` are compared (CHK028), so an Arabic view does not mark English names not seen.
  - **Destinations** are replaced per read context.
  - **Direct opens** record only the open result; they do not refresh last seen.
  - Nothing expires with time.
  - **Eviction** removes the page with the oldest max(last seen, last used) first, together with its controls. Then come controls with the oldest max(last seen, last used) on pages over 60.
- **CHK019**: Using an entry counts as recent, so a heavily used page survives while it is still used. Historical use alone does not pin a page forever, which is intended.

## R-19 Counters and the savings estimate (FR-016, AC-35, SC-010; CHK025, CHK036)

- **Decision**: `memory/map-counters.json` keeps, per profile:
  - Exact counts: `lookups` (every `browser_site_map` call that passes scope), `usesWorked` and `usesFailed` (decided outcomes from R-08).
  - Labeled estimates: `loadsSavedEstimate` and `charsSavedEstimate`.
  - `since`.

  The estimates are computed this way:
  - A worked direct open of a page whose `via` chain has k hops from the root or the first page without `via` (k capped at 5) saves k page loads. It also saves the sum of the stored `readChars` of the k pages before it: the reads the agent would have made on the way.
  - A worked control use saves 0 loads and the page's `readChars` (one verifying read avoided).

  The counters hold no addresses, titles, names or origins. They are reset by map delete-all for the profile and by 003 `delete --all`.
- **CHK036**: Use counts and last-use results are behavior data. They live in the per-(profile, origin) map file, so they share its profile isolation, export and deletion.

## R-20 Owner controls (FR-006, AC-16, AC-17, AC-34; CHK004, CHK018, CHK023)

- **Decision**:
  - **Agent requests.** `browser_memory_policy` gets new actions, scoped to the session's verified profile, and an optional `path` argument:
    - `map_enable`, `map_disable`
    - `map_exclude_path`, `map_include_path` (tab origin + `path`)
    - `map_inspect`, `map_export` (tab origin, or every map of the profile)
    - `map_delete`: the page with `path`, the site with only `tabId`, or all of the profile's maps with neither.

    A new module `memory/map-policy-route.ts` handles `map_*` so that `policy-tool-route.ts` stays small. The action list moves to one exported constant, and the three copies become imports. A parity test covers any copy that cannot import it.
  - **Confirmation prompts** state the exact change: the action, the canonical origin, the path when given and the profile label (CHK023). The `map_enable` prompt also says: "The map records the addresses of pages agents visit in this browser profile, including signed-in pages." The daemon's preview answer carries the profile `browserId` and label. The confirmed call carries `confirmedPath` and `confirmedProfile`, as it carries `confirmedOrigin`, so a request whose tab, path or session profile changed while the owner decided changes nothing.
  - **Owner CLI**: `npm run memory -- map <status|enable|disable|exclude-path|include-path|inspect|export|delete>` over the existing `memory-admin` IPC kind, with a `map` sub-command field. `--browser <id>` selects the profile, and `map delete --all` covers every profile.
  - **Owner identification of a page entry** (CHK018): origin plus masked path, exactly as `inspect` prints it.
  - **Export** (CHK004): the full map files (pages, controls, per-context states, destinations, use counts, last-use and last-open results) and the profile's counters, as JSON.
- **Amendment after the T036 review (2026-10-28)** (RV-08, RV-15, RV-18):
  - A page delete removes exactly that page entry and its controls, not the pages under it, as FR-006 says. It writes a `{profile, origin, path}` tombstone. The root `/` can be deleted. An owner who wants a whole section gone uses `exclude-path`.
  - The JSON export is the owner CLI's. An agent's confirmed `map_export` gets the same bounded outline as `map_inspect`, as 003's `export` does.
  - The agent's `path` is the only agent-supplied text in an owner prompt, after canonicalization and the prompt filter.

## R-21 Failure isolation, recovery and diagnostics (FR-012, AC-23; CHK006, CHK034)

- **Decision**:
  - Map errors are caught in `MapService`. The browser result is never changed, apart from the reminder line `map: unavailable (<CODE>)`.
  - A corrupt map file is quarantined and treated as empty. Status shows the code and the count of quarantined files. A lookup for that origin answers `MAP_UNAVAILABLE` once, then works on the new empty file.
  - A corrupt `map-policy.json` turns the map off. Only `map disable` and `map delete --all` set it aside, as 003 does for `policy.json`.
  - Diagnostics, status and logs carry codes and counts only, never paths, titles, names or origins (SC-004).
  - Each operation identity is applied at most once (R-03).

## R-22 Retention (CHK035)

- **Decision**: No time-based expiry, as AC-22 and FR-010 require.
  - **Rationale**: a hint is useful exactly when the agent returns after a long gap, and the data is bounded by LRU and owner controls.
  - Status shows each profile's oldest entry date (a date only). The owner can then delete.
  - An owner-set maximum age would need a spec change and is listed as a possible amendment.

## R-23 Measurement (SC-002, SC-005; CHK024, CHK026)

- **Decision**: A new in-process script, `scripts/map-bench.mjs`, built on the dist modules. It measures capture enqueue and commit p95 with the map off and on, and lookup p95 (tab, named origin, outline) on a map file at its limits. `scripts/memory-bench.mjs` is left unchanged.
  - **SC-002 baseline route**: the synthetic site `scripts/pages/map/`, with a target 3 clicks from the root, run 20 times per mode.
    - Without the map: navigate to the root, then 3 attributed clicks, for 4 page loads.
    - With the map: one lookup and one navigate, for 1 page load.
    - Page loads are counted from main-frame navigations in the fake extension.
  - The baseline runs on Node 22 (installed). Node 20 is reported as not run until it is available.
  - **Observation outside scope**: the bench's batch sample sends `steps` over raw IPC (`memory-bench.mjs:375`), while the real batch takes `actions` in the MCP process. It probably never measured a real batch. This is noted for the owner; 004 does not change it.
- **Amendment after the T036 review (2026-10-28)** (RV-17): the SC-002 route is measured in-process in `scripts/map-bench.mjs`, with links in a `navigation` landmark, not with the fake extension against `scripts/pages/map/`. It counts page loads in the bench's own model. SC-002, SC-003 and SC-005 therefore have no end-to-end evidence until a fake-extension or real-Chrome run exists.

## R-24 Module sizes and wiring

- **Decision**:
  - `daemon.ts` gets no edits: routing goes through `isMemoryTool` and the existing `MemoryService` hooks.
  - `MemoryService` changes:
    - `beginCall` observes `browser_click` when the map is effective.
    - `afterCall` passes outcomes with or without an observation to `MapService.afterCall`. Only `browser_click` errors are used without an observation.
    - `withReminder` merges the map block.
    - `handleTool` routes `browser_site_map`.

    These add about 40 lines to `service.ts` (450).
  - `bridge-frames.ts` (71) gets the click in `OBSERVABLE_TOOLS`. `router.js` (496) gets one set entry and the light flag. `site-context.js` (273) gets about 30 lines for the light block.
  - The new modules (`map-service`, `map-snapshot`, `map-text`, `map-record`, `map-store`, `map-queue`, `map-reconcile`, `map-output`, `map-policy`, `map-policy-route`, `map-allowlist`) each stay under 400 lines.
  - Registry: 21 → 22 tools. Update `allTools`, the registry test list, the daemon-owned tool lists in `tests/extension-router.test.ts`, and the result-field allowlist in `vault/redaction.ts`. `wire-tools.ts` is unchanged: the lookup reuses `browser_memory_internal_context`.
- **Amendment after the T036 review (2026-10-28)** (RV-17), accepted deviations:
  - `daemon.ts` has one changed line (still 595 lines), so a failed click's error code reaches `afterCall`. That is the minimum R-08 needs.
  - The `tools/list` size budget is 20,000 bytes, up from 19,000, for the added tool and the `map_*` actions.
  - `map-queue.ts` (514), `map-store.ts` (527) and `map-reconcile.ts` (431) exceed the 400-line goal. They stay under the repository cap of 600.
  - `agent-config/` still lists 17 tools, which was stale before 004. Fix it at release.

## Checklist resolution map

| Item | Resolved by |
|---|---|
| CHK001 retention on disable | R-05 |
| CHK002 003 delete vs map | R-05 |
| CHK003 total bound | R-02 |
| CHK004 export contents | R-20 |
| CHK005 menu/dialog destination | R-11 |
| CHK006 corrupt storage | R-21 |
| CHK007 batch reminder | R-17 |
| CHK008 outline line | R-16 |
| CHK009 content vs main area | R-10 |
| CHK010 truncated reads | R-10 (spec kept; optional amendment) |
| CHK011 destination context | R-09 |
| CHK012 use definition | R-07 |
| CHK013 vocabulary matching | R-15 |
| CHK014 prefix matching | R-13 |
| CHK015 origin naming | R-16 |
| CHK016 Arabic normalization | R-14 |
| CHK017 token criteria | R-12 |
| CHK018 page entry identification | R-20 |
| CHK019 eviction vs ranking | R-18 |
| CHK020 reminder bound | R-17 |
| CHK021 map never acts | R-11: the map returns arguments; the agent's `browser_click` acts |
| CHK022 sign-in landing rank | R-08 (owner may change at gate 1) |
| CHK023 prompt specificity | R-20 |
| CHK024 SC-002 baseline | R-23 |
| CHK025 estimate method | R-19 |
| CHK026 lookup latency | R-16 |
| CHK027 other errors | R-08 |
| CHK028 language variants | R-18 |
| CHK029 no map entries | R-16 |
| CHK030 locator in another area | R-08, R-11 |
| CHK031 masking false positives | R-12 |
| CHK032 several accounts | Accepted as stated in the spec Assumptions (owner decision 1) |
| CHK033 named-origin threat model | R-16 |
| CHK034 diagnostics | R-21 |
| CHK035 retention rationale | R-22 |
| CHK036 behavior data | R-19 |
| CHK037 verdict dependency | R-09 |
| CHK038 owner decisions | plan.md gate 1 |
| CHK039 constitution artifacts | plan.md Constitution Check |
| CHK040 tab-less profile | R-16 |

The checklist items stay unchecked: this table proposes answers, and the reviewer marks each item.
