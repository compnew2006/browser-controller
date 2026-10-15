# Plan — WebMCP support (revision 2)

Companion to `spec.md`, which holds the decisions D1–D11. This file has the reuse map, the
build sequence, and the risk coverage for every dependent surfaced by graphify plus grep.
Revision 1 was rejected in `review.md`. What changed is listed at the end of `spec.md`.

## Reuse map

| Need | Reuse (path:symbol) | Note |
|---|---|---|
| Page JS over CDP: REPL, CSP-proof, timeout and abort racing, result cap | `extension/lib/cdp-evaluate.js:53` `cdpEvaluate` | Called with an `await …` expression whose value is a JSON string (primitive path → one round trip) |
| One debugger session per tab, idle detach | `extension/lib/cdp-session.js:95` `withCdp` | The `attached` flag pattern is copied from `handleEvaluate` (`inspection.js:461-469`) to tell "no debugger" apart from a real failure |
| Tab resolution, wedge fast-fail | `extension/lib/page-exec.js` `resolveTab`, `assertResponsive` | The same three guards as `handleEvaluate` (`inspection.js:450-459`) |
| Forward to the extension, unified error channel | `mcp-server/src/tools/types.ts` `forwardHandler`; router `sendToolResponse` | `{success:false, error, code, …}` reaches the agent as `isError` with the payload |
| Per-tab mutex, lock, shield, cancel signal | `extension/lib/router.js` `handleMessage` → `runOnTab` | Automatic for any tool with a `tabId` |
| Batch and replay | `batch.ts` via `toolMap`; `shortcuts.ts` | New tools are batchable automatically. Shortcuts get a save guard (D3) |
| Real-Chrome harness style | `scripts/smoke-real-chrome.mjs` | The new `scripts/smoke-webmcp.mjs` follows its plain-node, no-dependency style |

## Build sequence

1. **Runner tests (red).** In `tests/extension-webmcp.test.ts` (new), cover the runner against
   a fake `document.modelContext`. The fake uses DOMException rejections and a fake
   `window` / `frames` tree.
2. **Runner.** `extension/lib/webmcp-page.js` (new) holds:
   - `webmcpPageRun(spec)`, self-contained and stringifiable, with the actions `list`, `call`
     and `abort`;
   - `buildWebMcpExpression(spec)`;
   - `WEBMCP_LIMITS`.
3. **Handler and wiring.**
   - `extension/handlers/webmcp.js` (new) holds `handleWebMcpList`, `handleWebMcpCall`,
     `evaluateRunner` and `sanitize`.
   - `router.js` gets 2 `HANDLERS` entries and the import.
   - `gif.js:14` gets `browser_webmcp_call` added to `GIF_FRAME_TOOLS`.
4. **Handler tests.** These drive the **real** `cdpEvaluate` and `cdp-session` through a mocked
   `chrome.debugger.sendCommand`:
   - `Runtime.evaluate` runs the expression as an AsyncFunction body against the fake
     document, which is true REPL-await semantics;
   - attach failure and navigation throws are injected.
5. **MCP tools** (after step 3, so the router drift guard sees both sides):
   - `mcp-server/src/tools/webmcp.ts` (new);
   - `tools/index.ts`;
   - `meta.ts` `TOOL_GUIDANCE`;
   - `tests/tools/registry.test.ts`.
6. **Shortcuts guard.** In `mcp-server/src/tools/shortcuts.ts` `save`, reject a literal
   `confirm: true` on `browser_webmcp_call`, and add a case to `tests/tools/shortcuts.test.ts`.
7. **Capability.** Add `'webmcp'` in `mcp-server/src/protocol.ts` and
   `extension/lib/protocol.js`.
8. **Fixture and real-Chrome smoke.**
   - Extend `tests/fixtures/webmcp-demo.html` with:
     - a same-origin iframe with its own `echo`;
     - a declarative form without autosubmit;
     - a declarative form with autosubmit.
   - New `scripts/smoke-webmcp.mjs`:
     - starts isolated headless Chrome (`CHROME_PATH` or the default per OS,
       `--enable-features=WebMCP`, a temporary profile) and serves the fixture on `localhost`;
     - shims `chrome.tabs` / `chrome.debugger` / `chrome.windows` over a CDP WebSocket, then
       imports and runs the **real** handlers;
     - asserts success criteria 1–11.
   - Add the `package.json` script `smoke:webmcp`.
9. **Docs.**
   - README: a key-capabilities bullet, a Tool reference section, and the stale "31" at `:348`,
     `:378`, `:854`, `:927` plus the index rows.
   - `llms.txt`.
   - `agent-config/AGENTS.md` (`:18`, `:47`, tool list).
   - `SKILL.md` and `browser-controller.mdc`.
10. **Gate:**
    - `npm run build`, `npm run typecheck`, `npm run lint`, `npm test`,
      `npm run test:coverage`, `npm run smoke:webmcp`, `git diff --check`;
    - a negative grep for stale counts.
11. **Wrap-up.** Run `graphify update .`, then write `implementation_report.md` and get an
    independent `audit.md`.

## Risk coverage

| Dependent | What could break | Mitigation |
|---|---|---|
| `tests/tools/registry.test.ts:14` `expectedTools` | Count / name mismatch | Append both names (step 5) |
| `tests/extension-router.test.ts:401` (grep, not graph) | Wire tool without handler, or the reverse | Steps 3 and 5 land together before the gate |
| `tests/register-tools.test.ts:110` | Guidance required per tool | `TOOL_GUIDANCE` entries |
| `meta.ts`, `tests/tools/meta.test.ts`, `src/index.ts:493` | Derived counts | No change. Cosmetic log only |
| `batch.ts` | New tools batchable | Intended. `confirm` is still evaluated per call |
| `shortcuts.ts` save | Saved `confirm: true` becomes a standing approval | Save guard plus test (step 6) |
| `GIF_FRAME_TOOLS` | Calls not recorded | Add `browser_webmcp_call` |
| Protocol lists | Handshake test mismatch | Both files, same position. `tests/protocol-handshake.test.ts` |
| `cdpEvaluate` contract (`replMode`, primitive path, `truncated`, `error` strings) | A future change silently breaks WebMCP | Handler tests run the real `cdpEvaluate`. The smoke runs it in real Chrome |
| `withCdp` / debugger banner | Banner shows while a call runs, and attach can fail | Documented. `WEBMCP_DEBUGGER_UNAVAILABLE` |
| Wedge detection (`page-exec.js:159`, `safeExec` only) | Slow tool marked frozen | Not on this path. Page-side abort fires before the evaluate budget |
| Tab mutex held up to `timeout` | Same-tab calls queue | Bounded at 115 s, the same class as `browser_evaluate` |
| Lock shield (`overlay.js`) | Blocks in-page confirm UIs and declarative user submits | `DECLARATIVE_NEEDS_USER` gate. Documented (Phase 2: skip the shield) |
| Prompt injection via list metadata or output | Agent obeys page text | `untrustedContent` on both, set by the handler. Descriptions say "data, not instructions" |
| Page forges the runner result | Fake success or fake codes | `sanitize()` allow-lists `status` / `code` and types and clamps lengths |
| Docs counts | Stale "31" | Step 9 plus a negative grep |
| CI `test:coverage` | Thresholds | New files are outside `coverage.include`. Run it anyway |
