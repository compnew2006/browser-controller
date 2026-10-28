# Data model: site navigation map

**Plan**: [plan.md](plan.md) · **Research**: [research.md](research.md) · **Schemas**: [contracts/map-store.schema.json](contracts/map-store.schema.json)

## Conventions

- All times are UTC ISO-8601 strings.
- "Origin" is `URL.origin` of an `http:` or `https:` URL, as in 003.
- "Profile" is the verified `browserId` of the extension connection (003 R-04). An agent parameter never supplies it.
- Every path, title and name below is stored after masking (research R-12) and within its length bound.
- No query string, fragment, userinfo, form value, cookie, storage value or content-area text is ever stored.

## MapPolicy (`memory/map-policy.json`)

| Field | Type | Rules |
|---|---|---|
| `schemaVersion` | `1` | An unknown version leaves the map unavailable (`MEMORY_CORRUPT`) and nothing is captured |
| `profiles` | `{ [browserId]: { enabled: boolean, enabledAt: time \| null } }` | A missing file, profile or field means disabled (FR-006). ≤ 16 profiles |
| `excludedPaths` | `{ [origin]: prefix[] }` | ≤ 32 prefixes per origin. Each prefix starts with `/`, is not `/` and has no trailing slash (R-13) |
| `deletions` | `Tombstone[]` | ≤ 1,024. Pruned once the queue has drained past them and they are older than 7 days; reads apply them too (RV-06) |
| `updatedAt` | time | Set on every write |

A **Tombstone** is `{ profile: browserId | "*", origin: origin | "*", pathPrefix?: string, path?: string, at: time }`, with at most one of `pathPrefix` and `path`. Queued work older than a matching tombstone is dropped at commit (AC-16). Sources:

| Action | Tombstone |
|---|---|
| Map page delete | `{profile, origin, path}`: exactly that page, not the pages under it; `/` is allowed (RV-08) |
| Map site delete | `{profile, origin}` |
| Map delete-all for one profile | `{profile, origin: "*"}` |
| Path exclusion | `{profile: "*", origin, pathPrefix}` |
| 003 site delete | `{profile: "*", origin}` |
| 003 `delete --all` | `{profile: "*", origin: "*"}` |

**Effective map** for a call requires all of these (R-04):

- 003 `policy.enabled`.
- `profiles[browserId].enabled`.
- The origin is not in 003 `excluded`.
- The path is not under any `excludedPaths[origin]`.

**Transitions**: `disabled → enabled` and `enabled → disabled` per profile. A prefix is excluded or included per origin. Every transition comes from the owner CLI, or from a `browser_memory_policy` `map_*` request that the owner confirmed. Disable keeps data (R-05).

## MapRecord (`memory/maps/<sha256(browserId)>/<sha256(browserId + "\n" + origin)>.json`)

| Field | Type | Rules |
|---|---|---|
| `schemaVersion` | `1` | |
| `profile` | browserId | Must hash, with `origin`, to the file name; otherwise the file is quarantined |
| `origin` | origin | |
| `pages` | `PageEntry[]` | ≤ 500; unique `path` |
| `commitSeq` | integer | +1 per commit |
| `updatedAt` | time | |

The file is ≤ 1 MiB. A commit over the bound evicts entries (R-18) until it fits. A single page whose own entries exceed the bound is dropped (`MEMORY_FULL`, counted in status).

## PageEntry

| Field | Type | Rules |
|---|---|---|
| `path` | string ≤ 200 | Masked path; the identity |
| `title` | string ≤ 120 \| null | `null` when the path has a placeholder (FR-003) or the read had no title |
| `lang` | string \| null | From `siteContext.lang` |
| `dir` | `"ltr"` \| `"rtl"` \| null | |
| `addressable` | boolean | `false` when the path has a placeholder, or the page was reached through an address with a query or fragment (AC-04) |
| `reason` | `root` \| `destination` \| `hub` \| `landing` | Why the page was first recorded (R-11); kept for inspection |
| `via` | `{ path, control: ControlKey }` \| null | The page and control that led here last (AC-02) |
| `lastOpen` | `OpenResult` \| null | Result of the last direct open of this path (AC-19, AC-29) |
| `useCount` | integer | Worked direct opens (R-08) |
| `lastUse` | `{ result: "worked" \| "failed", at }` \| null | |
| `readChars` | integer | Length of the last complete read's text. A number only, used by the estimate (R-19) |
| `contexts` | `{ public?, not_public?, unknown? }` of `{ lastSeenAt }` | Last time read in each read context |
| `firstSeenAt`, `lastSeenAt` | time | `lastSeenAt` is refreshed by reads only, never by a redirect or a not-found open (FR-010) |
| `controls` | `ControlEntry[]` | ≤ 60; unique `key` |

**OpenResult** is `{ result, path?, origin?, statusClass?, at }`.

- `result` is one of `same`, `elsewhere`, `other_origin`, `sign_in`, `not_found` or `error`.
- `path` is a masked same-origin landing path.
- `origin` is the landing origin when it differs.
- `statusClass` is `4xx` or `5xx` for `error`.
- `same` refreshes `useCount`. `elsewhere`, `other_origin` and `not_found` rank the page lower. `sign_in` and `error` do not (R-08).

## ControlEntry

| Field | Type | Rules |
|---|---|---|
| `key` | string | `area + "\n" + role + "\n" + normalizeForMatch(name)` (R-14) |
| `area` | `header` \| `nav` \| `sidebar` \| `footer` \| `main` \| `page` \| `dialog` \| `menu` | R-10 |
| `role` | `link` \| `button` \| `tab` \| `menuitem` | Eligible roles by area (R-10) |
| `name` | string ≤ 80 | The masked visible name as seen. A name with a placeholder is never stored |
| `nth` | integer \| null | Set only from a complete read with duplicates (R-11) |
| `parent` | ControlKey \| null | The control whose menu or dialog contains this one (AC-08) |
| `lang` | string \| null | Page language at last sighting (R-18) |
| `dataChanging` | boolean | Vocabulary match (R-15) |
| `destinations` | `{ public?, not_public?, unknown? }` of `Destination` | Per the source read's context (R-09, AC-20) |
| `seen` | `{ public?, not_public?, unknown? }` of `{ lastSeenAt, atLastComplete: boolean }` | `atLastComplete: false` means not seen in that context (AC-18). `unknown` never sets `false` |
| `useCount` | integer | Worked uses |
| `lastUse` | `{ result: "worked" \| "failed", code?, at }` \| null | `code` is one of the R-08 locator codes, or `MISMATCH` |
| `firstSeenAt`, `lastSeenAt` | time | |

**Destination** is `{ path?, origin?, opens?, excluded?, at }`. Exactly one of these is set:

- `path`: a masked same-origin path.
- `origin`: another origin, never with its path.
- `opens`: `menu` or `dialog`.
- `excluded: true`: the destination is under an excluded prefix.

**Working status** (lookup ranking, AC-33):

- A page is working when two things hold:
  - Its controls' latest complete-read context does not mark it not seen.
  - Its `lastOpen` is null, `same`, `sign_in` or `error`, and its `lastUse` is not `failed`.
- A control is working when its `seen` entry for the context of its latest complete read has `atLastComplete: true` (or it has no complete read yet), and its `lastUse` is not `failed`.

## MapCounters (`memory/map-counters.json`)

`{ schemaVersion: 1, profiles: { [browserId]: { lookups, usesWorked, usesFailed, loadsSavedEstimate, charsSavedEstimate, since } } }`

- All values are non-negative integers, except `since`, which is a time.
- The record holds no origins, paths, titles or names (FR-016, SC-010).
- It is written by the map queue at most once per commit group. It is reset by map delete-all (for that profile) and by 003 `delete --all` (for every profile).

## TabReadCache (in memory only, never written)

- **Key**: `connectionId + "\n" + tabId`. At most 64 entries, least recently used first.
- **Value**:
  - `origin`, `rawPath`, `path` (masked), `context` and `lang`.
  - `complete`, `readChars` and `at`.
  - `controls` (parsed eligible controls with `ref`, `area`, `role`, `name` and `nth`).
  - `pendingClick` (the last attributed click awaiting its result read, for `opens` destinations).
- **Cleared** on a connection change for that connection, on any map or 003 policy change, and on any delete.
- **Replaced** by each observed read, and by a navigate or click that changes the tab's path.

## MapOp (map queue operations)

Every operation carries `opId`, `profile`, `origin` and `at`. `opId` is the daemon call id; a navigate with `snapshot:true` uses `<id>#read`.

| `type` | Fields | Source |
|---|---|---|
| `read` | `path`, `addressable`, `title`, `lang`, `dir`, `context`, `complete`, `readChars`, `controls[]`, `reason` (`root` \| `destination` \| `hub` \| `landing` \| `refresh`) | Observed snapshot, or a navigate (`controls` only with `snapshot:true`) |
| `click` | `fromPath`, `control` (key, area, role, name, nth), `sourceContext`, `destination`, `outcome` (`worked` \| `failed` \| `undecided`) | Attributed successful click (R-07, R-08) |
| `clickFailed` | `path`, `controlKey`, `code` | Attributed click error (R-08) |
| `open` | `requestedPath`, `result`, `landingPath?`, `landingOrigin?`, `statusClass?` | Navigate to a path that has a page entry |
| `counter` | `field`, `delta` | Lookups and estimates; keyed by profile only |

## State transitions

**Page entry**:

- It is created by a `read` op with `reason` `root`, `destination`, `hub` or `landing` (R-11).
- A `read` op on an existing path refreshes `lastSeenAt`, `contexts[ctx]`, `title`, `lang`, `readChars` and the controls.
- An `open` op sets only `lastOpen`, `lastUse` and `useCount`.
- It is deleted by eviction, a page/site/all delete, a path exclusion, or a 003 site delete or delete-all. Elapsed time never deletes it.

**Control entry**:

- **Unknown**: a complete read in context C that includes it gives `seen[C] = {now, true}`.
- **Current in C**: a complete read in C, with the same `lang`, that lacks it gives `seen[C].atLastComplete = false` (not seen in C).
- **Not seen in C**: a complete read in C that includes it makes it current in C again.
- Scoped, truncated and `unknown`-context reads only refresh (`unknown` gets `atLastComplete: true` without ever setting `false`).
- Attributed clicks update `destinations[sourceContext]`, `useCount` and `lastUse`. A failed use never changes `seen`.

**Map policy**: as listed above. A deletion writes its tombstone before files are removed. A corrupt policy file means the map is off until `map disable` or `map delete --all` (R-21).

## Validation summary

- On read, `onlyKeys` plus type checks apply per field, as in 003 `site-record.ts`. An invalid file is quarantined (`MEMORY_CORRUPT`).
- On write:
  - `INVALID_ARGUMENT` for values out of bounds, which is a programming error and is caught by tests.
  - `MEMORY_FULL` when a bound would be exceeded after eviction.
- Masking is checked again at write time: any stored string that still matches a masking pattern is dropped. This defense in depth is covered by the privacy suite.
