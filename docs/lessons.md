# Engineering laws

Four rules this codebase learned the hard way. Each one cost a real defect, and
each one is now enforced by something that fails loudly instead of by a
reviewer's memory.

They are written as laws rather than as advice because each of them has a
mechanism behind it. A law without a mechanism is a wish.

| # | Law | Enforced by |
|---|---|---|
| 1 | If the same identifier appears in N places, a test must assert they agree. Aliases hide drift; delete them. | `tests/protocol-tool-names.test.ts` (the wire name is generated from the registry by `scripts/generate-tool-names.mjs`) |
| 2 | "Fail the call" must mean *cancel the work*, not *forget we asked*. If cleanup only updates bookkeeping, the side effect is still live. | one `AbortController` per call in `mcp-server/src/daemon.ts`; the close handler aborts it, the bridge honours it and stops retrying |
| 3 | A comment is a promise to the next reader. If the code does not do what the comment says, fix one of them — never ship the contradiction. | reviewed in `docs/audit/`; the extension's buffer docs state the in-memory-only behaviour instead of claiming persistence |
| 4 | Co-locate policy with the thing it describes. A parallel table is a license to forget. | idempotency and timeouts are derived from the tool registry in `mcp-server/src/tools/index.ts`, not kept in a second hand-maintained table |

## Where these came from

Each law is the residue of a defect that shipped and had to be fixed:

**2026-07-25 — tool-name drift silently disabled retry.** `find.ts` declared
`.name = 'browser_find'` while its handler called `bridge.callTool('find', …)`.
The extension's `dispatch()` papered over the difference with aliases, so
nothing errored and the drift was invisible. The idempotency-retry lookup
keyed on the `.name` form, so `isIdempotent('find')` was always false and
read-only tools never retried on timeout. The fix made each tool's
`callTool()` argument equal its `.name`, deleted the aliases, and added the
static drift-guard test.

**2026-07-25 — eviction orphaned non-idempotent actions.** The daemon's
`socket.on('close')` comment said "fail in-flight calls", but the body only
deleted the tracking entry, and reviewers trusted the comment. The underlying
`bridge.callTool` promise kept awaiting, so a click or a keystroke could fire in
the browser *after* the originating agent had been evicted as dead — a
correctness and safety bug. The fix introduced a per-call `AbortController`.

**2026-07-25 — a docstring promised persistence that was not implemented.** The
extension's background header claimed the console and network buffers were
"persisted to chrome.storage.session so they survive service-worker death".
`grep storage.session` returned zero hits: they were plain in-memory maps,
wiped on every service-worker recycle. The fix corrected the docstring rather
than inventing a write-heavy persistence layer, because the honest fix for a
comment that lies is to tell the truth.

**2026-07-25 — parallel config tables drifted from the registry.**
`IDEMPOTENT_TOOLS` and `TOOL_TIMEOUTS` lived in `daemon-config.ts` and
`bridge.ts`, apart from `allTools`, so adding a tool forced no decision about
its idempotency or its timeout. The set had drifted to include
`browser_console` and `browser_network`, which mutate state on `clear: true` —
a retry would have silently lost messages. The fix annotates each tool
definition and derives the lookups from the registry, so a new tool forces the
author to make the call.

## Adding a law

When a defect teaches something that does not fit the four above, add it here
with the same shape: the trap, what reality turned out to be, the fix that
worked, the law, and the mechanism that now enforces it. A law without a
mechanism does not belong in this file.
