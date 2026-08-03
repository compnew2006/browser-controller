# RALPH_MEMORY

Distilled lessons — each entry is a trap that actually bit us, the reality the
codebase demanded, the surgical fix that worked, and the rule that prevents
recurrence.

## 2026-07-25 00:30 — Issue: tool-name drift silently disabled retry

- **The Trap:** `find.ts` set `.name = 'browser_find'` but its handler called
  `bridge.callTool('find', …)`. Two different strings for the same tool. The
  extension's `dispatch()` papered over it with aliases, so nothing errored —
  the drift was invisible.
- **The Reality:** the idempotency-retry lookup keyed on the `.name` form, so
  `isIdempotent('find')` was always false. `browser_find`/`browser_text` never
  retried on timeout despite being classified as read-only. Silent feature loss.
- **The Fix:** made each tool's `callTool()` arg equal its `.name`; deleted the
  aliases so future drift surfaces as an error. Added a static drift-guard test
  that `.toString()`s every handler and asserts the wire name.
- **The Law:** if the same identifier appears in N places, a test must assert
  they agree. Aliases hide drift; delete them.

## 2026-07-25 00:35 — Issue: eviction orphaned non-idempotent actions

- **The Trap:** the daemon's `socket.on('close')` comment said "fail in-flight
  calls" but the body only deleted the tracking entry. Reviewers trusted the
  comment.
- **The Reality:** the underlying `bridge.callTool` promise kept awaiting. A
  click/type could fire in the browser AFTER the originating agent was evicted
  as "dead" — a correctness and safety bug.
- **The Fix:** per-call `AbortController` (daemon creates, bridge respects).
  Close + dedup-replace call `controller.abort()`; the bridge rejects the
  pending promise and halts retries.
- **The Law:** "fail the call" must mean *cancel the work*, not *forget we
  asked*. If cleanup only updates bookkeeping, the side effect is still live.

## 2026-07-25 00:40 — Issue: docstring promised persistence that wasn't implemented

- **The Trap:** `background.js` header claimed console/network buffers were
  "persisted to chrome.storage.session so they survive service-worker death."
- **The Reality:** `grep storage.session` returned zero hits. Buffers were plain
  in-memory Maps, wiped on every SW recycle. The spec lied.
- **The Fix:** corrected the docstring to state the in-memory-only behavior
  honestly. (Implementing per-message persistence would be write-heavy; the
  honest fix is to document the design.)
- **The Law:** a comment is a promise to the next reader. If the code doesn't
  do what the comment says, fix one of them — never ship the contradiction.

## 2026-07-25 00:45 — Issue: parallel config tables drift from the registry

- **The Trap:** `IDEMPOTENT_TOOLS` (a string Set) and `TOOL_TIMEOUTS` (a string
  Record) lived in `daemon-config.ts` / `bridge.ts`, separate from `allTools`.
  Adding a tool didn't force a decision on its idempotency/timeout.
- **The Reality:** the set had drifted to include `browser_console`/
  `browser_network`, which mutate state on `clear:true` — a retry would silently
  lose messages.
- **The Fix:** annotated each `ToolDefinition` with `idempotent`/`timeoutMs`;
  derived the lookup tables from the registry. New tools now force the author
  to make the call.
- **The Law:** co-locate policy with the thing it describes. A parallel table
  is a license to forget.
