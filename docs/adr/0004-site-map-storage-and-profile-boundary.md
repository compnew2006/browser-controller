# ADR-0004: Site map storage, per-profile policy and the profile as the account boundary

- **Status**: proposed
- **Date**: 2026-10-28
- **Related**: [specs/004-site-navigation-map/plan.md](../../specs/004-site-navigation-map/plan.md), [specs/004-site-navigation-map/research.md](../../specs/004-site-navigation-map/research.md) R-02, R-04, R-05, [specs/004-site-navigation-map/data-model.md](../../specs/004-site-navigation-map/data-model.md), [ADR-0001](0001-website-memory-store.md), [ADR-0003](0003-website-memory-policy-control.md)

## Context

The site map (spec 004) remembers the structure of sites agents use: pages, the controls on them, and where those controls lead. Unlike 003's site facts, a map reflects what one signed-in account can see. A work profile and a personal profile see different menus, pages and settings on the same origin. Mixing them would leak the structure of one account into answers for another, and an enable prompt could not say whose browsing it covers.

The daemon already knows which Chrome profile a call runs in: a verified `browserId` from the paired extension, with an `ambiguous` flag when it cannot tell. It does not know the site account, and it must not try to find out (no cookies, no storage reads for this purpose).

003's `policy.json` cannot carry the map switch: its validator drops unknown keys, so an older build's write would erase a map flag, and a `map` block would raise 003's schema version.

## Decision

1. **The Chrome profile is the account boundary.** Every map file, counter, lookup and policy entry is keyed by the verified `browserId`. The `default` identity and an `ambiguous` connection never store or answer (`MEMORY_SCOPE_UNKNOWN`). One profile never reads another profile's maps.
2. **Storage**: one JSON file per (profile, origin) at `memory/maps/<sha256(browserId)>/<sha256(browserId + "\n" + origin)>.json`, so file names hide both, and per-profile counts, a profile delete-all and an origin delete across profiles need no file reads. Per-profile counters live in `memory/map-counters.json`. Writes and quarantine reuse 003's helpers, moved unchanged into `memory/record-files.ts`. Limits are provisional until the baseline (plan gate 4): 500 pages and 1 MiB per file, 60 controls per page, 1,000 files per profile and 64 MiB in total. At a profile or total limit, a new site is refused and status reports `MEMORY_FULL`, as 003 does.
3. **A separate policy file**, `memory/map-policy.json`: `profiles` (enabled and since when, per `browserId`), `excludedPaths` (per origin, segment-bounded prefixes), `deletions` (tombstones) and `updatedAt`. The map is effective for a call only when 003 is enabled, the map is enabled for the call's profile since before the observation, the origin is not excluded in 003, the path is not under an excluded prefix, and no newer tombstone covers it. This is checked again at commit time.
4. **Disable and delete**: map disable keeps data and hides it; 003 disable stops the map too. 003's site delete and `delete --all` also delete the matching map files and counters. Map deletes never touch 003 records. Every delete writes its tombstone before removing files, so queued work cannot bring entries back. Tombstones are pruned only after the queue has drained past them; pruning is housekeeping and does not clear the tab read cache.

## Consequences

- Answers stay within one account's view of a site, and the enable prompt can name the profile's label.
- Two profiles signed into the same site learn separately; nothing is shared between them. This is deliberate.
- Two different accounts used one after the other in the **same** profile share one map. The map stores structure only (masked paths, titles of structural pages, control names), so the leak is limited to which pages and controls exist. This is recorded in SECURITY.md.
- A downgrade to a build without 004 leaves `map-policy.json` and `maps/` untouched and unused; 003's files are unchanged.
- The limits are provisional and may change after the baseline without a format change.
