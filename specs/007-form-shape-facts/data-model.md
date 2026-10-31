# Data model: form shape facts

**Branch**: `main` · **Date**: 2026-10-31 · **Spec**: [spec.md](spec.md) · **Research**: [research.md](research.md) · **Vocabulary draft**: [contracts/interaction-vocabulary.json](contracts/interaction-vocabulary.json)

This model extends 003's on-disk memory. Nothing here changes the store's file layout, its atomic write, its single writer queue or its quarantine rule.

## Entities

| Entity | Where it lives | Scope | Added by 007 |
|---|---|---|---|
| `SiteRecord` | `sites/<sha256(origin)>.json` | one file per origin | no |
| `SiteFact` | inside a record | one kind added | yes: `ui.form.shape` |
| `ProfileSiteState` | inside a record, per profile | one key added | yes: `hidden` |
| `FormShape` | the extension's result block | one read | yes |
| `TabState` | the daemon's memory only | per (connection, tab) | yes |

## `FormShape` — the extension's block

The extension adds one optional object to its `siteContext` result. It is measured in the DOM, not parsed out of the snapshot (R-01, R-03): a control that is not exposed cannot be counted from the snapshot at all.

```json
"formShape": {
  "fields": 3,
  "required": 1,
  "types": ["text", "password", "checkbox"],
  "hidden": true
}
```

| Key | Type | Rule |
|---|---|---|
| `fields` | integer ≥ 0 | how many fillable controls the measured form has (D-01) |
| `required` | integer ≥ 0 | how many of them are required (D-04) |
| `types` | array of strings | the distinct field types, each from `fieldTypes`, each at most once, at most 8 entries (D-02) |
| `hidden` | boolean | whether at least one field is visually hidden (D-03) |

Rules that make the block safe to store:

- The block holds **no string from the page**: no label, no name, no placeholder, no help text, no value, no selector, no id. Every string in `types` is a member of the reviewed vocabulary.
- The block appears **only** when the page has a form inside the `main` landmark (D-05) and the measured form is the one selected by D-07. A page with no `main`, or no form inside it, reports no block.
- The block is **optional**: an older extension omits it, and the daemon treats the absence as "no shape" (FR-009).
- The measurement shares the probe's 1,300 ms budget (R-09). An overrun answers `anonymous: null`, which stops the facts as well — so the shape is measured after the anonymity verdict, inside what is left.
- When the distinct types exceed 8, the least frequent ones are merged into `other` (D-02).

## `SiteFact` — the shape fact

One fact per (origin, path), shared by every profile of that origin.

| Field | Value |
|---|---|
| `factId` | `ui.form.shape:<path>` — the path is the reviewed path, `/` for the root (D-06) |
| `kind` | `ui.form.shape` |
| `value` | `{ "shape": { "fields", "required", "types", "hidden" }, "commit": "unknown" \| "enter" \| "button" }` |
| `firstObserved` / `lastObserved` / `status` | as in 003 |

- The value has **two** properties, within the store's `maxProperties: 2`.
- The value serialises within `valueBytes: 200`.
- The path follows 003's reviewed rule: every segment on `pathSegments`, no query and no fragment (`^/[^?#]*$`, ≤ 120 characters). The root path `/` is allowed for this kind because it names no topic (D-06).
- `commit` starts at `unknown` and is replaced by an observed `enter` or `button` at the next observed read of that path (C8). It is never `none` and never inferred from the markup.
- The identity pattern in `mcp-server/src/memory/site-record.ts:22` gains `ui\.form\.shape:.+`, and the known kinds at `:140` gain `ui.form.shape`. Both are code changes, not only schema changes (R-06).

## `ProfileSiteState` — the hidden-control counter

One counter per (origin, profile), beside the visit counter.

```json
"hidden": { "count": 3 }
```

- The counter counts the failures **this profile** observed on that origin, with the codes `ELEMENT_HIDDEN` and `ELEMENT_COVERED` only.
- It is **not** behind the anonymity gate (C6): it counts the profile's own activity and holds no page content. It is behind the scope gate, so a profile under the vault's protection stores nothing (R-13).
- The count is capped at `occurrenceCountMax` (1,000,000) and never falls.
- The counter is removed with the profile's state, and with the origin's whole record on a delete.
- The validator at `site-record.ts:158` accepts the new key; `memory-store.schema.json` gains it under `profileState` (which is `additionalProperties: false`).

## `TabState` — the daemon's memory only

The cache that attributes a failed action and a write to a path (C7, D-08).

```ts
type TabState = {
  origin: string;        // the canonical origin of the last observed read
  path: string;          // its path, for the commit mode
  anonymous: boolean | null;
  refs: Map<string, string>;  // the last snapshot's ref → role
  atMs: number;          // when it was written
};
```

| Rule | Value | Source |
|---|---|---|
| Entries per connection | ≤ 64 | the map's `tabCacheEntries` |
| A read is valid for | 120 s | the map's `errorAttributionSeconds` |
| Filled by | the memory service's own successful reads | R-07 |
| Never persisted | yes | it holds page structure and nothing else belongs on disk |
| Never leaves the daemon | yes | it is not part of any tool result |

## The queue

`CaptureOp` gains one type beside `visit` and `facts`:

| Op | Carries | Lands in |
|---|---|---|
| `visit` | the profile and the origin | `profileState.visit` |
| `facts` | the profile and the origin, and the facts | `record.facts` |
| `hidden` | the profile and the origin, and the count | `profileState.hidden` |

Every op travels through the same writer queue, so the exclusion list and the deletion tombstones drop it exactly as they drop the other operations (R-14).

## The lifecycle

| Event | The shape fact | The counter |
|---|---|---|
| A read of a path | written or replaced; the first read's `firstObserved` is kept | untouched |
| A later read of the same path | replaced; `lastObserved` moves | untouched |
| A refused action on that origin | untouched | the count rises by one |
| A refused action on a tab that was never read | untouched | untouched (no origin is known) |
| `delete <origin>` | removed | removed for every profile of that origin |
| `delete --all` | removed | removed |
| `exclude <origin>` | not stored | not stored |
| `disable` (memory off) | not collected | not collected |
| `export` | included in the export in the documented shape | included |

## Bounds

| Bound | Value | Where |
|---|---|---|
| Shape facts per site | 8 | the draft contract's `bounds` |
| Distinct types per shape | 8 | the draft contract's `bounds` |
| The shape value's bytes | 200 | the draft contract's `bounds` |
| The counter's count | 1,000,000 | the draft contract's `bounds` |
| Facts per site | 64 | 003's store schema |
| Profiles per site | 16 | 003's store schema |
| Site file | 64 KiB | 003's store schema |
| Reminder | 8 lines, 600 characters | `memory/output.ts:115-138` |
| Tab cache | 64 entries, 120 s | D-08 |

## Compatibility

| Combination | Result |
|---|---|
| New daemon, old extension | the counter works; no shape fact; the site is read as before |
| New daemon, new extension | the whole feature |
| Old daemon, new record | the record is quarantined as `MEMORY_CORRUPT` — the **whole** record, not only the new field (R-15) |
| Old daemon, old record | as before |

The downgrade needs an escape hatch, the way 004 got one (`npm run memory -- map delete --all`): this feature needs its own, and the CHANGELOG must say so before the first release.
