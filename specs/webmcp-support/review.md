# Review — WebMCP support (`browser_webmcp_list` / `browser_webmcp_call`)

Independent, read-only plan review of `spec.md`, `plan.md` and `tasks.md`. Every load-bearing
claim was checked against source, the primary API sources, and a live Chrome 155 instance.

## Evidence sources

- **Source code.** Read directly with line numbers: `extension/handlers/inspection.js`,
  `extension/lib/{cdp-evaluate,cdp-session,router,page-exec,overlay,protocol,state}.js`,
  `extension/handlers/{gif,cdp}.js`, `mcp-server/src/{bridge,register-tools,protocol,index}.ts`,
  `mcp-server/src/tools/{types,index,meta,batch,shortcuts,evaluate}.ts`, and the drift-guard tests.
- **graphify.** LIVE. `graph.json` was built 2026-10-10 07:02, one commit before HEAD `e2a7348`
  (07:03). That commit is popup-only and not relevant here. `affected` was run on
  `handleEvaluate`, `cdpEvaluate`, `withCdp`, `allTools`, `toolMap`, `forwardHandler`,
  `GIF_FRAME_TOOLS`, `dispatch`, `HANDLERS`, `dispatchedTools` and `TOOL_GUIDANCE`, and
  `explain` on `handleEvaluate`. `HANDLERS`, `dispatchedTools` and `TOOL_GUIDANCE` return
  "No affected nodes", and `EXTENSION_PROTOCOL_CAPABILITIES` has "No unique node match", so
  `grep` covered those.
- **serena / codebase-memory-mcp.** Not used. Native Read and grep were sufficient.
- **WebMCP spec.** `webmachinelearning/webmcp/index.bs` at HEAD `d0e4e0e0` (2026-10-09), fetched
  with `gh api`.
- **Chrome docs.** `developer.chrome.com/docs/ai/webmcp/imperative-api`, fetched 2026-10-11.
- **Empirical probe (new evidence).**
  - Setup: an isolated headless Chrome **155.0.8059.39** (the installed build) with a throw-away
    `--user-data-dir` in the session scratchpad and `--enable-features=WebMCPTesting`.
    `--enable-features=WebMCP` also works. It was driven over raw CDP (`Target.attachToTarget`
    flatten, `Runtime.evaluate` with the exact `cdpEvaluate` parameters) against a fixture served
    from `http://localhost`.
  - Isolation: the user's Chrome profile, flags and the repo were not touched. The probe process
    and its profile were removed afterwards.
  - Effect on the plan: no user step was needed, so the plan's reason for demoting S0
    (plan.md:91-94) does not hold.

---

## 1. Primary API facts — CONCERN

Most facts are right. Four are wrong or incomplete in ways that change the design.

| Claim (spec.md:48-67 / plan.md:9-19) | Primary source | Chrome 155 probe | Verdict |
|---|---|---|---|
| `document.modelContext` needs SecureContext; `localhost` qualifies | index.bs:645, 662 `[SecureContext]` | `isSecureContext:true`, `typeof document.modelContext === "object"`; `"undefined"` without the feature | OK |
| `getTools()` = this doc + same-origin descendants | index.bs:889-908 walks the **top-level** frame tree and keeps same-origin docs (or `fromOrigins`) | main + same-origin iframe tools returned, sorted by name | OK (top-frame caller) |
| `RegisteredTool {name,title?,description,inputSchema?,window,origin,annotations?}` | index.bs:1289-1299; `title` defaults to `""` (926-927) | keys exactly as listed; `title:""` when unset; `JSON.stringify(getTools())` throws "circular structure… property 'window'" | OK; `window` must be stripped (plan does) |
| `executeTool` resolves to the stringified result | IDL `Promise<DOMString>` (666) | object result → JSON text; a **string** result comes back raw (`plain "quoted" text`, not JSON-quoted) | OK; `output` is not always JSON |
| `executeTool` resolves `null` on navigation | Chrome docs say so; the spec never resolves null — target unload rejects (264-266, 381-384) | **null never observed.** Same-origin iframe navigates → rejects `UnknownError` "…unknown transient reason". Main frame navigates → the CDP call fails with `Inspected target navigated or closed` (9 ms), or the result fetch fails with `Cannot find context with specified id` | **WRONG / incomplete** (see §6) |
| Rejects on abort even if `execute` ignores the signal | index.bs:316-320, 1023-1027 | `AbortError` after 302 ms on a tool that ignores its signal; `TimeoutError` with `AbortSignal.timeout` | OK |
| Input is passed as an object (JSON string deprecated in 155) | IDL `optional object inputObject` | a JSON string is **already rejected**: `TypeError … invalid input object: value is not an object` | OK (plan already passes an object) |
| `toolchange` fires on add/remove | index.bs:404-423 | fired once per registration, including same-origin child-frame registrations | OK |
| Annotations: `readOnlyHint`, `untrustedContentHint`, `consequentialHint`, `debugging` | index.bs:1149-1154 | 155 returns only the first three. Chrome docs: `debugging` is "available from Chrome 156" | Minor: say "debugging from 156" |
| A tool that throws → `status:"error"` **with its message** (spec.md SC8) | index.bs:270-273, 1099-1101: tool errors are deliberately **not exposed**; spec HEAD (`b206dae8`, 2026-10-08) uses `OperationError` | `UnknownError` "Tool was executed but the invocation failed…"; the tool's message is not visible | **WRONG** (see M4) |
| Declarative tools are Phase 2 (spec.md:119-121, plan.md:55-56, 162-164) | — | a `<form toolname tooldescription>` **is returned by `getTools()`** (schema derived from the inputs, **no annotations**) and is callable through `executeTool` | **WRONG** (see M6) |

## 2. Transport: reusing `handleEvaluate` — FAIL (BLOCKER)

What the plan builds:
- `buildWebMcpExpression` returns `` `(${webmcpPageRun})(${JSON.stringify(spec)})` ``
  (plan.md:105, tasks.md:44-45).
- That string is passed to `handleEvaluate`.

Why the CDP path breaks:
- The CDP path is `withCdp` → `cdpEvaluate` (inspection.js:460-466).
- `cdpEvaluate` always sends `replMode:true, awaitPromise:true, returnByValue:false`
  (cdp-evaluate.js:67-75).
- **In REPL mode, `awaitPromise` does not unwrap a promise-valued completion.** V8 wraps the
  REPL completion value so it is not treated as a thenable.
- Probe, with exactly these parameters, on `(async function run(spec){…})({"x":1})`: the result
  is `{type:"object", subtype:"promise", className:"Promise"}`. The same holds with
  `awaitPromise:false`.
- `cdpEvaluate` then serializes that Promise through `serializeThis` (cdp-evaluate.js:92-101).
  `JSON.stringify(Promise)` is `"{}"`, so `handleEvaluate` returns `{success:true, result:{}}`.

Why that is dangerous:
- **The tool still runs in the page.** In the probe, `navsync` did navigate the tab after CDP
  had already returned.
- So `browser_webmcp_call` would trigger the action, report a malformed result, and invite a
  retry. For a `confirm:true` consequential tool, that retry is a double purchase.

Why a single fix inside `handleEvaluate` does not work:
- Prefixing `await ` fixes CDP. The probe returned `{"x":1,"n":2}` for
  `await (async function…)(spec)`.
- But the `chrome.scripting` fallback runs `await eval(code)` (inspection.js:486-489). Eval'd
  code is a Script, where `await` is an identifier. Reproduced in Node:
  `ReferenceError: await is not defined`.
- The non-`await` form works only on the fallback. **No single expression string serves both
  paths, and `handleEvaluate` picks the path silently** (inspection.js:467-469).
- `extension/handlers/cdp.js:25-45` (run_action) works because it calls `Runtime.evaluate`
  without `replMode`. The probe confirmed: non-REPL `awaitPromise:true` returns the awaited value.

Secondary problems on the fallback path, even if it were reachable:
- `eval` is blocked by a strict page CSP.
- The poll loop ignores `signal` (inspection.js:499-510).
- A navigation leaves the poll spinning until the deadline: up to 118 s holding the tab mutex,
  then `'evaluate returned no result'`.
- The planned follow-up "abort evaluate" would overwrite the shared `window.__bcEvalOut`
  (inspection.js:485, 505).

## 3. `handleEvaluate` / `cdpEvaluate` return contract — FAIL

The plan treats the contract as `{success,result}` / `{success:false,error}` (plan.md:154,
tasks.md:65-67). The real contract is wider:

- **It throws.** Sources of throws:
  - `resolveTab` (page-exec.js:13-24);
  - the protected-URL check (inspection.js:452-454);
  - `assertResponsive` `TAB_WEDGED` (page-exec.js:129-131);
  - every CDP protocol error after attach, which is rethrown at inspection.js:468.
    `cdpEvaluate` has no catch around `send(...)`; its `try` at :66 has only a `finally`.
- **Navigation arrives as a throw, not as `{success:false}`.** Messages observed in the probe:
  `Inspected target navigated or closed` (from `Runtime.evaluate`) and
  `Cannot find context with specified id` (from the second round trip,
  `Runtime.callFunctionOn`, cdp-evaluate.js:92). T3's mapping never sees these, so the LOCKED
  decision 6 promise (`status:"unknown", navigated:true`, spec.md:107-110) cannot be met as
  written.
- **Other success shapes:**
  - `{success:true, result:null, type:"undefined"}` (cdp-evaluate.js:88);
  - a truncated *string* `result` with `truncated:true, fullLength` (:45-51, :99);
  - `{success:false, error:"aborted"}` (:77);
  - `{success:false, error:"evaluate did not finish within …ms (pass a larger timeout, max 120000)"}`
    (:79-80). That hint is misleading for a tool whose max is 115 000.

## 4. Timeout math and the `MAX_EVAL_TIMEOUT_MS` clamp — PASS (with notes)

- **Call path.** The maximum budget is 115 000 + 3 000 = 118 000. That is ≤
  `MAX_EVAL_TIMEOUT_MS` 120 000 (cdp-evaluate.js:12, 54), so the clamp never shortens the page
  abort. Transport is 125 000 (bridge.ts:506 via `toolTimeoutMs`). The thin-client backstop is
  210 s (mcp-server/src/index.ts:231-234).
- **List path.** The budget is `waitMs + 5 000` ≤ 15 000, against a 20 000 transport timeout.
  List is idempotent, so the bridge retries on timeout (bridge.ts:511, 520-522; `maxRetries`
  2 at :109). That is acceptable for a read.
- **Note: margin.** The transport window also covers mutex queueing, the shield (≤1.5 s,
  router.js:80-86) and CDP attach probes (≤5 s each, cdp-session.js:17-25). That leaves 7 s of
  margin, comparable to `browser_evaluate` (120 s vs 125 s). Acceptable.
- **Note: sync-blocked page.** If the page's main thread is blocked synchronously, the page-side
  abort timer cannot fire. Then `cdpEvaluate`'s extension-side timer wins (:57-59, 79-80). T3
  maps that to `WEBMCP_PAGE_ERROR`. It should map to a timeout or canceled status (m4).

## 5. Result cap and page-side truncation — CONCERN

How the cap applies:
- `MAX_RESULT_CHARS` is 100 000 (state.js:23).
- It is applied to the JSON of the **whole** runner result (cdp-evaluate.js:99), so the limit
  is on encoded length.

Gaps in the planned page-side limits (50 000 output chars, 8 000 chars per schema):
- **Escaping.** Escaping can roughly double `output` (`"` → `\"`; control characters → 6
  characters each). The 50 000 limit is on raw characters.
- **List size (realistic failure).** List has a per-schema cap but **no total budget and no
  description or title cap**. Twelve tools with ~8 KB schemas already exceed 100 000, so the
  *whole* list fails with `WEBMCP_RESULT_TOO_LARGE`. This is a realistic size for commerce
  sites.
- **Truncated schemas.** A "truncated" JSON schema string is a broken fragment. It should be
  replaced with `null` plus a flag, not cut.

## 6. Navigation during a call — FAIL

The plan's model ("`executeTool` resolves `null` → `navigated:true`; destroyed context →
`status:"unknown"`") does not match what Chrome 155 does:

- **Same-origin iframe navigates.** The promise **rejects** with `UnknownError`. This looks
  exactly like a tool that threw.
- **Main frame navigates.** `Runtime.evaluate` fails with `Inspected target navigated or closed`.
  A declarative `toolautosubmit` form instead let the evaluate resolve, and then
  `Runtime.callFunctionOn` failed with `Cannot find context with specified id`. Both arrive as
  **throws** (§3).
- **`null`:** never observed.
- **Recommendation:**
  - Keep the `null` branch.
  - Add the thrown-error mapping.
  - In the runner, capture `tool.window.document` before `executeTool`. If it changed after a
    rejection, report `navigated:true`. Same-origin windows are readable; the probe read
    `tool.window.location.href`.

## 7. Router integration — PASS

- **HANDLERS.** It is a static map (router.js:41-69). `dispatchedTools` (:72) is what the drift
  guard checks (tests/extension-router.test.ts:397-407). The handler signature
  `(params, sessionId, agentName, signal)` matches `dispatch` (:74-78).
- **Error channel.** `sendToolResponse` (:99-109) turns `{success:false,…}` into a wire failure
  that carries the payload as `result`.
  - `bridge.ts:411-418` attaches it as `err.result`.
  - `forwardHandler` (types.ts:126-142) returns it as `jsonError(payload)`, so `code`,
    `available` and candidate lists reach the agent verbatim.
  - A thrown handler error becomes a bare `{success:false,error}` (router.js:292-293, 309-311).
    `wrapHandler` then turns it into `isError` (register-tools.ts:98-109). No failure is hidden.
- **Mutex, lock and cancel.** A numeric `tabId` routes the call through `runOnTab` (:112-114,
  258-314). The cancel control message aborts `controller.signal` (:149-165). That signal is
  forwarded to the handler (:283) and on to `cdpEvaluate`'s abort race
  (cdp-evaluate.js:60-77).
- **Concurrent follow-up evaluate.** The per-tab CDP session is shared and refcounted
  (`busy`, cdp-session.js:95-105), so a concurrent follow-up abort evaluate is safe on the CDP
  path.
- **GIF.** Adding only `browser_webmcp_call` to `GIF_FRAME_TOOLS` (gif.js:14-18) is right.
  Frames are skipped on `success:false` (router.js:289).
- **Shield.** See §9.

## 8. Slow tool vs `TAB_WEDGED` — PASS

- The **only** writer of `wedgedTabs` is `safeExec`'s 8 s timer (page-exec.js:151-161; the grep
  for `wedgedTabs.set` has exactly one hit).
- `handleEvaluate` and `cdpEvaluate` never call `safeExec`. They only *probe* tabs that are
  already wedged (`assertResponsive`, page-exec.js:129-131).
- An async-slow tool leaves the main thread free, so even a concurrent out-of-mutex
  `executeScript` succeeds.
- Only a genuinely sync-frozen page can be marked wedged, and then only by a later call. That
  is correct behaviour.
- Spec SC7 is achievable on the CDP path: the probe saw the page abort reject at the timeout.

## 9. Safety design — CONCERN

Sound:
- `confirm` is honestly documented as an agent-side guard (spec.md:92-93, plan.md:66-68).
- The consequential check reads **live** annotations at call time (spec.md:89).
- Input goes as an object.
- `browser_webmcp_call` is non-idempotent, so it is never retried (bridge.ts:511, 523-524).

Gaps:
1. **List output is not labelled untrusted.** Tool names, titles, descriptions and schemas are
   page-authored text that the model reads as instructions-adjacent metadata. This is the
   primary prompt-injection vector, yet only *call* results get `untrustedContent:true`
   (spec.md:90-91).
2. **Declarative tools bypass the consequential gate.** They carry **no annotations** (probe:
   `annotations:null`).
   - `toolautosubmit` submits and navigates with no `confirm`.
   - Without autosubmit, `executeTool` fills the form (probe: `filled:"abc"`) and waits for a
     user submit. The lock shield blocks that submit: `pointer-events:auto` plus capture-phase
     listeners (overlay.js:50, 74, 88), shown for the whole call (router.js:279-281). The call
     can only time out.
3. **The shield blocks in-page confirmation.** It likewise blocks any imperative tool that asks
   the user to confirm in-page, which is a natural pattern for consequential actions.
4. **`confirm:true` can be persisted.** `browser_shortcuts save` stores params verbatim
   (shortcuts.ts:121-135) and `run` replays them through batch (:137-152). A saved
   `browser_webmcp_call {confirm:true}` becomes a standing approval. The risk table
   (plan.md:152) mentions batch, not shortcuts.
5. **The runner result is forgeable.** The runner executes in the page's MAIN world, where the
   page can patch `getTools`, `JSON`, `AbortController` and so on. The handler must validate the
   result shape and own the `untrustedContent` flag and note. T3 already adds the flag on the
   handler side; validation is missing.
6. **Transient user activation.** `cdpEvaluate` sends `userGesture:true` (cdp-evaluate.js:72),
   so page tools run with transient user activation (popups, downloads, Payment Request). This
   is comparable to `browser_click`, but should be documented.

## 10. Tool resolution and disambiguation — FAIL

- `AMBIGUOUS_TOOL` plus an `origin` parameter (spec.md:143-145, tasks.md:110-111) **cannot**
  disambiguate in this scope:
  - Only same-origin tools are returned (index.bs:905-908).
  - The spec says `origin` "is only meaningful when the tool is cross-origin… For same-origin
    tools, this is the same as … the caller's own origin" (index.bs:1324-1329).
- **Probe:** two `echo` tools (main frame and same-origin iframe) both report
  `origin:"http://localhost:<port>"`.
- **What can tell them apart:** `tool.window === window` (main frame) and
  `tool.window.location.href` (frame URL). Both were readable in the probe.

## 11. Blast radius and missed dependents — CONCERN

| Dependent | Found by | In plan? | Note |
|---|---|---|---|
| `tests/tools/registry.test.ts:14-31, 154-166` | graphify (`allTools`, `toolMap`) | yes (S5/T5) | Also enforces `timeoutMs` and a summary length of 10 < n < 80 |
| `tests/extension-router.test.ts:397-407` | grep | yes | Fails if T5 lands before T3; tasks.md:106 "Parallel-safe with T1–T4" is wrong (m7) |
| `tests/register-tools.test.ts:48, 110-111` | graphify | yes | Every tool needs non-empty `TOOL_GUIDANCE` |
| `tests/tools/meta.test.ts:36, 103` | graphify | yes ("no change") | Derived from `allTools` |
| `tests/protocol-handshake.test.ts:84` | grep | yes (T6) | `toEqual` of the two lists |
| `mcp-server/src/tools/batch.ts:8, 98-109` | graphify (`toolMap`) | yes | Automatic |
| `mcp-server/src/tools/shortcuts.ts:121-152` | grep (graphify misses the lazy `import('./index.js')` at :145) | **no** | Persists `confirm:true` (§9.4) |
| `mcp-server/src/bridge.ts:506, 511` (`toolTimeoutMs`, `isIdempotent`) | read | implicitly | Correct via registry |
| `mcp-server/src/register-tools.ts:138` | graphify | yes | No MCP tool annotations are emitted. "Clients can auto-approve list" works only through per-name allowlists (fine) |
| README "31" at :348, :378, :854, :927 + the "What It Can Do" index table (:378 ff.) | grep | **partly** | T7 adds only a bullet and a Tool-reference subsection |
| `agent-config/AGENTS.md:18, 47` ("31") | grep | **partly** | T7 grep `> 0` cannot catch stale counts |
| `llms.txt:13` | grep | yes | — |
| `tests/fixtures/webmcp-demo.html` | `ls` | T9 "new" | **Already exists**, untracked (created 14:57). Its `throws_tool` expects the message to surface (it won't, M4). It lacks a same-name iframe tool and a declarative form |
| `.github/workflows/ci.yml` runs `npm run test:coverage` (architecture-maintenance.test.ts:40-44) | read | **no** | T8 omits it (m8). The new files are outside `coverage.include`, so thresholds are unaffected |

No hidden tool-count guard exists elsewhere. `architecture-maintenance.test.ts` only caps three
named files at 600 lines.

## 12. Schemas (zod v4) — PASS (minor)

- The shapes follow repo conventions:
  - `requireTabId()` (types.ts:35-37);
  - the bounded timeout `.int().min().max().optional().default()` (evaluate.ts:13);
  - `z.record(z.string(), z.unknown())` (run-action.ts:18, batch.ts:67).
- The existing payload limits apply to `input` (register-tools.ts:7-64).
- Suggestions:
  - `name` could mirror the spec rule `^[A-Za-z0-9_.-]{1,128}$` (index.bs:744-747).
  - `origin` should be replaced (§10).

## 13. Test plan feasibility — CONCERN

- **T1 is feasible.** It runs the runner directly against a fake `document.modelContext`.
  - Node 22 has `AbortController`, `DOMException` and `crypto.randomUUID`.
  - Add a `globalThis.location`.
  - The fake must follow spec and Chrome semantics: reject with `signal.reason` on abort even if
    `execute` ignores it, and reject thrown tools with `DOMException(…,'UnknownError')`.
- **But no planned test can catch §2 or §3.** Taken together:
  - T1 never goes through REPL semantics. Its `eval` round-trip awaits the returned promise.
  - T4 replaces `handleEvaluate` with a mock (tasks.md:88), so it pins the handler's
    *assumptions*, not the real contract (plan.md:154 claims otherwise).
  - `tests/cdp-evaluate.test.ts` uses a fake `send`.
  - The only real check, T9, is user-gated or deferred.
- **Feasible fixes:**
  - Drive the real `cdpEvaluate` with the existing `fakeSend` pattern
    (tests/cdp-evaluate.test.ts:6-15) and `vi.mock('../extension/lib/cdp-session.js')`. Assert
    the exact `Runtime.evaluate` expression and params.
  - Emulate top-level await in the round-trip test with an `AsyncFunction` body
    (`return ${expr}`).
  - Make T9a a **non-user-gated gate**: isolated headless Chrome 155 with
    `--enable-features=WebMCPTesting`, a temp profile, raw CDP, and the real `cdpEvaluate` bound
    to that `send`. This review's probe did exactly that in seconds.

## 14. Scope and proportionality — CONCERN

- **Proportionate:**
  - two tools;
  - a page-side runner;
  - reuse of the router, error channel, mutex and cancel paths;
  - no manifest change;
  - a diagnostics-only protocol capability. This is consistent with the existing
    `observe-act-v2` and `tab-locks`, which nothing gates on (grep of `.capabilities` → only
    handshake validation, bridge.ts:323).
- **Under-scoped:** declarative tools (de facto in scope), frame disambiguation, the error-name
  mapping, the list size budget, and the docs counts.
- **Process:** S0 (plan.md:86-95) was demoted because the user's Chrome lacks the flag. An
  isolated instance needs no user step. Had S0 run, it would have caught the BLOCKER before any
  code.

---

## Findings

### BLOCKER

**B1 — The REPL transport returns an unresolved Promise; the tool runs anyway (§2).**
`handleEvaluate`'s CDP path with `` `(${fn})(${spec})` `` yields `{}`, while the WebMCP tool
executes in the background. The same string cannot serve the `chrome.scripting` eval fallback
if it is `await`-prefixed.

Recommended change (amends LOCKED decision 1; needs user re-approval):
1. In `handleWebMcpList` / `handleWebMcpCall`, replicate `handleEvaluate`'s three guards:
   `resolveTab`, the protected-URL regex and `assertResponsive`.
2. Call `withCdp(tabId, (send) => cdpEvaluate(send, 'await ' + expr, { timeoutMs, signal }))`.
   Both functions are *called, not modified*.
3. Have the runner return `JSON.stringify(result)`. `cdpEvaluate` then takes the single
   round-trip by-value path (cdp-evaluate.js:90), with no second `callFunctionOn` (see §6).
4. Do not silently fall back to `eval`. Pick one:
   - CDP-only, like `browser_run_action`, returning `WEBMCP_PAGE_ERROR: debugger unavailable`;
   - a dedicated `func`-based `chrome.scripting` fallback (no `eval`; a call-specific parking
     key; abort-aware polling).
5. Update `spec.md` decision 1, `plan.md` D1, the Reuse map and S2, and `tasks.md` T2-T4.

### MAJOR

**M1 — Thrown errors are not mapped (§3).** Navigation and other failures arrive as throws.

Recommended change:
- Wrap the evaluate in `try/catch`.
- Map `/Inspected target navigated or closed|Cannot find context with specified id|Execution context was destroyed/i`
  to `{success:false, status:"unknown", navigated:true, code:"WEBMCP_NAVIGATED", hint}`.
- Map other throws (`TAB_WEDGED`, protected page, tab gone) to their own message under
  `WEBMCP_PAGE_ERROR`.
- Add these cases to T3 and T4.

**M2 — The navigation model does not match Chrome (§6).** `null` was never observed; iframe
navigation shows up as `UnknownError`.

Recommended change:
- Keep the `null` branch.
- In the runner, snapshot `tool.window.document` before `executeTool`. Report `navigated:true`
  when it changed after a rejection.
- Rewrite spec SC4/SC6, plan AC7 and the T1 cases accordingly.

**M3 — `origin` cannot disambiguate same-origin duplicates (§10).**

Recommended change:
- List returns `frame: "main" | <frame URL>`, from `tool.window === window` or
  `tool.window.location.href`.
- Call takes `frame` (drop `origin` or keep it reserved for cross-origin Phase 2).
- `AMBIGUOUS_TOOL` returns candidate `frames`.
- Update the zod schema, T1 and the fixture (add a same-name iframe tool).

**M4 — The tool's error message never reaches the caller (§1).** The spec hides it; Chrome 155
reports a generic `UnknownError`.

Recommended change:
- Change SC8 to `status:"error"` with `errorName` plus the UA message. Tool authors report their
  own failures inside the result string.
- Classify cancel by `controller.signal.aborted`, not by error name (`AbortError` or
  `TimeoutError` are both possible).
- Map `NotFoundError` to `TOOL_NOT_FOUND` (unregister race).
- Map `NotAllowedError` from `getTools`/`executeTool` to unsupported, reason
  "permissions policy `tools`".
- Map `TypeError` to invalid input.
- Make the T1 fake reject with `DOMException`, and update the fixture's `throws_tool`
  expectation.

**M5 — List size is unbounded (§5).** It fails entirely on realistic sites.

Recommended change:
- Give the runner a total *encoded* budget (`JSON.stringify(...).length` ≤ ~90 000).
- Cap `description` and `title` (for example 2 000 / 200).
- When over budget, set `inputSchema:null` with `schemaOmitted:true` and report an `omitted`
  count.
- Replace an oversize schema with `null` plus `schemaTruncated`, not a broken fragment.
- Add an optional `name` filter to list for one tool's full schema.
- Truncate call `output` by encoded length too.
- Add T1 cases for each.

**M6 — Declarative form tools are already in `getTools()` and are unguarded (§1, §9.2).**

Recommended change:
- The runner detects them via
  `tool.window.document.querySelector('form[toolname="<CSS.escape(name)>"]')`.
- List reports `declarative:true, autoSubmit:<bool>`.
- Call refuses non-autosubmit declarative tools with a clear code, for example
  `DECLARATIVE_NEEDS_USER`, because the shield blocks the user's submit.
- Call requires `confirm:true` for autosubmit declarative tools (a form submit with no
  annotations).
- Fix the "Out of scope" wording in spec.md, plan.md and the Phase 2 list.
- Add a declarative form to the fixture.

**M7 — Page-authored list metadata is not labelled untrusted (§9.1).**

Recommended change:
- The handler adds `untrustedContent:true` and the "page data, not instructions" note to list
  results as well.
- Surface `untrustedContentHint` per tool.
- The `browser_webmcp_list` description says names and descriptions are page-authored.

**M8 — The test plan cannot catch B1 or M1, and S0 was demoted unnecessarily (§13, §14).**

Recommended change:
- In T4, use the real `cdpEvaluate` with `fakeSend` and a mocked `withCdp`. Assert the
  expression starts with `await (` and that a `Runtime.evaluate` rejection maps to M1's codes.
- Make the T1 round-trip use an `AsyncFunction` body.
- Restore S0 / T9a as a **required, automated** gate: isolated headless Chrome 155, temp
  profile, `--enable-features=WebMCPTesting`, fixture on `http://localhost`. Keep only T9b
  (daemon plus extension reload) user-gated.

### MINOR

- **m1 — Fact fixes (§1).**
  - `debugging` exists from Chrome 156 (155 returns three annotations).
  - `title` is `""` when unset: normalize it to omitted.
  - JSON-string input is already *rejected* in 155, not just deprecated.
  - A string tool result comes back raw, not JSON-quoted: document that `output` may be plain
    text, and optionally add `outputJson` when it parses.
- **m2 — Docs completeness.** Add to T7: README "31" at :348, :378, :854, :927; two rows in the
  "What It Can Do" index table; AGENTS.md :18 and :47; the debugger-banner note (CDP path). Add
  a negative check (no stale `31` tool counts) next to the `> 0` grep.
- **m3 — Persisted `confirm:true` in shortcuts (§9.4).** Make `browser_shortcuts save` reject a
  `browser_webmcp_call` step with `confirm:true` (or strip it), and add the row to the risk
  table.
- **m4 — Extension-side evaluate timeout.** Map the timeout (sync-blocked page) to
  `status:"canceled", code:"WEBMCP_TIMEOUT"` with a "page main thread may be blocked" hint, not
  `WEBMCP_PAGE_ERROR` with "max 120000".
- **m5 — Validate the runner result (§9.5).** The handler validates `status` (enum), `code`
  (allowlist), field types and lengths, and never trusts runner-supplied
  `untrustedContent`/`note`.
- **m6 — `waitMs` and unsupported states.** Debounce about 150 ms after the first `toolchange`
  (registrations arrive one event each). Treat a `getTools()` `NotAllowedError` as
  `supported:false`.
- **m7 — T5 ordering.** T5 is not parallel-safe with T3: the router drift guard
  (extension-router.test.ts:399-407) needs both sides. Make T5 depend on T3, or land them
  together.
- **m8 — CI parity.** Add `npm run test:coverage` to the T8 gate.
- **m9 — Document the shield (§9.3).** Document that the lock shield blocks in-page
  confirmation UIs for the length of a call. List "skip the input-blocking shield for
  `browser_webmcp_call`" as a Phase 2 option.
- **m10 — Document user activation (§9.6).** Document that WebMCP tools run with transient
  user activation (`userGesture:true`).
- **m11 — The fixture already exists.** `tests/fixtures/webmcp-demo.html` is untracked, not
  new. T9 should own and extend it (same-name iframe tool, declarative and autosubmit forms) and
  fix its `throws_tool` expectation.
- **m12 — Shared parking global.** If a `chrome.scripting` fallback is kept (B1, option 2), it
  must not share `window.__bcEvalOut` with `handleEvaluate`; the follow-up abort would overwrite
  it.

---

## Verdict

**VERDICT: REJECT** — revise, then run a short re-review.

The overall shape is sound and worth keeping:
- two tools with correct idempotency and timeout registration;
- a page-side runner;
- reuse of the router, unified error channel, mutex and cancel paths;
- honest `confirm` semantics;
- no manifest change.

But LOCKED decision 1 (transport through `handleEvaluate`) is wrong as written (B1). It would
execute page tools, including consequential ones, while returning `{}`. Decisions 5 and 6 and
success criteria 5, 6 and 8 rest on API behaviour that Chrome 155 does not show (M1-M4). Fixing
this changes the public schema (`frame` instead of `origin`) and adds handling for declarative
tools (M6), so the user must re-approve the amended decisions before implementation. The
re-review only needs to confirm B1, M1-M8 and the touched tasks.

---

## Re-review (revision 2)

**Scope:** whether revision 2 of `spec.md`, `plan.md` and `tasks.md` resolves B1, M1-M8 and
m1-m12, and whether it breaks anything new.

**Method:** the revision-2 documents were checked against the same source lines and the same
Chrome 155 probe evidence as above. Extra checks:
- the handler's import graph for Node-shim feasibility (`state.js` has no top-level `chrome`
  use; `cdp-session.js` registers listeners only when `chrome.debugger.onDetach` exists);
- the negative-grep patterns against the actual README, `llms.txt` and `AGENTS.md` lines;
- object-literal semantics for spec embedding, in Node.

### Resolution of revision-1 findings

| Finding | Revision 2 | Status |
|---|---|---|
| B1 | D1 is CDP-only and calls `withCdp` + `cdpEvaluate` directly. The expression is `await (fn)(spec)` (T2). The runner returns `JSON.stringify(result)`, so `cdpEvaluate` takes the by-value primitive path (cdp-evaluate.js:90) in one round trip. There is no eval fallback, and attach failure returns `WEBMCP_DEBUGGER_UNAVAILABLE`. The probe confirmed that `await (async fn)(spec)` resolves to the value under exactly these CDP parameters. | **Resolved** |
| M1 | D8 adds a handler try/catch for the three navigation messages, applied only after `attached`. `TAB_WEDGED`, protected and gone errors propagate and still reach the agent as `isError` (router.js:292-293). T4 injects the throws. | **Resolved** |
| M2 | The runner snapshots `tool.window.document` and treats "access throws" as navigated, which covers a cross-origin iframe navigation. The `null` branch is kept, and the API facts are corrected. | **Resolved** (see N2) |
| M3 | D7 adds `frame` (`"main"` / an index path) plus `frameUrl`, and `AMBIGUOUS_TOOL` lists `{frame, frameUrl}`. | **Resolved** (see N3) |
| M4 | D9: `canceled` comes from `signal.aborted`; errors map by name; `WEBMCP_TOOL_ERROR` carries a console hint; `NotAllowedError` from `getTools` gives `supported:false`. SC8 is corrected and the T1 fake uses real `DOMException`s. | **Resolved** |
| M5 | D6 sets a 90 000 encoded budget (`capped()` measures the string itself, so this stays under 100 000), with description/title caps, `schemaOmitted`/`schemasOmitted`, the `name` filter and encoded-length output truncation. T1 asserts the budget. | **Resolved** |
| M6 | D3: `DECLARATIVE_NEEDS_USER`; `confirm` required for autosubmit; list `declarative`/`autoSubmit`; the fixture gets both forms. Moved into scope. | **Resolved** |
| M7 | D4: the handler sets `untrustedContent` and the note on list and call, and surfaces `untrustedContentHint`. | **Resolved** |
| M8 | T4 runs the **real** `cdpEvaluate` and `cdp-session` over a mocked `sendCommand`, and **explicitly asserts that the expression starts with `await`**. This matters because an AsyncFunction `return` emulation would also pass without the `await`. T8 adds an automated, isolated real-Chrome smoke that drives the real handler. | **Resolved** |
| m1 | API facts corrected. `--enable-features=WebMCP` was independently verified to expose the API in 155. | Resolved |
| m2 | SC13 and T9 add a negative grep. Every stale line matches it: README :348 and :854 via `all 31`, :378 via `31 tools`, :927 via `(31`; `llms.txt:13` via `(31`; `AGENTS.md:18` via `all 31`, `:47` via `(31`. | Resolved |
| m3 | D3/T6: `save` rejects a literal `confirm:true`, and `"{{confirm}}"` keeps its boolean type through `substitute` (shortcuts.ts:64-65). | Resolved |
| m4 | D5 adds `WEBMCP_TIMEOUT` plus a best-effort abort. | Resolved |
| m5 | D4/T3 `sanitize()` allow-lists `status` and `code`. | Resolved |
| m6 | D10 adds a 150 ms debounce plus 250 ms polling; D9 covers `NotAllowedError`. | Resolved |
| m7 | T5 depends on T3, and plan step 5 lands after step 3. | Resolved |
| m8 | `test:coverage` added to SC12 and T10. | Resolved |
| m9 | The shield caveat is documented and moved to Phase 2. | Resolved |
| m10 | D1 and the docs cover `userGesture`. | Resolved |
| m11 | T8 extends the existing fixture and fixes the `throws_tool` expectation. | Resolved |
| m12 | Moot: no scripting fallback. | Resolved |

### New findings (revision 2)

All five are MINOR. None blocks implementation, and they can be folded into T2-T4/T8 without
another review.

- **N1 (MINOR): a `__proto__` key in `input` is silently dropped.**
  - Cause: `buildWebMcpExpression` embeds the spec as an object literal
    (`(fn)(${JSON.stringify(spec)})`). In a JS object literal, `"__proto__": {...}` sets the
    prototype instead of creating an own key. Node:
    `({"__proto__":{"a":1},"b":2})` → `JSON.stringify` = `{"b":2}`.
  - Effect: `executeTool` would serialize the input without that key.
  - Fix: embed the spec as data, for example
    `` `await (${fn})(JSON.parse(${JSON.stringify(JSON.stringify(spec))}))` ``. Add a T1
    round-trip case with a `__proto__` key in `input`.
- **N2 (MINOR): the navigation outcome contract is not fully specified.**
  - SC9 makes a **main-frame** navigation a non-error (`success:true, status:"unknown"`).
    D8's runner-side case (rejection plus a changed iframe document) does not say whether it is
    an error.
  - The same handler catch would also turn a navigation during **list**, which is safe to retry,
    into "do not repeat blindly".
  - `Inspected target navigated or closed` also fires when the tab is closed.
  - Because the result is non-error, `browser_batch` keeps running later steps on the new page.
  - Fix:
    - state that both call cases are `success:true` + `WEBMCP_NAVIGATED`;
    - list navigation is `isError` `WEBMCP_NAVIGATED` with "re-run list";
    - the wording covers "navigated or closed";
    - the `browser_webmcp_call` description says a batch continues after an unknown outcome.
- **N3 (MINOR): `frame` is positional.**
  - An iframe inserted, removed or reordered between list and call can point `"0"` at a
    different frame.
  - Fix: call returns the resolved `frameUrl` in every result. Optionally, it accepts
    `frameUrl` and returns `FRAME_CHANGED` on mismatch. Validate `frame` in zod with
    `^(main|\d+(\/\d+)*)$`.
- **N4 (MINOR): a frozen page can be reported as "debugger unavailable".**
  - The copied `attached`-flag rule classifies *every* pre-callback failure as
    `WEBMCP_DEBUGGER_UNAVAILABLE`. That includes `ensureCdp`'s bounded probe timeout
    `CDP attach probe timed out (page not responding)` (cdp-session.js:19-25, 46), which means
    the page is frozen, not that the debugger is unavailable.
  - Fix: map `/timed out \(page not responding\)/` to a page-unresponsive error (or
    `TAB_WEDGED`-style hint) and keep `WEBMCP_DEBUGGER_UNAVAILABLE` for attach refusals.
- **N5 (MINOR): smoke script behaviour without Chrome is undefined.**
  - `smoke:webmcp` is in the T10 gate but not in CI. Its behaviour when no Chrome binary is
    found is not stated.
  - Fix: exit with a distinct code and a clear "Chrome not found (set CHROME_PATH)" message,
    never a silent pass. Keep it out of `npm test`.

### Precondition (process, not a finding)

Revision 2 rewrites LOCKED decisions D1-D11 and the public schema (`frame`, list `name`, new
codes). The documents do not record a fresh user approval of revision 2: spec.md:3-5 cites only
the review and S0. Get the user's sign-off on the revised LOCKED decisions before T2 starts.

### Verdict (revision 2)

**VERDICT: APPROVE WITH CHANGES.**

Revision 2 resolves B1, M1-M8 and m1-m12. No new BLOCKER or MAJOR issues were found. Fold N1-N5
in during T2-T4 and T8; no further plan re-review is needed. Implementation may start once the
user has approved the revised LOCKED decisions.
