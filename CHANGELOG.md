# Changelog

## [2.2.0] — 2026-07-27 — Progressive disclosure + token optimization

### Token optimization (46-90% reduction across all tools)
- **Compact JSON**: removed `JSON.stringify(result, null, 2)` across all 21 tools (-48% per response)
- **navigate snapshot:false**: `browser_navigate` now accepts `snapshot:false` to skip the inline accessibility tree (-92% when skipped)
- **browser_text default**: maxLength 50000 → 5000 (-90%)
- **tabs list**: truncate URLs to 80 chars + omit null fields (-46%)

### Progressive disclosure (Anthropic "Code Execution with MCP" pattern)
- New meta tool `browser_tools` with `list`/`search`/`details` actions
- When `BROWSER_CONTROLLER_PROGRESSIVE=1`: only `browser_tools` is visible (~150 tokens vs ~4200 for all 22 tools). Agent discovers + activates tools on demand.
- Default is FULL mode (all tools visible) for backward compatibility
- `details` action uses `z.toJSONSchema()` for clean JSON Schema with parameter descriptions
- All 22 tools now carry a `summary` field (one-line description for search/list)

### Other improvements
- `browser_run_action`: dual mode — accepts both tool wrappers AND plain JS expressions/IIFEs
- Popup: full design system (tokens, spacing scale, state vocabulary, anti-ban guards)
- Tab locks keyed by agentName (survives reconnect churn)
- LaunchAgent auto-start for daemon (launchd, macOS)
- Locks auto-release when owning agent disconnects

Test count: 115 → 134 (all green)

## [2.1.0] — 2026-07-25 — Architecture hardening

Outcome of a full architecture-guardian audit (graphify + 3 parallel deep-dive
agents, all findings verified against source). 15 issues found across 4
severities; all fixed. Test count: 81 → 115 (all green).

### CRITICAL (correctness bugs)
- **C1 — tool-name drift disabled retry for 2 tools.** `find.ts` declared
  `.name = 'browser_find'` but called `bridge.callTool('find', …)`; same for
  `text.ts` (`browser_text` vs `get_page_text`). The idempotency retry keyed on
  the `.name` form, so these two read tools never retried on timeout. Fixed by
  making each tool's `callTool` arg equal its `.name`; dropped the alias
  paper-over in `dispatch()`. Added a static drift-guard test over all 22 tools.
- **C2 — eviction orphaned in-flight calls.** The daemon's `socket.on('close')`
  deleted tracking but never cancelled the pending `bridge.callTool` promise —
  so a non-idempotent action (click/type) kept running after the agent was
  declared dead. Fixed via per-call `AbortController` threaded daemon → bridge;
  close + dedup-replace now `controller.abort()`. 3 new bridge tests prove it.
- **C3 — lying docstring.** Header claimed console/network buffers persisted to
  `chrome.storage.session`; code never called it (buffers lost on SW recycle).
  Corrected the docstring to state the in-memory-only behavior honestly.
- **C4 — handler throws left the daemon hanging.** `ws.onmessage` catch logged
  but didn't reply, so a thrown handler hung the agent until timeout. Now sends
  an explicit error response with the `msg.id`.

### MAJOR
- **M1** — `sessionId` now travels as a first-class WS field (`msg.sessionId`),
  not injected into `params.__sessionId`. The daemon is a pure `{tool, params}`
  multiplexer again.
- **M2** — `browser_console`/`browser_network` removed from the idempotent set
  (`clear:true` mutates state; a retry silently lost messages).
- **M3** — `IDEMPOTENT_TOOLS` + `TOOL_TIMEOUTS` derived from each tool's
  `idempotent` / `timeoutMs` flags on `ToolDefinition`. Single source of truth.
- **M4** — client-side safety-net timeout raised 70s → 210s so it always
  outlives the bridge's worst case (60s × 3 retries + slack).
- **M5** — ~190 lines of a11y-tree domain logic extracted from `handleSnapshot`
  into `extension/utils/snapshot-tree.js` (`PAGE_BUILD_TREE_FN`), matching the
  existing injected-page-function pattern.

### MINOR
- `checkToken` no longer leaks token length (pads to fixed size before compare).
- `tab-concurrency` test gaps closed: `unlock(null)`, `waitFor` timeout path,
  `isIdle`, synchronous-throw-in-fn.
- Thin client attempts ONE daemon respawn on disconnect (bounded, no loop).

### Earlier (2.0.0)
- Multi-client daemon, tab targeting, smart-selector fallback, isNew/nth,
  popup with Open Tabs + Pin + Disconnect, `--agent` flag, heartbeat + dedup.
