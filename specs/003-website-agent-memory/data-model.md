# Data model: shared website memory

**Plan**: [plan.md](plan.md) · **Schemas**: [contracts/memory-store.schema.json](contracts/memory-store.schema.json), [contracts/site-context.schema.json](contracts/site-context.schema.json)

All times are UTC ISO-8601 strings. "Origin" is `URL.origin` of an `http:` or `https:` URL: scheme, host and effective port. Other schemes are never in scope.

## MemoryPolicy (`memory/policy.json`)

| Field | Type | Rules |
|---|---|---|
| `schemaVersion` | `1` | Unknown version → memory unavailable (`MEMORY_CORRUPT`), nothing captured |
| `enabled` | boolean | Missing file or field → `false` (disabled initially, FR-004) |
| `enabledAt` | time \| null | Set on each `enable`; captures before it never exist (no backfill, AC-06) |
| `excluded` | origin[] | ≤ 5,000 entries, canonical origins, unique |
| `deletions` | `{ [origin]: time }` | Tombstones; `"*"` = delete-all time. Pruned after the queue drains past them |
| `updatedAt` | time | Every write |

**Transitions**: `disabled → enabled` (owner `enable`); `enabled → disabled` (owner `disable`). Exclude and include toggle one origin. Each transition comes from the owner CLI, or from an agent's `browser_memory_policy` request that the owner confirmed in the agent client (2026-10-27 clarification, FR-004, AC-32); no other path changes it. An unconfirmed, declined or unanswerable request leaves the policy unchanged. Each commit re-reads the policy (R-03).

## SiteRecord (`memory/sites/<sha256(origin)>.json`)

One per origin with any committed data. The file name hides the origin from a directory listing; the origin is inside.

| Field | Type | Rules |
|---|---|---|
| `schemaVersion` | `1` | |
| `origin` | origin | Must hash to the file name, else the file is quarantined |
| `facts` | SiteFact[] | ≤ 64; one current fact per `factId` |
| `profiles` | `{ [profileId]: ProfileSiteState }` | `profileId` = verified `browserId` (R-04); ≤ 16 profiles |
| `commitSeq` | integer | +1 per commit; the cache keeps the latest |
| `updatedAt` | time | |

Size ≤ 64 KiB; a commit that would exceed it is dropped (`MEMORY_FULL`).

## SiteFact (shared across profiles for the same origin)

| Field | Type | Rules |
|---|---|---|
| `factId` | string | `site.language` \| `ui.search` \| `ui.login` \| `ui.control:<role>:<name>` (R-10) |
| `kind` | enum | `site.language`, `ui.search`, `ui.login`, `ui.control` |
| `value` | object | Kind-specific; every string is from [fact-allowlist.json](contracts/fact-allowlist.json) |
| `firstObserved` | time | Internal; never shown to another profile |
| `lastObserved` | time | Internal; shown to other profiles only as `YYYY-MM` (R-11) |
| `status` | `current` | Superseded values are not kept (R-10) |

Value shapes:

- `site.language`: `{ lang: <primary subtag>, dir: "ltr" | "rtl" | null }`
- `ui.search`: `{ role: "searchbox" | "textbox" | "combobox", name: <lexicon phrase> }`
- `ui.login`: `{ path: <lexicon path> | null }`
- `ui.control`: `{ role: <allowed role>, name: <lexicon phrase> }`

**Validation**: A fact is created only from a snapshot read whose `siteContext.anonymous === true` (R-07), with scope `in` (R-04/R-05/R-06), memory enabled and the origin not excluded. A candidate whose strings are not exact allowlist entries is discarded, not truncated. At most 64 facts per origin; more → `MEMORY_FULL`, and existing facts are kept.

## ProfileSiteState (per profile, never shared)

| Field | Type | Rules |
|---|---|---|
| `visit` | `{ firstAt, lastAt, count }` \| null | From successful in-scope `browser_navigate` (AC-01). Counts only, no paths, no titles |
| `verifications` | `{ [factId]: { at, tool, path } }` | `tool` ∈ `browser_snapshot`, `browser_navigate` (with snapshot); `path` = URL path ≤ 120 characters, no query or fragment; shown only to this profile |

**Rule**: Another profile's view never includes `visit`, `verifications`, `path`, `profileId` or exact times (AC-07, AC-29, AC-31).

## CaptureOp (in memory, queue only)

| Field | Type | Rules |
|---|---|---|
| `opId` | string | `daemonCallId`; dedupe LRU of 1,024 (R-14) |
| `type` | `visit` \| `facts` | |
| `profileId`, `origin` | | From verified scope only |
| `at` | time | Time of the browser outcome |
| `facts` | candidate[] | Already filtered by the allowlist; ≤ 64 |
| `path`, `tool` | | For the verifications |
| `enqueuedAt` | time | Compared with tombstones and `enabledAt` at commit |

**Lifecycle**: `enqueued → committed` (after rename) or `→ dropped(reason)`. The reasons are `disabled`, `excluded`, `deleted`, `duplicate`, `queue_full`, `timeout`, `capacity`, `io_error` and `corrupt`. A dropped operation leaves no partial state (AC-17, AC-18).

## SiteContext (extension → daemon, per observed call; never stored as is)

| Field | Type | Rules |
|---|---|---|
| `url` | string | Final tab URL with userinfo removed; the daemon derives the origin and path and drops query and fragment |
| `incognito` | boolean | `tab.incognito` |
| `topLevel` | boolean | The read covered the top-level document |
| `stable` | boolean | URL before == URL after the handler (R-05) |
| `lang`, `dir` | string \| null | `documentElement.lang` primary subtag, and `dir` |
| `passwordField` | boolean | A visible `input[type=password]` in the top-level document (source of `ui.login`); no value, name or label |
| `anonymous` | boolean \| null | R-07 verdict; `null` = unknown |
| `anonymityReason` | enum | `ok`, `cookie`, `storage`, `indexeddb`, `incognito`, `query`, `unstable`, `no_permission`, `unavailable` |

## Scope decision (computed per call, not stored)

`in` when all of the following hold, else `out(reason)`:

- memory is enabled;
- the origin is not excluded;
- the profile is verified (R-04);
- `siteContext` is present, `stable`, `topLevel` and not incognito;
- the vault is `clear` (R-06);
- sanitizing left the result unchanged.

A visit needs `in`. Facts need `in` and `anonymous === true`. A reminder needs `in`, except that the result-unchanged condition does not apply to it.

## Relationships

```text
MemoryPolicy 1 ── governs ── * SiteRecord
SiteRecord 1 ── * SiteFact (shared by origin)
SiteRecord 1 ── * ProfileSiteState (keyed by profileId)
ProfileSiteState.verifications ──> SiteFact.factId
CaptureOp ──(commit)──> SiteRecord
```
