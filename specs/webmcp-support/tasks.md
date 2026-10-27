> **Status: superseded (2026-10-27).** The WebMCP feature was removed in Browser Controller 3.0 (commit `9e40798`; `CHANGELOG.md` lists `browser_webmcp_list` and `browser_webmcp_call` as removed). No `webmcp` text remains in `extension/` or `mcp-server/src`. Statements below that say "implemented" describe the 2.x code only. The body is kept for history. See finding F8-4 in `docs/audit/09-feature-architecture-review.md`.

# Tasks — WebMCP support (revision 2)

Tasks are ordered, atomic and checkable. Each one lists the files it owns, its dependencies,
change intent, acceptance evidence, verification command, rollback, and security relevance.
Decisions D1–D11 and success criteria SC1–SC14 live in `spec.md`.

---

## T1 — Runner tests (red)
- **Files owned:** `tests/extension-webmcp.test.ts`, runner section (new).
- **Depends on:** nothing.
- **Change intent:**
  - **Fake environment.**
    - `globalThis.window`, `globalThis.document`, `globalThis.location` and a `frames` tree
      (main plus one child window).
    - A fake `modelContext` with `getTools`, `executeTool`, `addEventListener` and
      `removeEventListener`.
    - `executeTool` records its input and rejects with real `DOMException`s
      (`UnknownError`, `AbortError`, `NotAllowedError`, `NotFoundError`) and `TypeError`.
  - **List cases:**
    - shape, with `window` stripped;
    - `frame` / `frameUrl`;
    - `declarative` / `autoSubmit`, detected through a fake `querySelector`;
    - `name` filter;
    - `title` and `description` caps;
    - schema omitted when too large, and over budget with the `schemasOmitted` count;
    - the encoded result stays at or under the budget;
    - `waitMs` with a late `toolchange` burst (debounce);
    - `waitMs` expiring;
    - absent `modelContext` and a `getTools` `NotAllowedError` both give `supported: false`.
  - **Call cases:**
    - completed, with the input passed as the same object;
    - `null` gives `navigated`;
    - `TOOL_NOT_FOUND`;
    - `AMBIGUOUS_TOOL`, then `frame` selects;
    - `CONFIRMATION_REQUIRED` for consequential and for autosubmit declarative tools, with
      `execute` never called; then `confirm` runs it;
    - `DECLARATIVE_NEEDS_USER`;
    - timeout gives `canceled`, `timedOut`, and `__bcWebmcpCalls` is cleaned up;
    - each error name maps to `errorName`;
    - a document change after a rejection gives `unknown` + `navigated`;
    - output truncation keeps the encoded result within budget;
    - the `abort` action aborts the parked controller.
  - **Round trip:** run `buildWebMcpExpression(spec)` as an AsyncFunction body
    (`` `return ${expr}` ``). It must start with `await` and yield a JSON string.
- **Acceptance evidence:** fails because the module does not exist yet.
- **Verification command:** `npx vitest run tests/extension-webmcp.test.ts`
- **Rollback:** delete the section.
- **Security relevance:** pins the gates (D3) and the abort and size contracts.

## T2 — Runner
- **Files owned:** `extension/lib/webmcp-page.js` (new).
- **Depends on:** T1.
- **Change intent:**
  - `async function webmcpPageRun(spec)`: self-contained, with every helper inside the
    function, and all limits passed in `spec.limits`. It returns `JSON.stringify(result)`.
  - `buildWebMcpExpression(spec)` returns
    `` `await (${webmcpPageRun.toString()})(${JSON.stringify(spec)})` ``.
  - `WEBMCP_LIMITS` holds `{budgetChars: 90_000, schemaMaxChars: 8_000,
    descriptionMaxChars: 2_000, titleMaxChars: 200}`.
- **Acceptance evidence:** the T1 runner section passes.
- **Verification command:** `npx vitest run tests/extension-webmcp.test.ts`
- **Rollback:** delete the file.
- **Security relevance:** the gates and abort live here.

## T3 — Handler and router wiring
- **Files owned:**
  - `extension/handlers/webmcp.js` (new);
  - `extension/lib/router.js` (import, plus 2 `HANDLERS` entries next to `browser_evaluate`);
  - `extension/handlers/gif.js:14`.
- **Depends on:** T2.
- **Change intent:**
  - **`evaluateRunner(tabId, spec, budgetMs, signal)`:**
    - runs `resolveTab`, the protected-URL guard and `assertResponsive`;
    - then `withCdp` + `cdpEvaluate`, using the `attached` flag. An attach failure throws a
      marked `WEBMCP_DEBUGGER_UNAVAILABLE`.
  - **`sanitize(result, action)`:**
    - allow-lists `status` (`completed` / `canceled` / `error` / `unknown`) and `code`
      (`TOOL_NOT_FOUND`, `AMBIGUOUS_TOOL`, `CONFIRMATION_REQUIRED`, `DECLARATIVE_NEEDS_USER`,
      `WEBMCP_INVALID_INPUT`, `WEBMCP_NOT_ALLOWED`);
    - type-checks and clamps fields.
  - **Mapping** follows D1, D3–D9 and SC3–SC11.
    - `success: false` results carry `error: "<CODE>: message"` and `code`.
    - Non-error results carry `untrustedContent: true` and the note, set by the handler.
  - **Cancel:** if `signal` aborts, run `evaluateRunner(…, {action: 'abort', callId}, 2_000)`
    and swallow its errors.
- **Acceptance evidence:** `dispatchedTools` includes both names. The T4 tests pass.
- **Verification command:**
  `grep -n "browser_webmcp" extension/lib/router.js extension/handlers/gif.js`
- **Rollback:** revert `router.js` and `gif.js`, then delete the handler.
- **Security relevance:** the trust boundary. The page's output is validated here.

## T4 — Handler tests
- **Files owned:** `tests/extension-webmcp.test.ts`, handler section.
- **Depends on:** T3.
- **Change intent:**
  - Mock `chrome`: `tabs.get`, `debugger.attach` / `sendCommand` / `detach` / `onDetach`,
    `tabs.onRemoved`, `scripting`, and the storage stubs the imports need.
  - `sendCommand('Runtime.evaluate')` evaluates `params.expression` as an AsyncFunction body
    against the T1 fake page and returns `{result: {type: 'string', value}}`.
  - Assert:
    - the expression starts with `await`;
    - budgets: list `waitMs + 5_000`, call `timeout + 3_000`;
    - every mapping;
    - `untrustedContent` on list and call;
    - `sanitize` drops a forged `status` and a forged `code`;
    - attach failure gives `WEBMCP_DEBUGGER_UNAVAILABLE`;
    - `Inspected target navigated or closed` and `Cannot find context with specified id` give
      `WEBMCP_NAVIGATED` (non-error);
    - an evaluate timeout gives `WEBMCP_TIMEOUT` plus an abort evaluate;
    - an aborted signal triggers the abort evaluate;
    - `TAB_WEDGED` / protected-page throws propagate.
- **Acceptance evidence:** all tests pass.
- **Verification command:** `npx vitest run tests/extension-webmcp.test.ts`
- **Rollback:** delete the section.

## T5 — MCP tool definitions and registration
- **Files owned:**
  - `mcp-server/src/tools/webmcp.ts` (new);
  - `mcp-server/src/tools/index.ts`;
  - `mcp-server/src/tools/meta.ts` (`TOOL_GUIDANCE`);
  - `tests/tools/registry.test.ts`.
- **Depends on:** T3, so the router drift guard sees both sides in one gate.
- **Change intent:** schemas per D2 and `forwardHandler`.
  - `browser_webmcp_list`: `idempotent: true`, `timeoutMs: 20_000`.
  - `browser_webmcp_call`: `timeoutMs: 125_000`.
  - Each summary is 10–80 chars.
  - The descriptions state the debugger banner, `confirm`, declarative forms and untrusted
    content.
- **Verification command:**
  `npx vitest run tests/tools tests/register-tools.test.ts tests/extension-router.test.ts`
- **Rollback:** revert the 4 files.
- **Security relevance:** the schema bounds `timeout` and `waitMs` and requires `name`.

## T6 — Shortcuts save guard
- **Files owned:** `mcp-server/src/tools/shortcuts.ts` (`save` branch),
  `tests/tools/shortcuts.test.ts`.
- **Depends on:** T5.
- **Change intent:** reject a `browser_webmcp_call` step whose `params.confirm === true`. The
  error names the `"{{confirm}}"` alternative. A whole-string placeholder keeps its type
  through `substitute`.
- **Verification command:** `npx vitest run tests/tools/shortcuts.test.ts`
- **Rollback:** revert both files.
- **Security relevance:** prevents standing approvals.

## T7 — Protocol capability
- **Files owned:** `mcp-server/src/protocol.ts`, `extension/lib/protocol.js`.
- **Change intent:** append `'webmcp'` to `EXTENSION_PROTOCOL_CAPABILITIES` in both files, at
  the same position.
- **Verification command:** `npx vitest run tests/protocol-handshake.test.ts`
- **Rollback:** remove the entry.

## T8 — Fixture and real-Chrome smoke
- **Files owned:**
  - `tests/fixtures/webmcp-demo.html` (exists; extend it);
  - `tests/fixtures/webmcp-frame.html` (new);
  - `scripts/smoke-webmcp.mjs` (new);
  - `package.json` (the `smoke:webmcp` script only).
- **Depends on:** T3.
- **Change intent:**
  - The fixture adds:
    - a same-origin iframe registering its own `echo`;
    - a declarative `<form toolname="search_form" tooldescription=…>` (no autosubmit);
    - `<form toolname="subscribe" toolautosubmit …>`.
  - The `throws_tool` expectation becomes the generic error.
  - The smoke script:
    - finds Chrome (`CHROME_PATH`, else the platform default);
    - starts it headless with a temporary profile and `--enable-features=WebMCP` on a free
      port;
    - serves `tests/fixtures` on `localhost`;
    - shims `chrome` over CDP and imports the real handlers;
    - asserts SC1–SC11;
    - prints a PASS/FAIL table, cleans up, and exits non-zero on failure.
- **Acceptance evidence:** `npm run smoke:webmcp` exits 0.
- **Rollback:** delete the new files and revert the script line.
- **Security relevance:** the isolated profile; the user's Chrome is never touched.

## T9 — Docs
- **Files owned:** `README.md`, `llms.txt`, `agent-config/AGENTS.md`,
  `agent-config/skills/browser-automation/SKILL.md`,
  `agent-config/cursor/rules/browser-controller.mdc`.
- **Depends on:** T5.
- **Change intent:**
  - Tool reference entries, a key-capabilities bullet, the index rows, and the counts
    31 → 33.
  - State when to prefer WebMCP tools, the `confirm` rule, declarative forms, untrusted
    output, the debugger banner, `userGesture`, the shield caveat, and the Chrome
    flag / origin-trial requirement.
- **Verification commands:**
  - `grep -c browser_webmcp` on all 5 files must be greater than 0;
  - `grep -n "all 31\|31 tools\|31 +\|31 definitions\|(31" README.md llms.txt agent-config/AGENTS.md`
    must be empty.
- **Rollback:** revert the docs.

## T10 — Verification gate
- **Depends on:** T1–T9.
- **Commands, in order:**
  1. `npm run build`
  2. `npm run typecheck`
  3. `npm run lint`
  4. `npm test`
  5. `npm run test:coverage`
  6. `npm run smoke:webmcp`
  7. `git diff --check`
- **Acceptance evidence:** all exit 0. Fix forward and never weaken a test.

## T11 — Graph refresh, report, audit
- **Files owned:** `graphify-out/*`, `specs/webmcp-support/implementation_report.md`,
  `specs/webmcp-support/audit.md` (written by an independent auditor).
- **Change intent:**
  - run `graphify update .`;
  - write the report with per-task evidence and the gate output tails;
  - a read-only independent audit.
- **Verification command:** `graphify explain "webmcpPageRun"` shows the handler edge.
- **User-gated, not done here:**
  - restart the daemon on the new build;
  - reload the unpacked extension;
  - try it in the user's own Chrome with the flag enabled.
