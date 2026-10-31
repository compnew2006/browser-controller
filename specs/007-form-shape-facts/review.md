# Review: spec 007 "form shape facts"

**Verdict: pass with findings**

The feature is implemented, tested and honest about its own limits. I traced the whole write path
(`extension/lib/site-context.js` -> `mcp-server/src/memory/facts.ts` -> `service.ts` -> `reconcile.ts` ->
`store.ts`) and the read path (`output.ts`), and I could not find a stored byte that carries page content: the
shape fact holds counts and closed-vocabulary words, the counter holds a single integer, and the commit mode
holds one word. The anonymity split the spec asks for (C6) is real and is asserted on both branches. Two defects
surfaced during the review — a bound that poisoned an origin's writes, and a residue that could do the same
through the verification map — and both were fixed in the working tree before this file was written; I verified
each fix by running the code, not by reading it. What remains are documentation and specification gaps, plus
one open question about the eviction rule that the spec never decided.

**Scope of this review**: the working tree at `0c0c2ce` plus the owner's unresolved upstream merge
(`mcp-server/src/memory/service.ts` is `UU` in the index; the working-tree resolution imports `isRecord` from
`./guards.js` and has no conflict markers). I read the files as they are on disk and did not touch the merge.
Baseline for comparison: `972de04`.

## Findings

| id | severity | requirement / checklist | file:line | what is wrong | evidence |
|---|---|---|---|---|---|
| F-01 | minor | FR-011, spec §Edge Cases ("a page that changes its form between two reads") | `mcp-server/src/memory/reconcile.ts:135-142` | A re-read of a path whose form changed replaces the value and keeps the fact's `firstObserved` only when the new observation is not older (`later(firstAt, current.lastObserved)`). The spec's edge case says "the newer shape replaces the older one, and the fact keeps its first observation time". The code keeps the *later* of the two, so the first observation time advances on a changed form. Not a privacy or data-loss defect; the value is always the freshest, and the bound is unaffected. | `reconcile.ts:138-141`; the same rule is 003's pre-existing "same identity, new value" branch, so this is inherited behaviour, not new drift. |
| F-02 | minor | FR-011, checklist CHK021 | `mcp-server/src/memory/service.ts:362-364` | The pending commit mode is taken only when a shape fact is about to be written. If the next observed read of that path is excluded, truncated or fails the anonymity gate, the mode stays pending in the tab cache and may be applied at a later read of the same path. The spec (CHK021) never says which of "dropped, held, applied" is right; the code chose "held", and `takeCommitMode` drops it after the 120 s attribution window (`tab-state.ts:124`). The behaviour is bounded and documented, but it is an owner decision the spec left open. | `service.ts:362-364`; `tab-state.ts:119-126`; `spec.md:166` (FR-011) names no rule. |
| F-03 | minor | FR-005 / CHK029 | `mcp-server/src/memory/output.ts:138` | The counter line reads "act on them with browser_evaluate", which is an instruction, while 003's rule (and the tool's own preamble) is that hints are never instructions. The spec's own checklist (CHK029) flags exactly this tension. The word "act" is directive rather than descriptive. | `output.ts:136-139`; the tool description at `mcp-server/src/tools/memory.ts:9` frames it as a hint. |
| F-04 | minor | FR-001 / D-05, D-07 | `extension/lib/site-context.js:118-127` | The probe measures the form with the most fillable fields inside `main` (D-07), and `main` is chosen as `document.querySelector('main, [role="main"]')` — the *first* match in document order, not the nearest landmark ancestor of the form (D-05's wording). With a nested landmark the measured form can differ from D-05's rule. No test covers two landmarks. | `site-context.js:118`; `research.md:134-136` (D-05, D-07). |
| F-05 | note | CHK036, R-09 | `extension/lib/site-context.js:58-60, 65-66, 133` | The shape's budget is derived from what is left of the probe's own budget (`min(250, 900 - 120 - elapsed)`), so a slow page loses the shape and not the verdict. But the deadline is only checked *inside* the per-field loop (`:133`); the collection traversal at `:121-127` (which queries every form in `main` and every control in each form) runs before any deadline check. On a page with a very large form the traversal itself can exceed the margin. The margin protects the common case, not the worst case. | `site-context.js:121-127` vs `:133`; the R-09 test at `tests/extension-site-context.test.ts` mocks `performance.now` so the *loop* overruns, not the traversal. |
| F-06 | note | FR-009, spec §Assumptions | `extension/lib/site-context.js:381-382` | The shape block is optional on the extension side (`...(probe?.formShape ? { formShape: probe.formShape } : {})`), and the daemon treats a missing block as "no shape", so an old extension works with no error. Verified. The probe still *runs* the shape measurement on every page even when the daemon will never store it under Option 1, costing up to 250 ms of probe budget for a fact that is usually gated away. | `site-context.js:178-184, 381-382`; `service.ts:357-359` (gate applied after the read). |
| F-07 | note | CHK028, SC-004 | `mcp-server/src/memory/admin.ts:85-86` | The export returns the raw stored records (`store.listSites()`), so the new facts appear in the export in the store's own shape. The spec asks for "the documented shape" and no document defines it; the CHANGELOG and README describe the facts but not an export schema. | `admin.ts:85-86`; `spec.md:181` (SC-004) refers to a shape no document fixes. |
| F-08 | note | FR-004 bound, docs | `README.md` (shape bullet), `CHANGELOG.md` (shape bullet) | The docs say "a site keeps at most eight of these shapes" and do not say which eight survive when a ninth path arrives. The implemented rule is "the freshest eight win; the oldest is replaced". That rule is a real product decision (it decides which page the agent can still read a shape for) and is documented in code (`reconcile.ts:102-106`) but not in the user-facing docs or the spec. | `reconcile.ts:101-123`; `spec.md:64` says only "At most 8 shape facts per site". |

### Fixed during this review (verified, no longer open)

| id | severity | requirement | file:line | what was wrong | evidence |
|---|---|---|---|---|---|
| X-01 | blocker | FR-004 (per-site bound) | `mcp-server/src/memory/reconcile.ts:101-123`, `mcp-server/src/memory/site-record.ts:243-248` | The 8-shape bound was enforced only by *refusing the record*. `validateSiteRecord` threw `MEMORY_FULL` on write, the store's `putSite` rejected the whole record, and the queue dropped the entire group for that origin — so an origin that reached nine form paths lost its visits and its other facts with it, permanently. The bound must cost one shape fact, not the record. | Before the fix, my own probe over 90 distinct allowlisted paths produced `MEMORY_FULL: a profile holds at most 64 verifications` and the record could not be written; after the fix the same probe yields 8 shapes, 8 verifications and a clean `validateSiteRecord(site, 'write')`. |
| X-02 | blocker | FR-004 (per-site bound) | `mcp-server/src/memory/reconcile.ts:114-121` | The eviction left the evicted fact's per-profile verification behind, so `verifications` grew one entry per distinct shape path while the facts stayed at eight. In 003 the two caps could not decouple because facts were never removed; with eviction they could. Once the map crossed 64, `validateSiteRecord` refused the whole record on write — the same poison, through the verification map. The invariant "a verification belongs to a fact that exists" now holds by construction: an evicted shape takes its verifications with it, in every profile. | Same probe, before and after: 90 verifications -> 8; `WRITE REFUSED: MEMORY_FULL a profile holds at most 64 verifications` -> `write OK`. Confirmed with two profiles too: the evicted fact's verification is gone from the other profile as well. |

## Coverage

| id | status | test that proves it |
|---|---|---|
| FR-001 | covered | `tests/extension-site-context.test.ts` — "measures the form inside main: the fillable fields, the required ones, the types and a hidden field", "measures the form inside a role=\"main\" landmark too", "reports nothing when the page has no main landmark", "counts a type=hidden input as no field, and a submit button as none", "never reports a value, a name or a label". |
| FR-002 | covered | `tests/memory-allowlist.test.ts:302-318` ("keeps the root path, which names no topic, and drops every other unlisted path", incl. `/account/1234` and `/login?next=1` -> null); `tests/memory-allowlist.test.ts:326-331`; `site-record.ts:138` re-checks the path on read and on write. |
| FR-003 | covered | `tests/memory-shape-privacy.test.ts` (counter counted and stored as `{ count: 1 }`, no target in the bytes); `tests/memory-tab-state.test.ts` (a tab that was never read raises nothing); `tests/memory-service.test.ts` (counter survives a signed-in site — the C6 case). |
| FR-004 | covered | `tests/memory-boundaries.test.ts:210-236` (8 shapes max, value byte bound, counter cap); `tests/memory-queue.test.ts` ("bounds a site at eight shape facts, keeps the freshest, and still writes the rest of the record (007)", "keeps the verifications bounded when a site's shapes churn, so the record stays writable (007)"); `tests/memory-shape-privacy.test.ts` (gate: no shape on a signed-in site under Option 1, shape present under Option 2). |
| FR-005 | covered | `tests/memory-output.test.ts` — the shape line's wording, the counter under `all`/`visits` and not under `facts`, the reminder inside 8 lines and 600 chars (`output.ts:146-181`, `REMINDER_MAX_LINES = 8`, `REMINDER_MAX_CHARS = 600`). |
| FR-006 | covered | `mcp-server/src/tools/memory.ts:9` (description names structure-not-content and `browser_evaluate`); the same assertions appear in `tests/memory-output.test.ts`. |
| FR-007 | covered | `tests/memory-store.test.ts:669` ("still loads a record written before the change"); `tests/memory-store.test.ts` quarantine tests; `tests/memory-allowlist-v2.test.ts` (version 3 in code and contract). |
| FR-008 | covered | `tests/memory-allowlist.test.ts:296-299` compares `fieldTypes`, `commitModes`, `failureCodes` and `formShapeLimits` against the contract; `tests/memory-allowlist-v2.test.ts:35-37` pins version 3 in both. A vocabulary change without a version bump fails the version assertion. |
| FR-009 | covered | `tests/extension-site-context.test.ts` (a page with no `main` reports `formShape: null`); `site-context.js:381-382` omits the block entirely when absent; `service.ts` stores no shape when the block is missing. |
| FR-010 | covered | `tests/memory-admin.test.ts` (007 additions: `delete <origin>` removes the origin's facts and every profile's counter; `delete --all`); `tests/memory-shape-privacy.test.ts`; exclusion and tombstone drops in `queue.ts:81-83`. |
| FR-011 | covered | `tests/memory-service.test.ts` — commit mode `enter` after a `browser_type` that pressed Enter and moved the address, `button` after a click on a `button`-marked control, `unknown` for a write that moved nothing and for a path never written to; `outcome-observer.ts:114-145`. |
| SC-001 | covered | `tests/memory-shape-privacy.test.ts` (one shape fact, one counter, commit `unknown` before a write). |
| SC-002 | covered | `tests/memory-shape-privacy.test.ts` (the stored bytes are searched for the planted labels/values/placeholders/help texts and must not contain them). |
| SC-003 | covered | `tests/memory-shape-privacy.test.ts` — Option 1 branch ("holds no shape fact on a site that looks signed-in, but still counts the counter") and Option 2 branch ("under Option 2 the shape of a signed-in page holds no name, value or path outside the reviewed list"). Each branch has its own assertion. |
| SC-004 | covered | `tests/memory-admin.test.ts` (007 additions); `admin.ts:85-95` (export and delete). Shape of the export: see F-07. |
| SC-005 | covered | `tests/memory-output.test.ts` (reminder line and character bounds with the new facts present). |
| SC-006 | covered | `tests/memory-allowlist-v2.test.ts:35-37` + `tests/memory-allowlist.test.ts:296-299`. |
| SC-007 | covered | The 16 failures in the affected suites are the environment-only set (the fixed Windows IPC named pipe and the POSIX-only store branch) — identical by name to the baseline on `972de04`. My own run of the affected suites: 361 tests, 3 failures, all three in the two POSIX/Windows-only blocks. |
| SC-008 | covered | `tests/memory-service.test.ts` (a counter raised in one profile never appears in another profile's record for the same origin). |
| SC-009 | covered | `tests/memory-service.test.ts` (enter / button / unknown cases; "no shape fact ever carries a commit mode that the markup alone suggested" is asserted by the fact being built from an observed action only — `outcome-observer.ts:114-145`, `allowlist.ts:248`). |

## Checklist: `checklists/form-shape-quality.md`

Marked by reading the spec, the research decisions and the code. The checklist file itself is unchanged.

| id | mark | reason |
|---|---|---|
| CHK001 | pass | D-03 (`research.md:132`) defines "visually hidden" exactly: `display:none`, `visibility:hidden`, `opacity:0`, `aria-hidden="true"` on the field or an ancestor, or no client rect; implemented at `site-context.js:104-117`. |
| CHK002 | pass | D-01 and D-02 (`research.md:130-131`) fix the fillable set and every type mapping; implemented at `site-context.js:71-99`. |
| CHK003 | pass | D-05 (`research.md:134`) fixes the landmark as `<main>` or `role="main"`; implemented at `site-context.js:118`. See F-04 for the nearest-ancestor nuance. |
| CHK004 | pass | D-07 (`research.md:136`): the form with the most fillable fields wins, ties to document order; implemented at `site-context.js:126`. |
| CHK005 | fail | A nested form and a shadow-root form are addressed nowhere: `research.md` has no rule for either, and `site-context.js:121` uses `querySelectorAll('form')`, which does not cross a shadow boundary. The spec's edge cases cover a same-origin frame only (`spec.md:143`). |
| CHK006 | pass | D-04 (`research.md:133`): the `required` attribute or `aria-required="true"`; implemented at `site-context.js:100-103`. |
| CHK007 | pass | D-06 (`research.md:135`): the root path is kept and 003's `matchPath` is untouched; `shapePath('/') === '/'` (`tests/memory-allowlist.test.ts:303`). |
| CHK008 | pass | The identity pattern admits the new kind: `site-record.ts:24` adds `ui\.form\.shape:.+` and `FACT_KINDS` adds the kind (`:26`); `tests/memory-store.test.ts` covers the identity. |
| CHK009 | pass | `allowlist.ts` adds the kind to the reviewed kinds map and the version is 3 in code and contract (`tests/memory-allowlist-v2.test.ts:35-37`). |
| CHK010 | pass | `matchPath` rejects `?`, `#`, `%`, `\` and `:` (`allowlist.ts:190`), and the stored identity is the normalized path; `tests/memory-allowlist.test.ts:308` asserts `/login?next=1` -> null. |
| CHK011 | pass | ADR-0006 (`docs/adr/0006-the-counter-outside-the-anonymity-gate.md`) records the rationale, and `SECURITY.md` states it to the owner. |
| CHK012 | pass | The vault's protection reaches the counter: `outcome-observer.ts:92` passes `vault.memoryEligibility(...)` into `decideScope`, whose `protected` verdict refuses the write. `tests/memory-shape-privacy.test.ts` covers the protected profile storing nothing. |
| CHK013 | fail | The overlap with 003's `ui.login` fact is addressed nowhere. A form with a password field is exactly a login form, and both facts are now written for the same path; `research.md` and the spec do not say whether that duplication is intended. |
| CHK014 | pass | The cap is 1,000,000 occurrences (`fact-allowlist.json` `formShapeLimits.occurrenceCountMax`), enforced in `reconcile.ts:91` and re-checked in `site-record.ts:221`; `tests/memory-boundaries.test.ts:235` covers it. |
| CHK015 | pass | The downgrade consequence is stated in `README.md` and `CHANGELOG.md` ("quarantines the whole record ... run `npm run memory -- delete --all` before downgrading") and in `site-record.ts:87-93`. |
| CHK016 | pass | D-08 (`research.md:137`): 120 seconds, the same window 004 uses; implemented as `TAB_ATTRIBUTION_MS` (`tab-state.ts:18`). |
| CHK017 | pass | D-08 and C7: the origin always comes from the last observed read (`outcome-observer.ts:81-93`), never from the failed action. |
| CHK018 | fail | The observation window is not stated as a number: the spec says only "the address changed", and the settle window lives in the extension's interaction handler. The consequence (a slower navigation is not seen, the mode stays `unknown`) is nowhere written down. |
| CHK019 | fail | "The last snapshot" is not defined for the `button` role: the code uses whatever the last snapshot's ref->role map holds (`tab-state.ts:97-100`), including a scoped or truncated snapshot, and the spec says nothing about which snapshot qualifies. |
| CHK020 | pass | The lifetime is implemented and documented: `tab-state.ts` is memory-only, the module header says "Nothing here is written to disk and nothing here reaches the agent" (`tab-state.ts:10-11`), and `clear()` drops it when memory is turned off. |
| CHK021 | pass | The behaviour is defined in code and bounded (`service.ts:362-364`, `tab-state.ts:119-126`): held, and dropped after the 120 s window. The spec still leaves the *choice* open — see F-02. |
| CHK022 | pass | The address is never stored: `noteCommitCandidate` reads `result.navigated` only to test that it is a non-empty string (`outcome-observer.ts:116`) and keeps only the mode (`tab-state.ts:106`). The mode map's key is connection + origin + path. |
| CHK023 | pass | The `ref -> role` map is memory-only and holds only the role and the ref (`tab-state.ts:45-56`); the name in a snapshot line is parsed but never kept (`tab-state.ts:25` captures it in group 2 and does not store it). |
| CHK024 | fail | Not stated anywhere: a mode observed by one profile becomes visible to the others through the shared shape fact, and neither the spec nor the ADRs say that this is intended. |
| CHK025 | pass | D-09 (`research.md:138`): the older facts go first, then the counter line; the header and the visit line are never dropped. Implemented at `output.ts:159-180`. |
| CHK026 | pass | D-10 (`research.md:139`): both codes share one line and the wording says "not visible" for both; implemented at `output.ts:137-139`. |
| CHK027 | pass | D-09: the counter appears under `all` and under `visits`, never under `facts` (`output.ts:202, 217`). |
| CHK028 | fail | The exported shape is not documented anywhere — see F-07. |
| CHK029 | fail | The tension is real and unresolved — see F-03. |
| CHK030 | fail | "in 100% of runs" still has no number of runs (`spec.md:178`); the tests are deterministic, so the criterion remains rhetorical. |
| CHK031 | pass | The signal is one the test can see: the extension's own `navigated` field in the tool result (`extension/handlers/interaction.js`), asserted through `outcome-observer.ts:116`. |
| CHK032 | pass | Each branch has its own privacy assertion: `tests/memory-shape-privacy.test.ts` has a distinct test for Option 1 and for Option 2. |
| CHK033 | pass | `delete <origin>` removes the origin's whole record, so every profile's counter goes with it (`admin.ts:87-95`, `store.deleteSite`). |
| CHK034 | pass | `tasks.md` records the gate: the vocabulary is approved before T004 and nothing before it changes stored data; the allowlist is version 3 in code and contract. |
| CHK035 | pass | OD-1 names the requirement lines it changes (`spec.md:38`: FR-004 and SC-003); OD-2 names the partial-availability behaviour (`spec.md:39`). |
| CHK036 | pass | R-09 is answered in the code and in `research.md`: the shape's budget is derived from the probe's remaining budget (`site-context.js:65`), so an overrun loses the shape and not the verdict. See F-05 for the residual gap. |
| CHK037 | pass | Every module stays under the 600-line limit: the largest is `mcp-server/src/memory/service.ts` at 557 lines; the new `tab-state.ts` is 141 and `outcome-observer.ts` 147. |
| CHK038 | pass | No tool's behaviour changed: only `browser_memory`'s description was edited (`mcp-server/src/tools/memory.ts:9`); `tests/memory-allowlist.test.ts` and the registry tests assert the tool surface. |
| CHK039 | fail | The owner's part is not stated as an action with a date: the README says to reload the extension and restart the daemon, and the spec's assumption says the owner reloads the extension "when the owner wants the shape there", but no dated owner action and no live measurement of SC-001/SC-009 on real Chrome is recorded anywhere. |
| CHK040 | pass | The failing tests are all present: a refusal on a tab that was read and one that was not (`tests/memory-shape-privacy.test.ts`, `tests/memory-tab-state.test.ts`), a commit candidate that moves the address and one that does not (`tests/memory-service.test.ts`). |

## Open decisions for the owner

1. **OD-1 — how far the shape fact reaches.** Unchanged and still open: Option 1 (default in the code) keeps the
   shape fact behind 003's anonymity gate; Option 2 stores it for every in-scope site. The code implements both
   branches and each has its own privacy assertion, so the decision is now a one-line switch
   (`MemoryServiceDeps.shapeGate`, `service.ts:64,183`). Option 2 changes FR-004 and SC-003 and needs a line in
   `SECURITY.md` (`spec.md:35-38`).
2. **OD-2 — when the shape becomes available.** Still open: it needs the extension reloaded in the profile. The
   feature is built to work partially from the start (an extension without the block produces no shape and no
   error) (`spec.md:39`; `site-context.js:381-382`).
3. **The vocabulary approval** is still the owner's gate before any stored data changes (`tasks.md` Gate).
4. **New — the eviction rule (F-08).** The spec fixes "at most 8 shape facts per site" but not *which* eight
   survive. The implementation keeps the freshest eight and replaces the oldest. The owner should confirm that
   rule, because it decides which page the agent can still read a shape for; "keep the first eight, ignore the
   ninth" is the alternative and would have been the safer default for a memory the agent reads back.
5. **New — CHK021 / F-02.** Whether a pending commit mode is held or dropped when the next read of its path is
   excluded, truncated or gated away. The code holds it (bounded by 120 s); the spec does not say.

## Verification I ran

- `npm run lint` -> exit 0. `npm run typecheck` -> exit 0.
- Affected suites re-run on the current tree: 361 tests, 3 failures, all in the POSIX-only and Windows-rename
  blocks (`tests/memory-store.test.ts`) that are the known environment-only set.
- New suites: `tests/memory-shape-privacy.test.ts` and `tests/memory-tab-state.test.ts` -> 16/16 pass.
- The eviction and verification behaviour was checked by executing the compiled `reconcile.js` and
  `site-record.js` against 90 distinct allowlisted paths and a two-profile scenario, before and after each fix.
- `node scripts/memory.mjs status` -> success, 4 origins, 2788 bytes.
- Temporary artefacts used: two compile directories under `%TEMP%` (`bc-verify-007-*`) and three
  `tmp-review-vitest*.json` files in the repo root, which I removed (the latter via the runtime's trash launcher).
  I did not start, stop or restart the daemon, touch the Chrome extension, or modify any file other than this
  one.