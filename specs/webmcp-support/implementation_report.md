> **Status: superseded (2026-10-27).** The WebMCP feature was removed in Browser Controller 3.0 (commit `9e40798`; `CHANGELOG.md` lists `browser_webmcp_list` and `browser_webmcp_call` as removed). No `webmcp` text remains in `extension/` or `mcp-server/src`. Statements below that say "implemented" describe the 2.x code only. The body is kept for history. See finding F8-4 in `docs/audit/09-feature-architecture-review.md`.

# Implementation Report — WebMCP support (revision 2.3)

## Header

- **Edit primitives.**
  - Native `Edit` / `Write` for source, tests and specs.
  - One Python string-replace script for the README / `llms.txt` / `agent-config` doc edits.
    It asserted that each anchor occurred exactly once.
- **Tools this session.**
  - graphify: LIVE. Used for `explain` / `affected` before the plan, and `update .` after the
    code.
  - grep: covered what the graph does not model (`HANDLERS`, `dispatchedTools`,
    `TOOL_GUIDANCE`, capability lists).
  - Real-Chrome probes: isolated headless Chrome 155.0.8059.39 with a temporary profile and
    `--enable-features=WebMCP`. Run three times: S0, the S0 follow-up for frames and
    declarative forms, and the automated smoke. The user's Chrome profile and flags were never
    touched.
  - An independent reviewer subagent wrote `review.md`: REJECT, then APPROVE WITH CHANGES.
- **Baseline.**
  - Branch `main` at `e2a7348`, clean working tree at session start.
  - Nothing is committed or staged.
- **Files changed (tracked):** 15 files, +88 / −8 (`git diff --stat`).
- **New files:**

  | File | Lines |
  |---|---|
  | `extension/lib/webmcp-page.js` | 323 |
  | `extension/handlers/webmcp.js` | 303 |
  | `mcp-server/src/tools/webmcp.ts` | 44 |
  | `scripts/smoke-webmcp.mjs` | 288 |
  | `tests/extension-webmcp.test.ts` | 569 |
  | `tests/fixtures/webmcp-demo.html` | 125 |
  | `tests/fixtures/webmcp-frame.html` | 24 |
  | `specs/webmcp-support/*` | — |

- **Not changed:**
  - `extension/manifest.json` (no permission changes);
  - `handleEvaluate`, `cdpEvaluate`, `safeExec`, and the router mutex/lock logic;
  - dependencies and versions.

## Process record (spec → plan → review → tasks → implement → audit)

1. **Plan revision 1** was written after graphify exploration.
2. **The user said "نفذ بطريقة specs".** `spec.md` and `tasks.md` revision 1 followed.
3. **S0 probe (real Chrome)** found the replMode issue: an async IIFE returns `{}` while the
   tool still runs. It also found that Chrome hides tool error messages and that the browser
   does not enforce `consequentialHint`.
4. **Independent review: REJECT.** 1 BLOCKER (the same replMode issue, also found
   independently), 8 MAJOR, 12 MINOR.
5. **Revision 2** of `spec.md`, `plan.md` and `tasks.md` addressed every finding (mapping
   table in `spec.md`). A second probe confirmed frame paths, declarative detection, autosubmit
   with `respondWith`, and one `toolchange` per registration.
6. **Re-review: APPROVE WITH CHANGES.** 5 new MINOR findings (N1–N5), folded in as revision 2.1.
7. **Deviation.** T1 runner tests were written while the re-review ran. They are tests only;
   production code (T2+) started after the re-review.
8. **Open item.** The reviewer asked for the user's sign-off on revision 2's public schema
   (`frame`, `frameUrl`, list `name`, new codes). It was implemented on the standing "نفذ"
   instruction and is reported to the user for confirm or veto. Nothing is committed.

## Per-task status

| Task | Status | Evidence |
|---|---|---|
| **T1** Runner tests (red) | DONE | `tests/extension-webmcp.test.ts`: the runner section and `buildWebMcpExpression` section, 25 tests. Observed red first: "Test Files 1 failed … no tests" (the module was missing) |
| **T2** Runner | DONE | `extension/lib/webmcp-page.js`: `webmcpPageRun` (self-contained; list / call / abort), `buildWebMcpExpression` (`await (fn)(JSON.parse("<spec>"))`, N1), `WEBMCP_LIMITS`. The 25 runner tests pass |
| **T3** Handler and wiring | DONE | `extension/handlers/webmcp.js`: `evaluateRunner` (three guards, then `withCdp` + `cdpEvaluate`, with the attach / unresponsive split per N4), `parseRunnerReply`, `sanitize*`, `handleWebMcpList`, `handleWebMcpCall`. `router.js:57-58` `HANDLERS`. `gif.js:17` `GIF_FRAME_TOOLS` |
| **T4** Handler tests | DONE | Same file, handler section, 19 tests. The real `cdp-session` + `cdpEvaluate` run against a mocked `chrome.debugger` whose `Runtime.evaluate` executes the expression as an AsyncFunction body. They also assert the `await` prefix and the budgets. The file has 44 tests, all passing |
| **T5** MCP tools | DONE | `mcp-server/src/tools/webmcp.ts` (zod schemas per D2: the `frame` regex, `timeout` ≤ 115000, `waitMs` ≤ 10000). `tools/index.ts:33,67-68`. `meta.ts:125-128` (`TOOL_GUIDANCE`). `tests/tools/registry.test.ts:24` |
| **T6** Shortcuts guard | DONE | `shortcuts.ts:125-132`, plus a new test in `tests/tools/shortcuts.test.ts`. It rejects a literal `confirm: true`; `"{{confirm}}"` is substituted per run as a boolean |
| **T7** Capability | DONE | `mcp-server/src/protocol.ts:18` and `extension/lib/protocol.js:10` both carry `'webmcp'` in the same position. `protocol-handshake.test.ts` passes |
| **T8** Fixture and real-Chrome smoke | DONE | The fixture was extended: a same-name iframe tool (`webmcp-frame.html`), `search_form` (no autosubmit), `subscribe` (autosubmit + `respondWith`), the `place_order` side-effect counter, and a never-returning `navigate_away`. `scripts/smoke-webmcp.mjs` plus `package.json` `smoke:webmcp`. 13/13 checks pass. With no Chrome it exits 2 (N5, verified with `CHROME_PATH=/nonexistent`) |
| **T9** Docs | DONE | README: a key-capability bullet, a WebMCP index table, and a Tool reference section. `llms.txt`, `AGENTS.md`, `SKILL.md` and `browser-controller.mdc` updated. Counts 31 → 33. `grep -c browser_webmcp` is above 0 in all 5 files. The stale-count negative grep finds none |
| **T10** Gate | DONE | See below |
| **T11** Graph, report, audit | DONE / pending audit | `graphify update .` rebuilt 1601 nodes and 3484 edges. `graphify explain handleWebMcpCall` shows the `router.js:58` edge and the handler internals. **Limitation:** `webmcpPageRun` only shows a `contains` edge, because it is used through `webmcpPageRun.toString()` inside `buildWebMcpExpression`, which the AST graph does not see. `audit.md` is to be written by an independent auditor |

## Fix loops after the independent audit

### Fix loop 1 — audit verdict FAIL (B1, M1, m1–m8) → spec revision 2.2

| Finding | Fix | Evidence |
|---|---|---|
| **B1** Shadow-root `<form toolname>` tools bypassed the confirm and needs-user gates. The auditor reproduced it in real Chrome: submits happened without `confirm` | Runner: light DOM plus open shadow roots, one pass per document. Handler: a CDP form scan that also sees closed shadow roots and frames, passed as `formHints`. A failed scan fails closed with `FORM_SCAN_FAILED` | Unit tests for open-root forms, closed-root hints and scan failure. Smoke check: `open_shadow_form`, `closed_shadow_form` and `closed_shadow_search` are gated, and `__shadowSubmits` stays 0 until `confirm` |
| **M1** Truncation kept 0 chars of escape-heavy output | Binary search for the largest prefix whose encoded result fits | Tests: `'"'`×120000 keeps more than 40 000 chars; a JSON text over 300 KB keeps more than 60 000 and is an exact prefix |
| m1 Templated tool name bypassed the shortcuts guard | Run-time check after substitution | `shortcuts.test.ts`: the `{{t}}` and `browser_webmcp_{{x}}` cases |
| m2 Some page text was not flagged | `UNTRUSTED` added to refusals, canceled, error and unknown | Handler tests assert `untrustedContent` |
| m3 Inherited-key lookup; schema passthrough | `ERROR_CODES` is a `Map`; plain-object schemas within the cap | Test: `constructor` / `toString` / `__proto__` map to `WEBMCP_TOOL_ERROR`; array and oversized schemas are dropped |
| m4 An early abort was lost | Bounded tombstone checked before `executeTool`; a pre-aborted signal short-circuits | Runner and handler tests: the tool never runs |
| m5 `waitMs` overran under a `toolchange` stream | Hard deadline timer | Test: 300 ms wait returns in under 900 ms under a 50 ms event stream |
| m6 Unbounded `available` / `frames` | Capped at 200 / 100 | Test: 250 tools give 200 names |
| m7 README retry list | `browser_webmcp_list` added | README |
| m8 SC14 said 1–11 | Amended: smoke covers SC1–SC10, SC11 is unit-tested | spec.md |

### Fix loop 2 — re-audit verdict PASS WITH FINDINGS (R1–R6) → spec revision 2.3

| Finding | Fix | Evidence |
|---|---|---|
| **R1** The form scan dumped the whole DOM (about 50 MB on a 150 K-node page) | `DOM.performSearch` with a CSS query: a call queries only its own name; `describeNode` keeps FORM elements only; cleanup ends with `DOM.disable`; bounded at 5 s | Handler test asserts `getDocument` at depth 0 only and the exact query. Smoke: closed-root and iframe forms found in real Chrome |
| **R2** Over 500 forms failed open | Over the cap returns `null`, which fails closed | Test: `searchCount 501` gives `FORM_SCAN_FAILED` and a list with `formScan: "failed"` |
| R3 A form in another frame blocked an imperative tool of the same name | Hints in another same-name tool's document are ignored | Runner test, plus smoke `dup_tool`: main runs, iframe returns `DECLARATIVE_NEEDS_USER` |
| R4 Timeout margins | 25 s list, 130 s call | `webmcp.ts`, README timeout table |
| R5 Undocumented codes | Tool descriptions, README, `AGENTS.md` | grep |
| R6 Unflagged reasons | `UNTRUSTED` on `supported: false`, `WEBMCP_UNAVAILABLE`, `WEBMCP_PAGE_ERROR` | Handler test |

**Threat model (now in `spec.md`).** The gates enforce what an honest page declares. A hostile
page can always register an unannotated imperative tool, so the gates are a safety net and not a
defence against a malicious page.

### Re-audit 2 — verdict PASS

R1–R6 were confirmed by re-running the reproductions through the real handler in isolated Chrome
155:

| Reproduction | Result |
|---|---|
| Form scan on a 150 K-node page | 28 ms, about 4 kB (was 1.06 s and 50 MB) |
| 520 decoy forms | Fails closed |
| Same-name `dup` in main and iframe | Main runs; the iframe returns `DECLARATIVE_NEEDS_USER` |

Two optional notes from that pass were also done:
- `cssString` now hex-escapes everything outside `[A-Za-z0-9_-]`. Test: a name with a quote and
  a space.
- A unit test covers the scan-timeout path: a search that never answers fails closed within its
  5 s budget.

## Real-Chrome evidence

**S0 probe, raw API on Chrome 155:**
- `document.modelContext` methods are `ontoolchange`, `executeTool`, `getTools` and
  `registerTool`.
- `navigator.modelContext` is absent.
- `getTools` keys are `description`, `inputSchema`, `name`, `origin`, `title` and `window`, plus
  `annotations` only when declared.
- `executeTool(echo, {message: "hi"})` returned `"echo: hi"`.
- A throwing tool rejected with `UnknownError` "Tool was executed but the invocation failed".
- A slow tool ignoring its signal rejected with `AbortError` after 502 ms.
- `place_order` (`consequentialHint`) ran with no prompt.
- String input rejected with
  `TypeError … invalid input object: value is not an object`.
- An `(async fn)()` expression under replMode came back as `{}`. With `await`, the value came
  back correctly.

**S0 follow-up:**
- Frame path: `echo` reported as `main` and `"0"`, with distinct `frameUrl`s.
- `search_form` was detected as `declarative` without autosubmit; `subscribe` as autosubmit.
- `subscribe` returned `"Subscribed a@b.co"` via `respondWith`.
- `search_form` was filled (`"abc"`) and waited until the abort.
- Two registrations fired two `toolchange` events.

**`npm run smoke:webmcp` (real handler code, after both fix loops):**
```
WebMCP smoke — Chrome/155.0.8059.39 (headless, isolated profile)

PASS  SC2   list waitMs catches late_tool (registered 1.5 s after load)  — count=1
PASS  SC1   list: shape, frames, declarative forms, untrusted flag  — 16 tools
PASS  SC3   no WebMCP (insecure context): list answers supported:false, call fails WEBMCP_UNAVAILABLE
PASS  SC4   call echo (main frame) with an input object  — echo: hi
PASS  SC4   call add_todo changes the page  — Added to-do: milk (total 1)
PASS  SC5   same name in two frames: AMBIGUOUS_TOOL, then frame "0" picks the iframe
PASS  SC5   unknown name: TOOL_NOT_FOUND with available names
PASS  SC6   consequential tool: refused without confirm (never ran), runs with confirm
PASS  SC6   declarative forms: needs-user refusal; autosubmit needs confirm, then returns respondWith()
PASS  SC6   shadow-root forms (open + closed) are declarative: gated, never submitted without confirm  — open + closed gated; confirmed run submitted once
PASS  SC6   a form in the iframe gates only the iframe tool, not the main-frame tool of the same name
PASS  SC7   timeout aborts a tool that ignores its signal; the tab keeps working  — 1005ms
PASS  SC8   a tool that throws: WEBMCP_TOOL_ERROR with the browser error name  — UnknownError
PASS  SC10  120 000-char output comes back truncated and parseable  — 89799 chars kept
PASS  SC9   main-frame navigation during a call: non-error unknown outcome

15/15 checks passed (SC11 "no debugger" is unit-tested only).
```

SC9 passes on Chrome's own CDP error. The smoke socket deliberately rejects with a different
message on close.

## Gate output (T10)

| Command | Result |
|---|---|
| `npm run build` | exit 0 |
| `npm run typecheck` | exit 0 |
| `npm run lint` | exit 0. A first run flagged `no-useless-assignment` in `webmcp-page.js`; it was fixed and the rerun was clean |
| `npm test` | exit 0. Test Files 50 passed (50), Tests 629 passed (629). Was 612 before the fix loops |
| `npm run test:coverage` | exit 0. All files 91.15 stmts, 81.77 branches, 97.56 funcs, 95.24 lines. Thresholds pass; the new files are outside `coverage.include` |
| `npm run smoke:webmcp` | exit 0 (15/15) |
| `git diff --check` | exit 0. Untracked new files were checked separately for trailing whitespace: none |

## Remaining limitations

- **User-gated, not done.**
  - Restarting the running daemon. It is an older build (2.2.0), the repo is 2.5.5, and other
    agents may be using it.
  - Reloading the unpacked extension.
  - Trying it in the user's own Chrome after enabling `chrome://flags/#enable-webmcp-testing`.
  - The extension-to-daemon end-to-end path is therefore covered by unit tests plus the CDP
    shim, not by a live daemon run.
- **Phase 2.** The CDP `WebMCP` domain (cross-origin iframe tools, invocation events), a
  `chrome.scripting` fallback when the debugger is unavailable, and skipping the shield during
  calls.
- **Tool errors.** Chrome hides a tool's own exception message, by spec design. Callers get
  the browser's generic error plus a `browser_console` hint.
- **The `confirm` gate** is an agent-side guard, not a user-approval UI.
- **Closed-root coverage depends on observed behaviour.** Closed-shadow-root form detection
  relies on `DOM.performSearch` piercing closed roots. That is an experimental CDP command and
  observed Chrome 155 behaviour, not a documented contract. Re-run `npm run smoke:webmcp` after
  each Chrome upgrade: its closed-root check catches a regression.
- **Graph refresh.** `graphify update .` was re-run after the final changes (1649 nodes, 3570
  edges). `scanDeclarativeForms` is linked from `evaluateRunner`.
