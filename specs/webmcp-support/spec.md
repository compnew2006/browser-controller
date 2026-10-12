# Spec — WebMCP support (`browser_webmcp_list` / `browser_webmcp_call`)

> **Revision 2 (2026-10-11).** This revision follows `review.md` (verdict REJECT: 1 BLOCKER,
> 8 MAJOR, 12 MINOR) and the S0 probe. Every finding is folded in below. Section
> "Changes from revision 1" maps finding → change.

## Header (LOCKED)

**Stack (detected from root markers):**
- MCP server and daemon: strict TypeScript (`mcp-server/tsconfig.json`), zod `^4.6.5`.
- Chrome extension: Manifest V3, plain JS (`extension/`). Handlers are dispatched by
  `extension/lib/router.js`.
- Tests: Vitest (`tests/**/*.test.ts`). CI runs `npm run test:coverage`.

**Real commands:**
- `npm run build`
- `npm run typecheck`
- `npm run lint`
- `npm test`
- `npm run test:coverage`

**Tooling this session:**
- graphify is LIVE. `explain` and `affected` were run on `handleEvaluate`, `dispatch`,
  `allTools`, `toolMap` and `cdpEvaluate`.
- grep covered what the graph does not model: `HANDLERS`, `dispatchedTools`, `TOOL_GUIDANCE`
  and the capability lists.
- Two independent probes against real Chrome 155.0.8059.39: S0 (the implementer) and the
  reviewer. Both used headless Chrome with a temporary profile. Neither touched the user's
  profile.

**Scope:**
- New files: `extension/lib/webmcp-page.js`, `extension/handlers/webmcp.js`,
  `mcp-server/src/tools/webmcp.ts`, `tests/extension-webmcp.test.ts` and
  `scripts/smoke-webmcp.mjs`.
- Extended files:
  - `tests/fixtures/webmcp-demo.html`;
  - registrations in `router.js`, `gif.js`, `tools/index.ts`, `meta.ts`, the two `protocol`
    files and `registry.test.ts`;
  - the `shortcuts.ts` save guard plus its test;
  - one `package.json` script (`smoke:webmcp`);
  - docs.
- No manifest permission changes, no dependency changes, no version bump.

---

## Requirement

> Arabic original: "طيب انا ازاي ابادر اني اخلي Browser Controller بيدعم العمل مع المواقع اللي مدمج فيها WebMCP" … "نفذ بطريقة specs"

Pages that adopt WebMCP register tools in JavaScript, either imperatively with
`document.modelContext.registerTool(...)` or declaratively with `<form toolname …>`.
Browser Controller must let an agent:
- discover those tools in a specific tab;
- call them by name with structured input, safely.

Pages without WebMCP, and every existing tool, must behave exactly as before.

### API facts (verified)

Sources: spec `index.bs`, Chrome's imperative and declarative docs, and the real-Chrome probes.

**Entry point**
- `document.modelContext` exists in a SecureContext (`localhost` qualifies) when WebMCP is
  enabled (origin trial, `chrome://flags/#enable-webmcp-testing`, or
  `--enable-features=WebMCP`).
- Chrome 155 exposes `getTools`, `executeTool`, `registerTool` and `ontoolchange`.
  `navigator.modelContext` is absent.

**`getTools()`**
- Returns tools from the top document and its same-origin descendants, sorted by name.
- Each entry has: `name`, `title` (`""` when unset), `description`, `inputSchema` (an object),
  `origin`, `window` (a WindowProxy: circular, never serializable) and, only when declared,
  `annotations`.
- Same-origin duplicates in different frames report identical `origin`.
- Declarative `<form toolname tooldescription>` tools are included. Their schema is derived
  from the inputs, and they have no annotations.

**`executeTool(tool, inputObject, {signal})`**
- Input:
  - must be an object; a JSON string is already rejected in 155 with
    `TypeError: invalid input object`.
- Result:
  - resolves to a DOMString. A string tool result comes back raw, and an object comes back as
    JSON text.
- Errors:
  - a tool that throws rejects with a generic `UnknownError`. The spec hides the tool's own
    message on purpose.
  - abort rejects with `AbortError` within about 0.5 s, even when `execute` ignores the
    signal.
- Navigation:
  - a same-origin iframe navigation rejects with `UnknownError`;
  - a main-frame navigation makes the CDP call fail (`Inspected target navigated or closed` or
    `Cannot find context with specified id`);
  - `null` (per the Chrome docs) was never observed.

**Declarative tools**
- By default, invoking one fills the form and waits for the user to submit. With
  `toolautosubmit`, it submits and navigates.

**Annotations**
- 155 returns `readOnlyHint`, `consequentialHint` and `untrustedContentHint`. `debugging`
  arrives in 156.
- The browser enforces nothing for `consequentialHint`: `place_order` ran without any prompt.

**Transport**
- `cdpEvaluate` always uses `replMode: true`, and REPL mode does not unwrap a promise result.
  An expression `(async fn)(spec)` therefore returns `{}` *while the tool still runs*. A
  top-level `await` is required.
- The `chrome.scripting` eval fallback rejects a top-level `await`.

---

## LOCKED design decisions (revision 2)

1. **Transport: CDP only, `await` expression, JSON-string result.**
   - The handler repeats `handleEvaluate`'s three guards: `resolveTab`, the protected-URL check
     and `assertResponsive`.
   - It then calls `withCdp(tabId, send => cdpEvaluate(send, buildWebMcpExpression(spec),
     {timeoutMs, signal}))`.
   - The expression is `` `await (${webmcpPageRun})(${JSON.stringify(spec)})` ``.
   - The runner returns `JSON.stringify(result)`, so it comes back as a primitive in one round
     trip. The handler `JSON.parse`s it.
   - If the debugger cannot attach (DevTools open on the tab, another debugger, policy), the
     result is `WEBMCP_DEBUGGER_UNAVAILABLE`. There is no `chrome.scripting` fallback. The
     same precedent applies as `browser_run_action`.
   - The yellow "being debugged" banner shows while attached.
   - `cdpEvaluate` sends `userGesture: true`, so page tools run with transient user
     activation. This is documented.
2. **Two tools.**
   - `browser_webmcp_list` takes `{tabId, name?, waitMs 0–10000 = 0}`, `idempotent: true`.
   - `browser_webmcp_call` takes `{tabId, name, input?: object, frame?, confirm = false,
     timeout 1000–115000 = 30000}`. It is not idempotent, so it is never retried.
3. **Safety gates.** These run page-side against the live registration at call time.
   - An imperative tool with `consequentialHint: true` needs `confirm: true`. Otherwise the
     result is `CONFIRMATION_REQUIRED`.
   - A declarative tool with `toolautosubmit` (submits a form, no annotations) needs
     `confirm: true`.
   - A declarative tool **without** `toolautosubmit` is refused with
     `DECLARATIVE_NEEDS_USER`. The browser would fill the form and wait for a user submit that
     the agent-control shield blocks, so the call could only time out. The hint suggests
     `browser_fill_form` plus `browser_click`, or asking the user.
   - `browser_shortcuts save` rejects any `browser_webmcp_call` step whose params contain a
     literal `confirm: true`. A saved approval would be a standing approval. `"{{var}}"` is
     allowed, so confirmation is given at run time.
4. **Untrusted content, handler-owned.**
   - Both list and call results carry `untrustedContent: true` and a note.
   - Names, descriptions and schemas are page-authored too.
   - The handler sets the flag, not the page.
   - Per-tool `untrustedContentHint` is surfaced.
   - The handler validates the runner's result: known `status` and `code` values only, field
     types and lengths. The page's world can forge whatever the runner returns.
5. **Timeouts never look like a frozen tab.**
   - A page-side `AbortController` fires at `timeout`.
   - The evaluate budget is `timeout + 3 000` ms, at most 118 000, under `MAX_EVAL_TIMEOUT_MS`
     (120 000).
   - The transport timeout is 125 000.
   - If the evaluate budget still expires (a synchronously blocked main thread), the result is
     `WEBMCP_TIMEOUT` with a "main thread may be blocked" hint, plus a best-effort abort.
   - A router `cancel` triggers a best-effort abort evaluate (`action: "abort"`, `callId`,
     2 s budget).
   - Only `safeExec` marks a tab wedged, so this path cannot.
6. **Size budget, measured on encoded JSON.**
   - The runner keeps its JSON result at or under 90 000 chars, below `MAX_RESULT_CHARS`
     (100 000).
   - For list: `description` is capped at 2 000 chars and `title` at 200. A schema over 8 000
     encoded chars is omitted (`schemaOmitted: true`). Once over budget, the remaining schemas
     are omitted too, with a `schemasOmitted` count and a hint to use `name`.
   - For call: `output` is truncated so the encoded result fits (`outputTruncated`,
     `outputChars`).
   - If `cdpEvaluate` still truncates, the result is `WEBMCP_RESULT_TOO_LARGE`.
7. **Frames.**
   - Every tool reports `frame`: `"main"`, or an index path through `window.frames` such as
     `"0"` or `"1/0"`, plus `frameUrl`.
   - `call` takes `frame` to disambiguate. `AMBIGUOUS_TOOL` lists the candidate
     `{frame, frameUrl}`.
   - Same-origin frames only, which is `getTools()`'s default.
8. **Navigation is reported, never hidden, and never invites a blind retry.**
   - The runner snapshots `tool.window.document` before the call. After a rejection, if the
     document changed (or access throws), the result is `status: "unknown", navigated: true`.
   - If the result resolves `null`, it is `status: "completed", navigated: true`.
   - In the handler, CDP throws that match `Inspected target navigated or closed`,
     `Cannot find context with specified id` or `Execution context was destroyed` become
     `success: true, status: "unknown", navigated: true, code: "WEBMCP_NAVIGATED"`, with a note
     to re-read the page and not repeat the call blindly.
9. **Errors carry the browser's name and message.**
   - `canceled` is decided by `signal.aborted`, not by the error name.
   - Error mapping:

     | Browser error | Code |
     |---|---|
     | `TypeError` | `WEBMCP_INVALID_INPUT` |
     | `NotAllowedError` | `WEBMCP_NOT_ALLOWED` |
     | `NotFoundError` | `TOOL_NOT_FOUND` |
     | anything else | `WEBMCP_TOOL_ERROR` |

   - `WEBMCP_TOOL_ERROR` carries the hint that Chrome hides the tool's own exception, so the
     agent should check `browser_console`.
   - A `getTools()` `NotAllowedError` (permissions policy) means `supported: false`.
10. **`waitMs`** waits for `toolchange` with a 150 ms debounce, so a burst of registrations is
    caught. It polls every 250 ms as a safety net, up to the deadline.
11. **Protocol capability `webmcp`** is added to both capability lists, for diagnostics only.
    The bridge requires only `tool-dispatch` / `ping-pong`.

---

## Out of scope (Phase 2)

- The CDP `WebMCP` domain backend: cross-origin iframe tools, `backendNodeId` for declarative
  tools, live invocation events, `cancelInvocation`.
- Cross-origin tools via `fromOrigins`.
- A `chrome.scripting` fallback for when the debugger is unavailable.
- Skipping the lock shield during `browser_webmcp_call`. The shield blocks in-page
  confirmation UIs for the duration of the call; this is documented.
- A WebMCP hint in `browser_observe` / `browser_tabs list`.
- An in-browser user approval prompt for consequential tools.
- Changing `handleEvaluate`, `cdpEvaluate`, `safeExec` or the router's mutex and lock logic.
- A version bump, release, commit, or daemon restart.

---

## Success criteria (observable)

1. **List.** Returns `{supported: true, url, count, tools: [{name, title, description,
   inputSchema, origin, frame, frameUrl, annotations, declarative, autoSubmit}],
   untrustedContent: true, note}`. `name` filters to one tool.
2. **Wait.** `waitMs` catches a tool registered after load.
3. **No WebMCP.**
   - List gives `{supported: false, reason}` (no `isError`).
   - Call gives `isError` with `WEBMCP_UNAVAILABLE`.
4. **Call.** Runs `executeTool` with an object input and returns `{status: "completed", output,
   navigated: false, untrustedContent: true, note}`.
5. **Resolution.**
   - An unknown name gives `TOOL_NOT_FOUND` with `available`.
   - A same-name tool in two frames gives `AMBIGUOUS_TOOL` with `frames`.
   - `frame` selects the right one.
6. **Gates.**
   - Consequential tool or autosubmit form without `confirm`: `CONFIRMATION_REQUIRED`, and
     `execute` never runs.
   - Non-autosubmit form: `DECLARATIVE_NEEDS_USER`.
   - A shortcut saving `confirm: true` is rejected.
7. **Timeout.** Gives `isError` with `status: "canceled", timedOut: true` and
   `WEBMCP_TOOL_CANCELED`. The tab is not wedged, and the next call works.
8. **Tool error.** Gives `isError` with `status: "error"`, `errorName`, the browser's message
   and the console hint.
9. **Navigation.** A tool that navigates the main frame gives a non-error
   `status: "unknown", navigated: true` with code `WEBMCP_NAVIGATED`.
10. **Size.** A 120 000-char output comes back truncated (`outputTruncated: true`) and still
    parses.
11. **No debugger.** An attach failure gives `WEBMCP_DEBUGGER_UNAVAILABLE`.
12. **No regression.**
    - `build`, `typecheck`, `lint`, `test`, `test:coverage` and `git diff --check` all exit 0.
    - Drift guards are updated, not weakened.
13. **Docs.**
    - README Tool reference and the stale "31" counts updated.
    - `llms.txt` and the three `agent-config` files updated.
    - A negative grep finds no stale count.
14. **Real Chrome (automated).** `npm run smoke:webmcp` launches an isolated headless Chrome
    and drives the **real** handler, runner and `cdpEvaluate` code over CDP against the
    fixture, covering criteria 1–11. End-to-end through the daemon and extension stays
    user-gated (daemon restart, extension reload).

---

## Revision 2.1 — re-review fixes (verdict APPROVE WITH CHANGES, 5 MINOR)

- **N1.** The spec is embedded as
  `` `await (${fn})(JSON.parse(${JSON.stringify(JSON.stringify(spec))}))` ``.
  - An object literal would treat a `__proto__` key in `input` as a prototype and silently
    drop it.
  - T1 adds a `__proto__` round-trip case.
- **N2. Navigation outcomes.**

  | When | Result |
  |---|---|
  | During a call (main frame: CDP throw; iframe: document changed) | `success: true, status: "unknown", code: "WEBMCP_NAVIGATED"`. The note says "navigated or closed: re-read the page, do not repeat the call blindly" |
  | During a list | An error `WEBMCP_NAVIGATED` that says to re-run `browser_webmcp_list`, which is safe to repeat |

  - The `browser_webmcp_call` description says a batch keeps running after an unknown
    outcome.
- **N3. Frame selection.**
  - Every call result carries the resolved `frame` and `frameUrl`.
  - `call` also accepts an optional `frameUrl`. If the tool at `frame` now lives at another
    URL, the result is `FRAME_CHANGED` and nothing runs.
  - `frame` is validated with `^(main|\d+(\/\d+)*)$`.
- **N4.** A CDP attach that times out (`timed out (page not responding)`) is
  `WEBMCP_PAGE_UNRESPONSIVE`. Only real attach refusals are `WEBMCP_DEBUGGER_UNAVAILABLE`.
- **N5.** `npm run smoke:webmcp` with no Chrome binary exits with code 2 and prints
  "Chrome not found (set CHROME_PATH)". It never passes silently, and it is not part of
  `npm test` or CI.
- **Approval.** Revision 2 changes the public schema (`frame`, `frameUrl`, list `name`, new
  codes) and was implemented on the user's standing "نفذ بطريقة specs" instruction. Nothing is
  committed. The user is asked to confirm or veto the revised decisions in the session
  report.

## Revision 2.2 — audit fix loop

The audit verdict was FAIL: 1 BLOCKER, 1 MAJOR, 8 MINOR. All findings are fixed and
re-verified.

- **B1. Shadow-root forms bypassed the gates.** Chrome registers `<form toolname>` inside open
  **and closed** shadow roots, and the light-DOM search missed them.
  - The runner now searches the light DOM plus open shadow roots, one pass per document.
  - The handler first scans the pierced DOM over CDP: `DOM.getDocument({depth: -1, pierce:
    true})`, the same call `ax-snapshot.js` uses. This sees closed roots and same-process
    frames. The result is passed as `formHints` (`{name, autoSubmit, documentURL}`).
  - If either source finds a form, the tool is declarative. When several same-name forms
    exist, `autoSubmit` is true only if all of them have it.
  - **Fail closed:** if the scan fails (5 s timeout or error), `call` refuses with
    `FORM_SCAN_FAILED`, and `list` reports `formScan: "failed"`.
- **M1. Output truncation.** The runner now finds the largest prefix whose *encoded* result
  fits, by binary search, instead of estimating.
- **m1. Shortcuts.** `run` re-checks after substitution: a step that resolves to
  `browser_webmcp_call` with a *saved* `confirm: true` is refused, which covers templated tool
  names. A `confirm` supplied through `vars` is still that run's own decision.
- **m2. Untrusted content.** Every call result carrying page text (refusals, canceled, error,
  unknown) now has `untrustedContent: true` and the note.
- **m3. Forgery hardening.**
  - The error-code lookup is a `Map`, so `constructor` / `__proto__` names cannot resolve.
  - Schemas pass only as plain objects within the runner's cap; otherwise they are omitted with
    `schemaOmitted: true`.
- **m4. Early abort.**
  - An abort that arrives before the call registers leaves a bounded tombstone, which the call
    checks right before `executeTool`.
  - A signal that is already aborted never reaches the page.
- **m5. `waitMs`.** A hard deadline timer that `toolchange` events never clear; the debounce is
  capped by the remaining time.
- **m6. Caps.** `available` is capped at 200 page-side and handler-side; `frames` at 100.
- **m7.** README lists `browser_webmcp_list` among the tools retried on timeout.
- **m8. SC14 amended.** The real-Chrome smoke covers SC1–SC10 (14 checks, including open and
  closed shadow-root forms). SC11 (no debugger) is unit-tested only: the smoke drives raw CDP,
  so Chrome's own `chrome.debugger` refusal wording cannot occur there.

## Revision 2.3 — re-audit fixes (verdict PASS WITH FINDINGS: 1 MAJOR, 5 MINOR)

- **R1. The form scan used a full DOM dump.** It now runs `DOM.getDocument({depth: 0})`, then
  `DOM.performSearch` with the CSS query `form[toolname]`.
  - A call uses `form[toolname="<its name>"]`, so it only collects its own hints.
  - Each hit is read with `DOM.describeNode`. Only real `FORM` elements count, because a
    plain-text hit is ignored.
  - The owner document URL comes from `DOM.resolveNode` + `Runtime.callFunctionOn`, and is used
    only for frame association.
  - Cleanup: `DOM.discardSearchResults`, release of the object group, and `DOM.disable`.
  - The whole scan is bounded at 5 s and fails closed.
  - Verified in real Chrome 155: light DOM, open and closed shadow roots, and same-origin
    iframe forms are all found.
- **R2. The cap failed open.** More hits than `MAX_FORM_HINTS` (500) now returns `null`: calls
  are refused with `FORM_SCAN_FAILED`, and the list shows `formScan: "failed"`.
- **R3. A form in another frame blocked an imperative tool.** When no hint sits in the tool's
  own document, hints that sit in the document of *another same-name tool* are ignored.
  - Verified in real Chrome: the main frame's imperative `dup_tool` runs, and the iframe's
    form `dup_tool` returns `DECLARATIVE_NEEDS_USER`.
- **R4. Transport timeouts.** `browser_webmcp_list` 20 s → 25 s; `browser_webmcp_call`
  125 s → 130 s. Both now cover the form scan. The README timeout table lists both.
- **R5. Docs.** `FORM_SCAN_FAILED` and `formScan: "failed"` are documented in the tool
  descriptions, README and `AGENTS.md`. The message suggests the regular tools if the failure
  persists.
- **R6. Untrusted flags.** The list `supported: false` reason, `WEBMCP_UNAVAILABLE` and
  `WEBMCP_PAGE_ERROR` now carry `untrustedContent: true`.
- **Threat model (documented).** The gates enforce what an *honest* page declares
  (`consequentialHint`, form autosubmit). A hostile page can always register an unannotated
  imperative tool that does the same thing, so these gates are a safety net for real sites, not
  a defence against a malicious page.

## Changes from revision 1

| Finding | Change |
|---|---|
| B1 replMode / fallback | D1: CDP only, `await` expression, JSON-string result |
| M1 throws | D8 handler try/catch mapping. Other throws (TAB_WEDGED, protected, gone) propagate unchanged |
| M2 null never | D8 document snapshot in the runner. `null` branch kept |
| M3 origin | D7 `frame` |
| M4 error message | D9 |
| M5 budget | D6 |
| M6 declarative | D3 gates, list fields, now in scope |
| M7 untrusted list | D4 |
| M8 tests | Real `cdpEvaluate` in handler tests, AsyncFunction round-trip, automated real-Chrome smoke (SC14) |
| m1 facts | API facts above |
| m2 counts | SC13 |
| m3 shortcuts | D3 |
| m4 timeout | D5 |
| m5 forgery | D4 |
| m6 debounce / NotAllowed | D10, D9 |
| m7 ordering | tasks.md |
| m8 coverage | SC12 |
| m9 shield | Out of scope note |
| m10 userGesture | D1 |
| m11 fixture | tasks T9 |
| m12 global | Moot: no scripting fallback |
