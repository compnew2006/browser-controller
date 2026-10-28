# ADR-0005: Observing clicks for the site map

- **Status**: proposed
- **Date**: 2026-10-28
- **Related**: [specs/004-site-navigation-map/plan.md](../../specs/004-site-navigation-map/plan.md), [specs/004-site-navigation-map/research.md](../../specs/004-site-navigation-map/research.md) R-06, R-07, R-08, R-09, [ADR-0004](0004-site-map-storage-and-profile-boundary.md)

## Context

003 observes only reads: `browser_navigate` and `browser_snapshot` carry a `siteContext` block that the daemon uses for its scope decision. A site map also needs to know which control an agent used and where the tab went (destinations and hub pages, spec 004 AC-07, AC-08, FR-002). Two cheaper options were rejected:

- **Inferring the destination from the next observed read**: a manual navigation in between, or a second agent in another tab, would attribute a page to the wrong control.
- **Using the MCP-side `expect` result**: it never reaches the daemon.

A click must stay fast and must not read more of the page than 003 already does. The daemon has no page text after a click and must not keep any.

## Decision

1. **`browser_click` becomes observable** (`OBSERVABLE_TOOLS` in `mcp-server/src/bridge-frames.ts`, `OBSERVED_TOOLS` in `extension/dispatch/router.js`). The daemon asks for observation only when the map is effective for the session's profile. 003 never captures from a click.
2. **A light `siteContext`** answers an observed click: `url` after the handler, `fromUrl` (the tab URL captured before the handler), `incognito`, `topLevel: true`, `stable` (the URL after equals a second read), `anonymous: null` and `anonymityReason: 'not_probed'`. It runs no page script and reads no cookies or storage: two `chrome.tabs.get` calls within `URL_BEFORE_BUDGET_MS`. `buildSiteContext` gets an opt-in `light` option; its other callers are unchanged.
3. **A new extension capability `site-map`** advertises this. Without it, clicks are not observed, and the map learns pages and controls from reads only, with no destinations or hub pages.
4. **Attribution through an in-memory tab read cache** keyed by (connection, tab), at most 64 tabs, least recently used first. It holds the parsed eligible controls of the tab's last observed read and never page text. A click target resolves through the cached snapshot refs (`eN`), a `{role, name, nth?}` locator, or a single matching `text=` control; CSS selectors and coordinates are not attributable. A successful click counts only when `fromUrl` has the cached origin and path. The cache is cleared on a connection change, on an owner policy change and on a map delete; housekeeping (tombstone pruning) leaves it in place.
5. **The destination's read context comes from the source page's read**, so a click needs no anonymity probe, and a sign-in page reached while signed out never replaces a signed-in destination.
6. **Failed clicks** carry no `siteContext`. A locator failure (`NOT_FOUND`, `AMBIGUOUS`, `ELEMENT_HIDDEN` and similar) is attributed through the cache alone, at most 120 s old and on the same connection, and only for a vault-clear tab. It changes only the rank of the control with that exact role and name.

## Consequences

- Destinations, hub pages and use results (worked, failed, undecided) become possible without storing page text or probing the page on a click.
- A click costs a few milliseconds more while the map is on; with the map off, nothing changes.
- Older extensions keep working: the daemon checks the `site-map` capability and does not ask them to observe clicks.
- **Residual risk**: a failed click is attributed through a cache that could be stale after a manual navigation in that tab. The effect is bounded to one control's rank; nothing is deleted or marked not seen. A later change can attach `fromUrl` to click errors if tests show misattribution.
- **Wiring note**: `daemon.ts` gets one line, which passes the failed call's error text into the memory outcome so failed clicks can be attributed. This departs from the plan's "no `daemon.ts` edits" (R-24) and keeps the file at 595 lines.
