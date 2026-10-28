# Independent review: 004 site navigation map

- **Date**: 2026-10-28
- **Reviewer**: independent agent
- **Scope**: the uncommitted 004 work on `main` at `92012c4`. That covers the spec artifacts (`spec.md`, `plan.md`, `research.md` R-01–R-24, `data-model.md`, `contracts/`, `tasks.md`), the new modules `mcp-server/src/memory/map-*.ts`, `policy-actions.ts`, `record-files.ts` and `tools/site-map.ts`, and the 004 parts of the modified files (`service.ts`, `admin.ts`, `policy-tool-route.ts`, `tool-route.ts`, `tools/memory-policy.ts`, `daemon.ts`, `daemon-config.ts`, `bridge-frames.ts`, `protocol.ts`, `vault/*.ts`, `tools/batch*.ts`, `tools/registry.ts`, `extension/dispatch/router.js`, `extension/lib/site-context.js`, `extension/lib/protocol.js`). It also covers the `tests/map-*.test.ts` suites, the README, SECURITY.md and CHANGELOG additions, and the implementer's own notes. The 003 allowlist v2 changes were not reviewed.
- **tools used**: Read; Bash (`git diff`/`git status`, `npx vitest run` for the full suite and a probe file, `npm run typecheck`, `npm run lint`); codebase-memory-mcp `trace_path` (`parseMapSnapshot`, `mapVerdict` inbound); `graphify affected` (`sanitizeRecord`, `buildMapLookup`). One throwaway probe file, `tests/zz-review-probes.test.ts` (12 probes, P1–P12, all passed and so reproduced the findings), was run and then deleted.
- **Checks run**: full suite: 149 files and 2,255 tests passed. `npm run typecheck`: exit 0. `npm run lint`: exit 0. Not run: `security:audit`, `smoke:real-chrome` and the bench.

Severity scale: blocker, high, medium, low, note. CONFIRMED means reproduced by a probe or traced end to end in source. PLAUSIBLE means read in code but not exercised.

## Findings

### High

**RV-01 — Content-area text escapes when a landmark sits inside a content container, or inside an opened dialog, menu or sidebar** · CONFIRMED (P1, P1b, P2)

- `file:line`: `mcp-server/src/memory/map-snapshot.ts:122-139` (`inContent` is computed only when the nearest landmark maps to `main` or `page`). It is made worse by `extension/lib/page-dom.js:284`, which maps every `<header>` to `banner` and every `<footer>` to `contentinfo`, with no HTML-AAM scoping to `article`, `section` or `aside`.
- **Spec**: FR-003 and AC-14 ("no text from that content… Only the controls described in AC-06 and AC-08 are considered"), R-10 and SC-004. The SECURITY.md "Structure only" bullet also claims that content-area controls are never stored.
- **Failure scenario 1**: a blog root `/` has `main > article > banner > link "My cancer diagnosis story"`. This is the common WordPress shape `<article><header><h2><a>`. The innermost landmark is `banner`, so the control is stored as `header link "My cancer diagnosis story"`. The same applies to `main > list > listitem > contentinfo > link "Reply to Ahmed Hassan"` (P1). End to end, the name is in the stored root page (P1b). Clicking it would also create a page entry for the post.
- **Failure scenario 2**: the header button "Notifications" is clicked without navigating, and the next read shows `dialog > feed > article > link "Ahmed Hassan commented on your photo"`. That link is stored as `dialog:Ahmed Hassan commented on your photo` under the opener (P2). AC-14 names notifications explicitly. The same gap applies to `feed`, `article`, `table` and `row` subtrees inside `complementary` (sidebar).
- **Fix**: treat a content-container ancestor anywhere on the stack as content, whatever the nearest landmark is: test `stack.some(CONTENT)`, not just the part below a `main`/`page` landmark. Keep R-10's rule that plain lists in nav, header, sidebar and footer count as navigation, but apply the full content-role set (`article`, `feed`, `table`, `grid`, `row`, `cell`, `log`, `comment`, `document`) in every area, including `dialog` and `menu`. Add the two fixtures above to `map-privacy.test.ts`.

**RV-02 — Arabic-Indic and full-width digits are never masked** · CONFIRMED (P3)

- `file:line`: `mcp-server/src/memory/map-allowlist.ts:44-48` (and `contracts/map-allowlist.json`). The `{phone}` and `{n}` patterns use `\d`, which matches only ASCII `0-9` even with the `u` flag. `maskText` (`map-text.ts:37`) does not apply NFKC before masking.
- **Spec**: FR-004, AC-15 and SC-004.
- **Failure scenario**: the title `طلب رقم ١٢٣٤٥٦٧٨` is stored unchanged. `boundName('اتصل ٠١٠٠١٢٣٤٥٦٧')` keeps a full mobile number. `Order １２３４５６７８` and a path of Arabic-Indic digits (`/orders/%D9%A1…`) are neither masked nor marked unaddressable (P3). The owner's sites are Egyptian, where Arabic-Indic numerals in titles and labels are common. The privacy fixture plants only ASCII markers, so the suite passes.
- **Fix**: use `\p{Nd}` in place of `\d` in the `{phone}`, `{n}` and hex-free `{id}` rules, or apply NFKC plus a fold of U+0660–0669 and U+06F0–06F9 before masking. Mirror the change in the JSON contract, then add Arabic-Indic and full-width markers to the `PLANTED` fixture.

### Medium

**RV-03 — Native `<article>`, `<section>`, `<tr>` and `<td>` print as `generic`, so main-area buttons inside them are stored** · PLAUSIBLE

- `file:line`: `extension/lib/page-dom.js:284` (the implicit role map has no `article`, `section`, `tr`, `td` or `th`, so they fall back to `generic`), read together with `map-snapshot.ts:40` (`CONTENT` holds ARIA role names only).
- **Spec**: AC-14, FR-003 and R-10 (CHK009).
- **Failure scenario**: a plain-HTML forum or blog list puts each post in a `<article>` with `<button>Reply to Ahmed</button>`. The snapshot prints `generic > button "Reply to Ahmed"` under `main`, so the button counts as a main-area control and is stored. Only ARIA-explicit roles, `<table>` and `<li>` are detected. I did not render a real DOM to confirm this.
- **Fix**: map `article` to `article`, and `tr`/`td`/`th` to `row`/`cell` in `roleOf`. That fixes the snapshot too. Alternatively, have the parser treat role-less `generic` wrappers as unknown and record only controls under a recognized landmark. Add an extension-side fixture.

**RV-04 — Path exclusions and page deletes with a non-ASCII prefix never match** · CONFIRMED (P4)

- `file:line`: `map-text.ts:52-66`. `maskPath` stores an unmasked path in raw percent-encoded form and a masked path in decoded form. `map-policy.ts:238-241` and `map-text.ts:132-136` compare the prefix with those strings as they are.
- **Spec**: AC-34, FR-006 and R-13.
- **Failure scenario**: the owner runs `npm run memory -- map exclude-path --origin … --path /صحة`, which the CLI validator `^\/[^?#]*$` accepts. The visited URL's pathname is `/%D8%B5%D8%AD%D8%A9/%D8%AA…`. `isPathExcluded` returns false (P4), so pages under the prefix keep being recorded, existing entries are not removed, and the command reports success. A page delete by its decoded path fails the same way. Arabic query words also never match Arabic path segments in lookups.
- **Fix**: canonicalize both sides. Percent-decode (when the decode is valid) and NFC-normalize the prefix and every path before `pathUnderPrefix`. Better still, store paths in one representation: always decoded and masked, with addressability kept separately. Add a test with an Arabic prefix.

**RV-05 — A cross-origin click destination gets a page entry, path included, in the other origin's map** · CONFIRMED (P5)

- `file:line`: `map-capture.ts:206` (`reason` becomes `destination` when the previous stub is `attributed` and the paths are equal, with no origin check), together with `:273` and `:320` (`leaveStub(true)` also runs when `after.origin !== entry.origin`).
- **Spec**: Edge Cases ("A sign-in flow goes through another origin…: only the destination origin is recorded, never its path"), AC-07 and FR-002.
- **Failure scenario**: header link "Sign in" on `https://shop.example/` leads to `https://accounts.idp.example/oauth/authorize?client=…`. The agent reads that page, and the IdP map now holds a page `/oauth/authorize` with `reason: destination` (P5). Any third-party origin reached through a click is recorded with its path the same way.
- **Fix**: set `attributed` only when `after.origin === entry.origin`, or require `previous.origin === page.origin` before choosing the `destination` reason.

**RV-06 — An owner exclusion or delete reports success while the entries stay, and every read path serves them** · CONFIRMED (P8)

- `file:line`: `map-admin.ts:80-83` (`sanitizeNow` enqueues, drains and ignores the outcome) and `map-admin.ts:113-114`. The read paths `map-service.ts:316-326` (`lookup`), `map-admin.ts:122-134` (`inspect`) and `:173` (`export`) never apply `sanitizeRecord`. graphify `affected sanitizeRecord` lists only `MapQueue.run`/`commit`. `knownMapProfiles` (`map-admin.ts:17-23`) knows only the profiles in the current policy.
- **Spec**: AC-16 ("exactly that action has taken effect. Deleted entries do not return") and AC-34 ("lookups never return them").
- **Failure scenario 1**: the map store's write fails (I/O error or a 2 s commit timeout). `map exclude-path … /profilev2.php` returns `success: true`, and `browser_site_map {origin, query:"profile"}` still lists `/profilev2.php` (P8). The reminder and `map_inspect` show it as well, until some later commit to that origin happens to succeed.
- **Failure scenario 2**: after a corrupt `map-policy.json` is reset (`map disable` with `resetCorrupt`), the other profiles' files are no longer in `profiles`. A 003 `delete <origin>` or `map delete --origin` then skips them, and they reappear when that profile re-enables the map.
- **Fix**: (a) apply `sanitizeRecord(record, sanitizePolicyFor(...))` on every read before output (lookup, reminder, inspect, export). This is cheap and pure. (b) Have `sanitizeNow` and `deleteMaps` check the commit outcome and return `MEMORY_UNAVAILABLE` on failure. (c) Have `knownMapProfiles` union the policy keys with the profiles of the stored records.

**RV-07 — A masked destination is offered as `expect.urlIncludes`, so a correct click always fails its expectation** · CONFIRMED (P12)

- `file:line`: `map-output.ts:151`, together with `tools/action-support.ts:318` (`after.url.includes(urlIncludes)`).
- **Spec**: AC-09, FR-009 and SC-003 ("reaches its expected destination in 100% of runs where the control is unchanged").
- **Failure scenario**: header link "My profile" leads to `/users/123456/profile`, stored as `/users/{n}/profile`. The lookup offers `browser_click {"target":{…},"expect":{"urlIncludes":"/users/{n}/profile"}}`. The real URL never contains `{n}`, so the agent's correct click returns `EXPECTATION_FAILED` (P12). Masked paths are also stored decoded, so `%`-encoded real URLs never match them either. Per the daemon's own judgement the click "worked", so the agent and the map disagree.
- **Fix**: emit `expect.urlIncludes` only for an unmasked, addressable destination path, or emit the longest placeholder-free prefix. The text can still show `→ /users/{n}/profile`.

**RV-08 — A page delete removes the whole subtree, while the owner prompt says "the site map entry"** · CONFIRMED (P11; recorded by the implementer)

- `file:line`: `map-admin.ts:111-114`, `map-reconcile.ts:406-407` (`pathUnderPrefix`) and `tools/memory-policy.ts:68` (prompt text).
- **Spec**: AC-16 ("for one page entry… exactly that action has taken effect"), FR-006 ("delete the map for one page entry (with its controls)") and AC-17 ("a prompt that states the exact change").
- **Failure scenario**: the owner confirms "Allow deleting the site map entry /profilev2.php of https://shop.example…?". `/profilev2.php/edit` and every other page under it are deleted too (P11). For a site with paths like `/account`, `/account/billing` and `/account/security`, one "entry" delete wipes the whole section. Trailing-slash pages (`/en/`) cannot be deleted alone, because the canonical prefix drops the slash. The root `/` cannot be deleted as an entry at all.
- **Judgement**: the data-model's choice that "an exact path is its own prefix" contradicts the spec's "exactly". Do not accept this as is.
- **Fix**: delete the exact masked path only, and use an exact-path tombstone (for example `{path}` next to `{pathPrefix}`). Keep subtree removal for `exclude-path`. If the owner prefers the subtree behavior, amend AC-16 and change the prompt to "…entry <path> and the pages under it…".

**RV-09 — A page whose last direct open failed never becomes current again when it is seen again** · CONFIRMED (P6)

- `file:line`: `map-reconcile.ts:363-367` (`pageStatus` reads only `lastUse` and `lastOpen`) and `:150-167` (`applyRead` clears neither).
- **Spec**: AC-29 ("The entry is not deleted; it is current again if the page is seen again") and FR-007 ranking.
- **Failure scenario**: `/profilev2.php` answers 404 once, and the agent later reaches and reads it through its link. `lastSeenAt` is refreshed, but `lastOpen` stays `not_found` and `pageStatus` stays `failed` (P6). The page is labeled `last_open_not_found` and ranked after working pages until a later direct open lands exactly on it.
- **Fix**: a read of the page newer than `lastOpen.at` (and newer than `lastUse.at`) restores working status. Either clear the failure or compare the times in `pageStatus`. Add the scenario to the AC-29 test.

### Low

**RV-10 — Reminder lines show no freshness** · CONFIRMED (P10)

- `file:line`: `map-output.ts:236-262`.
- **Spec**: FR-008 ("Every line MUST show its source and freshness") and the contract README's reminder format (`(seen 2026-10-27)`). SECURITY.md:87 also claims that "every entry shows when it was last seen".
- **Failure scenario**: the reminder reads `map: link "Help" → /profilev2.php · …` with no date (P10).
- **Fix**: add `seen <date>` per item (one date per line is enough within the 150-character line bound), or amend FR-008 and the SECURITY.md text.

**RV-11 — A lookup by the name of the control that leads to a page returns the source page, not the target page** · CONFIRMED (P9)

- `file:line`: `map-output.ts:206-212`.
- **Spec**: AC-02 ("…or the name of a control that leads to it, then the lookup returns the page with its address, the control and page that led to it").
- **Failure scenario**: the query `help` returns only `/` with `link "Help" → /profilev2.php`. The page entry `/profilev2.php` (its title, addressability, last-open result and `via`) is not returned (P9). The agent gets the path from `→` but not the target's status, for example `last open: sign_in`.
- **Fix**: also add a hit for each page whose `via.control`, or any control's destination path, matches the query words.

**RV-12 — `mapVerdict` ignores a newer 003 delete-all when the origin also has an older tombstone** · CONFIRMED (P7)

- `file:line`: `map-policy.ts:263` (`memory.deletions[origin] ?? memory.deletions['*']`).
- **Spec**: AC-16 and R-05. 003's own `policyVerdict` (`queue.ts:82-85`) checks both keys.
- **Failure scenario**: deletions are `{origin: 09:00, '*': 11:00}` and an op is stamped 10:00. `mapVerdict` returns `ok` (P7). Today `dropPending` and `settle` in `deleteMapsWithMemory` cover this, so it is a defense-in-depth gap, not a live leak.
- **Fix**: check both keys, as `sanitizePolicyFor` (`map-queue.ts:97-100`) already does.

**RV-13 — Names cut to 80 characters by the snapshot are stored, and their locator can never match** · CONFIRMED (code trace)

- `file:line`: `extension/handlers/inspection.js:382` (prints `nameOf(el).slice(0, 80)`), `page-dom.js:49`, `:478-487` (`byRole` compares the full name, up to 500 characters) and `map-text.ts:73` (`> 80` rejects only longer names).
- **Spec**: R-10 ("longer than 80 characters, is skipped") and AC-09.
- **Failure scenario**: a 120-character menu item is stored with its first 80 characters. Every use returns `NOT_FOUND` and is recorded as a failed use.
- **Fix**: skip names of length `>= MAP_LIMITS.nameChars`, because a printed name of exactly 80 characters may be truncated.

**RV-14 — Any dialog or menu already on the page is attributed to the control just clicked** · PLAUSIBLE

- `file:line`: `map-capture.ts:199-201` (`openedContainers > 0` counts every printed dialog or menu, and every opened-area control gets `parent = pending.controlKey`).
- **Spec**: AC-08 and R-11 (CHK005).
- **Failure scenario**: a persistent cookie-consent `dialog` is on the page. The agent clicks the header button "Language", which does not navigate. "Accept all" and "Reject" are then stored as children of "Language", and "Language" gets `opens: dialog`.
- **Fix**: count only containers that were not in the cached pre-click read, or require the clicked control to be `expanded`.

**RV-15 — `map_export` requested by an agent returns records that the agent never sees** · CONFIRMED (code trace)

- `file:line`: `map-policy-route.ts:149-152`, together with `tools/types.ts:181-189` (`outcomeOf` shows only `text`).
- **Spec**: FR-006 and AC-16 ("inspects, exports… by confirming an agent's request").
- **Failure scenario**: the owner confirms an agent's `map_export`, and the agent receives only "Site map of all sites for browser profile …". The records go nowhere.
- **Fix**: put a bounded JSON rendering in `text`, or answer as 003 does, with `map_export` returning the same outline text as `map_inspect`, and document that the full export is CLI-only.

### Notes

**RV-16 — The "hint use" counters count any navigate to a stored path, including the root** · CONFIRMED (code trace)

- `file:line`: `map-capture.ts:211-213` and `map-reconcile.ts:262-265`.
- **Spec**: FR-016, SC-010 and R-07.
- **Issue**: every agent visit to `/` (a page entry) counts `usesWorked + 1`, with or without a lookup. This follows R-07's definition, but SC-010's "equal the actual numbers of… hint uses" then measures navigation habits, not use of the map.
- **Suggestion**: count opens only after a lookup in the same session, or exclude `/`. Otherwise, relabel the counter in status.

**RV-17 — Verdicts on the implementer's recorded deviations**

- `daemon.ts:465` (one changed line, line count unchanged at 595) is the minimum needed for R-08 click-failure feedback. Only the code before `:` is parsed (`map-capture.ts:327`). Accept it, and amend R-24.
- The tools/list budget raised from 19,000 to 20,000 is proportionate to one added tool and the `map_*` enum. Accept it.
- Module sizes are `map-queue.ts` 514, `map-store.ts` 527 and `map-reconcile.ts` 425, against R-24's under-400 goal and the repo cap of 600. Accept them; the architecture test still passes. Amend R-24.
- `agent-config/AGENTS.md:18,39` still says 17 tools, and the real count is now 22. This was stale before 004, but 004 widens the gap. Fix it in the release.
- The bench is in-process (`scripts/map-bench.mjs`), not R-23's fake-extension run against `scripts/pages/map/`. SC-002 (page loads) and SC-003 (one-step use) therefore have no end-to-end evidence. Report both as not measured until a fake-extension or real-Chrome run exists.
- RV-08 covers the page-delete subtree behavior.

**RV-18 — Two smaller differences from the spec text**

- `notDataChanging` (`map-allowlist.ts:92`) exempts "Remove filter". The spec's Edge Cases expect such a control to be kept out of the reminder. This is harmless, but it differs from the spec. Decide which is intended at gate 3.
- The contract README:78 says that agent-supplied text never appears in owner prompts. The agent's `path` does appear, after `canonicalPrefix` and `promptSafe`. That is unavoidable, so reword the contract.

## Spec coverage (acceptance criteria)

| AC | Implementing code | Test | Status |
|---|---|---|---|
| AC-01 | `map-capture.ts` captureRead, `map-reconcile.ts` applyRead | map-service, map-reconcile | ok |
| AC-02 | `map-output.ts` buildMapLookup | map-output | partial (RV-11) |
| AC-03 | `map-output.ts` (the map returns arguments only) | map-service | ok |
| AC-04 | `map-capture.ts` addressable | map-output | ok |
| AC-05 | `map-service.ts` lookup | map-tool, map-service | ok |
| AC-06 | `map-snapshot.ts` | map-snapshot | partial (RV-01, RV-03, RV-13) |
| AC-07 | `map-capture.ts` captureClick, `map-reconcile.ts` applyClick | map-reconcile, map-service | partial (RV-05) |
| AC-08 | `map-capture.ts` pendingClick and openedBy | map-service, map-reconcile | partial (RV-14) |
| AC-09 | `map-output.ts` controlLine | map-output | partial (RV-07, RV-13) |
| AC-10 | `map-reconcile.ts` identity | map-reconcile | ok |
| AC-11 | `map-policy.ts` mapVerdict, `map-queue.ts` | map-policy, map-queue, map-service | ok |
| AC-12 | `map-store.ts` per-profile files | map-privacy, map-service | ok |
| AC-13 | `scope.ts` via `service.ts`, vault checks | map-privacy, map-service | ok |
| AC-14 | `map-snapshot.ts` | map-privacy, map-snapshot | **fails** (RV-01, RV-03) |
| AC-15 | `map-text.ts`, `map-allowlist.ts` | map-text, map-privacy | **fails** (RV-02) |
| AC-16 | `map-admin.ts` | map-admin, map-policy-tool | partial (RV-06, RV-08, RV-15) |
| AC-17 | `map-policy-route.ts`, `tools/memory-policy.ts` | map-policy-tool | partial (RV-08 prompt) |
| AC-18 | `map-reconcile.ts` | map-reconcile | ok |
| AC-19 | `map-capture.ts` openResult and landing | map-service, map-reconcile | ok |
| AC-20 | `map-reconcile.ts` destinations per context | map-reconcile | ok |
| AC-21 | `map-output.ts` (JSON-quoted names, label) | map-output | ok |
| AC-22 | `map-output.ts` seen dates | map-output | ok for lookups; reminder RV-10 |
| AC-23 | `map-service.ts` try/catch, unavailable line | map-service, map-queue | ok |
| AC-24 | `map-queue.ts` opId dedupe, single writer | map-queue | ok |
| AC-25 | `map-reconcile.ts` enforceMapLimits | map-reconcile | ok |
| AC-26 | `map-output.ts` buildMapReminder, `service.ts` withReminder | map-output, map-service | partial (RV-10) |
| AC-27 | `map-capture.ts` refresh reason | map-service | ok |
| AC-28 | `map-reconcile.ts` per-context seen | map-reconcile | ok |
| AC-29 | `map-reconcile.ts` applyOpen | map-service, map-reconcile | partial (RV-09) |
| AC-30 | capture, reconcile and output together | map-service | ok |
| AC-31 | applyClick, applyClickFailed, applyOpen | map-reconcile, map-service | ok |
| AC-32 | `map-text.ts` isDataChanging, output | map-text, map-output, map-service | ok |
| AC-33 | `map-output.ts` buildMapOutline | map-output | ok |
| AC-34 | `map-reconcile.ts` removePathPrefix, `map-policy.ts` isPathExcluded | map-admin, map-policy, map-reconcile, map-text | partial (RV-04, RV-06) |
| AC-35 | `map-store.ts` counters, `map-admin.ts` status and reset | map-admin | ok (see RV-16) |

Not covered end to end: SC-002, SC-003 and SC-005 (in-process bench only; RV-17).

Confirmed without findings:

- Profile isolation: files are keyed by `sha256(browserId)`, and `default` or ambiguous identities never store or answer.
- Incognito and vault-protected tabs never enter the cache or the map.
- The map modules do no network I/O (locality test).
- `map_*` changes need owner confirmation, with `confirmedProfile`, `confirmedOrigin` and `confirmedPath` re-checked, and prompts built from the daemon's preview values.
- The redaction allowlist entries preserve root key names only, and values are still scrubbed.
- 003 disable, exclude and delete stop and delete maps.
- Lookup bounds hold: 20 pages, 4,000 characters, and an outline of 10 lines and 1,000 characters.
- Map errors never change a browser result.
- Tool count is 22, `browser_batch` gives no default `tabId` to a step that names an origin, and routing goes through `isMemoryTool`.

## Verdict

**Not ready to merge.** RV-01 (content areas escape through nested landmarks and opened dialogs) and RV-02 (Arabic-Indic and full-width digits are not masked) each break AC-14 or AC-15, the core privacy promise of the feature, and SECURITY.md states the opposite. Fix both, together with RV-04 to RV-09, and add their fixtures to `map-privacy.test.ts` and `map-service.test.ts` before owner gate review. The rest of the design (profile boundary, policy gating, confirmation, failure isolation, bounds) is sound and well tested.

## Resolution (implementer, 2026-10-28)

Each finding was fixed with a regression test, or recorded as an accepted deviation or an owner decision. Every fix test was run red against the old behavior where that was practical: RV-01 (privacy fixture), RV-14 and the RV-06 write failure.

| Finding | Outcome | Change | Test |
|---|---|---|---|
| RV-01 | Fixed | `map-snapshot.ts`: a content role anywhere on the ancestor stack makes a line content, in every area; `listitem` is exempt only in header, nav, sidebar and footer. Extension `page-dom.js`: `<header>`/`<footer>` inside sectioning content is `generic` (HTML-AAM). | `map-snapshot.test.ts`; `map-privacy.test.ts` (post header inside an article, notifications feed inside a dialog); `page-dom.test.ts` |
| RV-02 | Fixed | `{phone}` and `{n}` match `\p{Nd}` in `map-allowlist.ts` and `contracts/map-allowlist.json`. | `map-text.test.ts`; `map-privacy.test.ts` (Arabic-Indic and full-width markers) |
| RV-03 | Fixed | `<article>` maps to `article`; `article` is label-only in `browser_snapshot` (`inspection.js`). `PAGE_DOM_VERSION` 17 → 18. | `page-dom.test.ts` |
| RV-04 | Fixed | `readablePath` and `samePath` in `map-text.ts`: prefixes, exclusions, deletes and lookups compare decoded NFC paths. | `map-text.test.ts`; `map-admin.test.ts` (Arabic prefix) |
| RV-05 | Fixed | `map-capture.ts`: a `destination` read needs the origin of the page the click left; a stub is attributed only for a same-origin click. | `map-service.test.ts` (`legal.example` gets no map) |
| RV-06 | Fixed | `MapService.applyPolicy` filters lookups, reminders, `inspect` and `export` through tombstones and exclusions. Page delete and `exclude-path` re-check the file after the drain and answer `MEMORY_UNAVAILABLE` if entries remain. `knownMapProfiles` includes profiles that have files. Tombstones are kept at least 7 days. | `map-admin.test.ts` (failed write); `map-policy.test.ts` (retention) |
| RV-07 | Fixed | `map-output.ts`: no `expect.urlIncludes` for a path with a placeholder. | `map-output.test.ts` |
| RV-08 | Fixed | A page delete is exact: `{profile, origin, path}` tombstone, `canonicalPagePath`, `/` allowed (zod, `daemon-config.ts`, `scripts/memory.mjs`). Docs, `data-model.md` and `map-store.schema.json` updated. | `map-admin.test.ts` (subpage kept, root delete); `map-policy.test.ts` |
| RV-09 | Fixed | `map-reconcile.ts` `pageStatus`: a failed use or open counts only while it is newer than the page's last-seen time. | `map-service.test.ts` (AC-29) |
| RV-10 | Fixed | Reminder items end with ` (seen YYYY-MM-DD)`. | `map-output.test.ts` |
| RV-11 | Fixed | `buildMapLookup` also matches a page by the names of controls that lead to it. | `map-output.test.ts` |
| RV-12 | Fixed | `mapVerdict` checks both 003 tombstones, the origin's and `*`. | `map-policy.test.ts` |
| RV-13 | Fixed | `boundName` skips names of 80 or more characters. | `map-text.test.ts` |
| RV-14 | Fixed | The tab cache keeps the dialog and menu control keys and container count of each read. A click is credited only with containers that are new since the read before it. | `map-service.test.ts` (cookie dialog already open) |
| RV-15 | Fixed | An agent's `map_export` returns the same bounded outline as `map_inspect` and names the owner CLI for the JSON export, as 003 does. | `map-policy-tool.test.ts` |
| RV-16 | Fixed (delegated decision) | `map-reconcile.ts` `applyOpen`: opening `/` records the open result but is not a hint use (no counter, no `lastUse`). R-07 amended; README defines a use. | `map-reconcile.test.ts`; `map-service.test.ts` (AC-31 counters) |
| RV-17 | Accepted, recorded | R-23 and R-24 amendments in `research.md` cover the `daemon.ts` line, the 20,000-byte `tools/list` budget, the module sizes and the in-process bench. `agent-config/AGENTS.md` and the Cursor rule now list 22 tools. SC-002, SC-003 and SC-005 are not measured end to end. | — |
| RV-18 | Fixed (delegated decision) | `contracts/README.md` now says the agent's canonical `path` is the only agent-supplied text in owner prompts. `notDataChanging` keeps false friends only (`حول` forms), so "Remove filter" stays matched, as the spec's Edge Cases say. R-15 amended. | `map-text.test.ts` |

Checks after the fixes: `npm test` (149 files, 2,266 tests), `npm run lint`, `npm run typecheck`, `npm run build`, `npm run test:coverage` and `npm run context:lint` all exited 0 on Node 22.23.1 and on Node 20.20.2. Node 20 was the official nodejs.org build, checked against its SHA-256 and run from a scratch folder. `npm run security:audit` found 0 vulnerabilities. `node scripts/map-bench.mjs --iterations 200 --routes 20 --write` rewrote `baseline.md`, and its numbers stay within noise of the first run. Not run: `smoke:real-chrome` (see plan.md, owner instruction after the review).

Updated verdict: all findings are fixed or recorded. The owner delegated the decisions on gate 4, RV-16 and RV-18, and plan.md records them so the owner can reverse any of them. The extension changes need an extension reload, and no real-Chrome run has checked them.

## Second review (session code review, 2026-10-28)

A second review ran on `git diff HEAD` (95 files). It found no critical issues. Its findings, checked against the source:

| Finding | Outcome | Change | Test |
|---|---|---|---|
| W1: a click that raises a JavaScript dialog or starts a download is scored as a decided use, against R-08 | Fixed | `map-capture.ts` `captureClick` sets `undecided` when the click result has `dialog` or `download`. Both fields survive the vault sanitizer, which keeps root keys and scrubs only values. | `map-service.test.ts` (fails without the fix) |
| W2: a counters read error makes the next commit write zeros over `map-counters.json` | Fixed | `map-queue.ts` `commitCounters` drops the deltas (`io_error`) and does not write when the read fails. `map-store.ts` `getCounters` treats a read error as `MEMORY_UNAVAILABLE` and quarantines only unparsable content, as map files already do. | `map-queue.test.ts`, `map-store.test.ts` (both fail without the fix) |
| W3: a corrupt `map-policy.json` is reported as the memory policy, which sends the owner to the wrong reset | Fixed | `map-service.ts` `lookup` reads the two policies apart. A corrupt map policy names `map disable` or `map delete --all`. | `map-service.test.ts` (fails without the fix) |
| S4: two synchronous policy reads on every observed call | Not changed | The measured call-path p95 is at most 1.7 ms with both reads (`baseline.md`). A parsed-policy cache would miss edits made outside the daemon. Revisit if a slow memory directory shows up in practice. | — |
| S5: a site-scoped `map_export` runs `inspect` | Not changed (comment added) | Admin `export` ignores `origin` and returns every site of the profile, so the suggested change would widen a site-scoped request to all sites. The agent gets the outline either way. | — |
| S6: `browser_site_map` arguments are validated three times | Not changed | `map-service.ts` `parseLookup` already requires exactly one of `tabId` and `origin`, so `{tabId, origin}` is refused on every path. | existing `memory-service.test.ts` (service path) and `map-tool.test.ts` (tool route) |

Checks after the fixes: `npm test` (149 files, 2,270 tests) on Node 22.23.1 and Node 20.20.2, plus `npm run lint`, `typecheck`, `build`, `test:coverage` and `context:lint` on Node 22, all exited 0.
