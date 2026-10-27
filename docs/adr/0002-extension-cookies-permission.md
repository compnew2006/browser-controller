# ADR-0002: Add the `cookies` extension permission to verify public status

- **Status**: accepted
- **Date**: 2026-10-27
- **Related**: [specs/003-website-agent-memory/plan.md](../../specs/003-website-agent-memory/plan.md), [specs/003-website-agent-memory/research.md](../../specs/003-website-agent-memory/research.md) R-07, [specs/003-website-agent-memory/spec.md](../../specs/003-website-agent-memory/spec.md) FR-006 — **owner gate 2 (plan.md, tasks.md T008): approved 2026-10-27**

## Context

Site facts (FR-002) may only be captured from a page read in a verified anonymous context: no authenticated session, no private input. The 2026-10-27 spec clarification settled the exact check (FR-006): a page counts as public enough only when the browser confirms the origin carries no cookies, no `localStorage`/`sessionStorage` entries and no IndexedDB databases, except names already on the reviewed consent/analytics allowlist — names only, values are never read.

The page's own `document.cookie` cannot see `HttpOnly` session cookies, which are exactly the ones most likely to indicate a logged-in session. Three alternatives were considered to close that gap:

- **CDP `Network.getCookies`**: requires attaching the Chrome debugger to the tab on every read, which raises the "being debugged" banner the user sees for ordinary clicks and typing — an intrusive cost for a background anonymity check.
- **`webRequest` with `extraHeaders`**: adds overhead to every network request on every page, not just the ones a memory check runs on, and still misses tokens kept in storage rather than cookies.
- **`cookies` permission**: `chrome.cookies.getAll({url})` returns cookie names (and values, which the memory code never reads) for an origin without attaching the debugger or touching unrelated requests.

## Decision

Add `"cookies"` to `extension/manifest.json`'s `permissions`, gated on this ADR's acceptance and the owner's explicit approval (tasks.md T008). The extension's `site-context.js` module uses `chrome.cookies.getAll({url})` to check cookie *names* only (including `HttpOnly` ones), together with `localStorage`/`sessionStorage` key names and `indexedDB.databases()`, to compute `anonymous` and `anonymityReason` in the `siteContext` block it already adds to navigate and snapshot results.

Without this permission, `anonymous` is `null` with reason `no_permission`: the feature still records visit counts, but never captures a site fact.

## Consequences

- `cookies` is a new, user-visible Chrome extension permission; existing installs will prompt for review on update (standard Chrome MV3 behavior for a new permission).
- Values are still never read by the memory module, so this permission provides no new exposure to the vault or to page content — the risk is bounded to cookie/storage **names** being inspected.
- If the owner declines this permission, the feature degrades to visit-only memory (FR-006's fail-closed default), with no further code change needed.
