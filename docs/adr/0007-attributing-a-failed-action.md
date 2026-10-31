# ADR-0007: A failed action is attributed through the last observed read of its tab

- **Status**: proposed
- **Date**: 2026-10-31
- **Related**: [specs/007-form-shape-facts/spec.md](../../specs/007-form-shape-facts/spec.md) C7, FR-003, FR-011, [research.md](../../specs/007-form-shape-facts/research.md) R-07, R-08, [ADR-0005](0005-observing-clicks-for-the-site-map.md)

## Context

A failed call carries neither an observation nor a site context: `mcp-server/src/vault/daemon-routing.ts` returns an observation only for a successful call, and the site map says it outright — "Null for a failed click, which carries no siteContext" (`mcp-server/src/memory/map-capture.ts`). The daemon therefore cannot ask the page which site a refused action was aimed at, and the memory service's capture path needs a context it does not have.

Two things in spec 007 need the origin of a failed action:

- the **hidden-control counter** has to be counted against a site;
- the **commit mode** has to be held against the path the write ran on.

The site map already answers the first question with an in-memory tab read cache keyed by (connection, tab), 64 entries, a 120-second window ([ADR-0005](0005-observing-clicks-for-the-site-map.md)). The map's cache cannot be reused: the map is separately enabled and separately disable-able, and the memory feature must work with the map off.

## Decision

1. The memory service keeps **its own** tab cache (`mcp-server/src/memory/tab-state.ts`), filled by the service's own successful reads: the last observed origin, path, anonymity verdict, and the `ref → role` map of the last snapshot. At most 64 tabs per connection, and a read stays usable for 120 seconds — the same numbers the site map uses.
2. A refused action is attributed to that origin **only** when the cache has an entry for its tab, on the same connection, inside the window. A tab that was never read has no known origin, and nothing is counted.
3. The cache holds **no page text**: it keeps an origin, a path, an anonymity verdict and the roles of the last snapshot's refs. It is never written to disk and never reaches the agent.
4. The **commit mode** is learned from the action's own result: the extension's click and type handlers already report when the address changed, so the daemon reads a boolean from a result it already has. The mode is held against the path it ran on and applied at the next observed read of that path, where the anonymity gate is evaluated as usual.
5. A write that did not move the address proves nothing, so the mode stays `unknown`. There is no `none`: a rejected value, an inline error and a commit without a navigation look the same.

## Consequences

- The counter and the commit mode cost no new capability, no new observation and no extra call: both are read from an outcome the daemon already has.
- A refusal that happens after a long detour, or in a tab the agent never read, is not counted. The agent rediscovers the hidden control by itself in that case.
- The cache can be stale after a manual navigation inside the same tab, so a failure may be counted against the origin the tab was last read from. The count is an activity number; nothing is deleted or marked wrong.
- The commit mode is a positive observation or nothing. A form that commits in a way the daemon cannot see keeps the mode `unknown`, and the agent spends one attempt to find out.
