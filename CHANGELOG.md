# Changelog

## [Unreleased] — Security hardening (HTTP endpoints, auth protocol, co-installed-extension threat)

A multi-pass security hardening of the daemon's control plane. Four layers of
fix, each addressing a distinct threat in `SECURITY.md`. Test count: 151 → 167.

### SECURITY (authentication / authorization)

- **S1 — Constant-time token compare + auth token moved out of the URL query.**
  The WS upgrade previously compared the auth token with `!==` (timing leak) and
  the token traveled in `?token=` (logged in access logs / browser history). Now:
  `crypto.timingSafeEqual` (padded), and the token is sent via the
  `Sec-WebSocket-Protocol` subprotocol (`bc-auth.<token>`). `?token=` stays as a
  legacy fallback for already-installed extensions.
- **S2 — Per-session rate limiting.** A `BC_RATE_LIMIT_PER_MIN` budget
  (default 120) caps tool calls per agent over a rolling 60s window. Protects
  the browser from a runaway agent (infinite click/type loop). Set to 0 to
  disable.
- **S3 — HTTP endpoints no longer leak the auth token to any web page.** The
  daemon served `/pair` (which returns the token), `/status`, `/kill` with
  `Access-Control-Allow-Origin: '*'` and no Origin check on the HTTP path (only
  the WS upgrade checked Origin). Any site open in a tab could `fetch('/pair')`
  and read the token. Fixed: a single Origin gate (`isAllowedOrigin`) now runs
  upstream of all HTTP routes; CORS reflects only the pinned extension origin.
- **S4 — Exact-match extension-ID pin + enrollment secret (closes the
  co-installed-extension threat).** Two residual gaps remained after S3:
  (a) the Origin check was a substring match (`startsWith('chrome-extension://')`),
  so any *other* extension co-installed on the same machine passed it; (b) even
  with an exact-match pin, a hostile extension that reached the daemon *first*
  (winning the TOFU first-contact race) would get pinned, obtain the token via
  `/pair`, and gain full MCP control. **Fixed:** the daemon pins the first
  extension Origin it sees and exact-matches thereafter (closes gap a), AND
  every HTTP endpoint now requires an out-of-band **enrollment secret**
  (`X-BC-Enrollment` header) that `/pair` itself cannot bootstrap — so a hostile
  extension that wins the pin still cannot get the token without the secret
  (closes gap b). The secret is generated at
  `~/.browser-controller/enrollment.json` (0600), printed by
  `npx browser-controller`, and pasted once into the popup.

### BREAKING

- **Enrollment secret is now mandatory.** Upgrading users will see the popup
  "disconnected" until they paste the secret (from `npx browser-controller`
  output) into the new "Enrollment Secret" field. One-time UX cost to close the
  first-contact race; documented in `SECURITY.md`.

### ADDED

- `.env.example` documenting all environment variables (incl. new
  `BC_RATE_LIMIT_PER_MIN`).
- `SECURITY.md` rewritten: honest "Security Model" + "Known Limitations" +
  residual-attack analysis.
- 16 new tests (subprotocol auth, HTTP origin gate, exact-match pin,
  enrollment gate, rate limiting).

## [2.3.0] — 2026-08-01 — Runtime correctness fixes (hash-nav, cancel, evaluate)

Three runtime bugs found by driving a Vue SPA (Whatomate) end-to-end through
the MCP and observing hangs / nulls / stuck tabs. All verified live in the
running browser. Test count: 143 → 151 (all green).

### CRITICAL (correctness bugs)

- **C1 — `browser_navigate` hung ~55s on hash-only routes.** A hash-only
  change (e.g. `/login` → `/login#section`) does **not** reload the document,
  so Chrome never fires `tabs.onUpdated` `complete` and the wait timed out at
  the full call budget. **Spec:** a navigation whose target differs from the
  current URL only in `hash` must resolve once `chrome.tabs.update` settles,
  without waiting for a `complete` event that will never come. **Fix:**
  extracted a pure, tested helper `isHashOnlyChange(fromUrl, toUrl)`
  (`extension/utils/navigation.js`) that compares protocol/host/port/pathname/
  search (equal) and hash (different); `handleNavigate` calls it and skips the
  `onUpdated` listener for hash-only changes. **Verify:** runtime 55s → 512ms;
  6 unit tests cover hash-only, pathname-differs, query-differs, host-differs,
  identical, and invalid-input cases.

- **C2 — In-flight tool calls weren't cancelled when the daemon aborted a
  client.** The bridge rejected the caller's promise on abort/timeout but
  never told the extension, so the handler kept running and held the per-tab
  `TabMutexMap` queue — every later call on the same tab blocked behind a
  dead request for its full budget. **Spec:** when the daemon aborts a call
  (client disconnect, timeout, or `/kill`), the extension's in-flight handler
  for that call id must abort promptly and release the tab. **Fix (3 layers):**
  (A) `bridge.ts` sends a new `sendControl('cancel', { id })` on the abort and
  timeout paths before rejecting; (B) `background.js` keeps an
  `activeControllers: Map<id, AbortController>`, registers each in-flight call,
  and a `cancel` control-message handler aborts it; (C) `handleNavigate`
  races its `onUpdated` wait against the signal and `handleRunAction` drops a
  result computed after abort. `dispatch()` threads `signal` through to
  handlers. **Verify:** tab reusable in 4ms after abort (was blocked until the
  handler finished); 2 new bridge tests prove cancel is forwarded on both
  timeout and abort. **Backward compatible:** the `cancel` control message is
  opt-in — an old extension ignores it; an old bridge never sends it.

- **C3 — `browser_evaluate` returned `null` for every expression.** Even
  `"hello"` and `42` came back null. **Root cause:** Manifest V3
  `chrome.scripting.executeScript` with `world: 'MAIN'` + an async `func` that
  `eval`s the user expression loses the resolved value across the world
  boundary (the async-IIFE result is dropped by structured clone —
  crbug 1304272). **Fix:** `handleEvaluate` now serializes the value to a JSON
  string **inside** the MAIN world (`{ok, json: JSON.stringify(value)}`) and
  parses it back in the background — a plain string survives the structured
  clone reliably. Errors surface as `{ok:false, error}` instead of a hung
  promise. **Verify:** all expression types (string, number, DOM reads,
  `await fetch`, objects) now return real values. No test change needed — the
  fix is in the page-world serialization, exercised by every live call.

### Docs
- README: `browser_evaluate` note (null-return fix), `browser_navigate` (hash).
- ARCHITECTURE: invariant #4 expanded (cancel now forwarded to extension), test
  count 115 → 151, new extension point for cancellation.

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
- Registration logic extracted to `register-tools.ts` and covered by integration tests over `InMemoryTransport` (both modes: full + progressive disable/enable/list_changed)
- Docs updated: README config table, agent-config rules/skill, llms.txt (tool list was stale at 17; actual is 22 + meta)

### Other improvements
- `browser_run_action`: dual mode — accepts both tool wrappers AND plain JS expressions/IIFEs
- Popup: full design system (tokens, spacing scale, state vocabulary, anti-ban guards)
- Tab locks keyed by agentName (survives reconnect churn)
- LaunchAgent auto-start for daemon (launchd, macOS)
- Locks auto-release when owning agent disconnects

Test count: 115 → 143 (all green)

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
