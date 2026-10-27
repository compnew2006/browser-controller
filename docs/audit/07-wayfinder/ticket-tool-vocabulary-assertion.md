# Tool vocabulary: add the cross-runtime assertion

`wayfinder:grilling` · Blocked by: none · Unblocks: phase 6 step 5 of the route.

## Question

A tool's name is written down in two runtimes, and the existing drift guard is purely local. Should the
extension's dispatch be asserted against the MCP tool list — and if so, with the tool names hardcoded, or
derived?

## What the audit found, then corrected

> **Update (2026-10-27, `09` F6-4).** The gap below is closed. `tests/extension-router.test.ts` ("every registered MCP tool has an extension handler" and "dispatches exactly the known tool set") asserts the extension dispatch against the MCP tool list, with `browser_batch` and `browser_safety` exempt and `browser_vault` handled separately. `tests/vault-redaction.test.ts` asserts the redaction registry against `allTools`. The text below is the original analysis.

`05` F9 says a tool's name lives in three homes and has no compile-time link. Reading the tests sharpened
that, and part of the finding turned out to be already handled:

- `tests/tools/registry.test.ts:10` holds `expectedTools`, a **hardcoded, ordered** list of the 19 public
  names, asserted with `toEqual`. That is a deliberate contract lock (tools/list order), not drift.
- `tests/tools/registry.test.ts:58` is a **wire-name drift guard**: for every tool, the handler closure
  must be tagged with its own `.name`, otherwise the idempotency-retry lookup silently fails. That covers
  MCP-name ↔ wire-name.
- `toolManifest` (test-only export) exists to back that test; it does **not** compare against the
  extension.

So the gap is exactly one edge: **nothing asserts that the extension's dispatch table knows every wire
name the server will send.** Forgetting the extension side yields a runtime "unknown tool" instead of a
failed test.

## What a session needs to settle

1. Is the assertion worth its cost? A test that imports `extension/lib/router.js` needs the `chrome.*`
   mock already present in `tests/extension-router.test.ts`, so the cost is a few lines in an existing
   file, not a new harness. Recommendation: yes.
2. Which names are exempt? `localTools = new Set(['browser_batch', 'browser_safety'])` already exists in
   the registry test — `browser_batch` runs entirely in the MCP process and `browser_safety` likewise.
   `browser_vault` is *not* exempt: it goes over the wire, but its dispatch is `vault` handling rather
   than a handler module, so the test must know about that route too.
3. Hardcode or derive? `expectedTools` is already hardcoded on purpose. The cross-runtime test should
   derive from `allTools` minus the local set, so adding a tool fails the test until the extension side
   exists — that is the whole point. The hardcoded `expectedTools` stays as the separate order lock;
   the two tests answer different questions.
4. If the extension's dispatch is not a plain string map (e.g. it routes by a prefix or a switch), say how
   the test reads it — a test that greps source text is weak evidence; prefer importing the router's
   dispatch and asserting on the exported surface.

## Trade-off to state in the answer

Adding the test couples `tests/` to the extension's dispatch shape, so a refactor of `router.js` breaks a
test in `mcp-server`'s suite. That is the trade: an import-graph edge in exchange for a build-time answer
to "does the other runtime know this tool". It is worth it because the failure it prevents is invisible
until a user hits it.

## Resolution

<!-- fill on close: yes/no, the exempt set, derived vs hardcoded, where the test lives -->
