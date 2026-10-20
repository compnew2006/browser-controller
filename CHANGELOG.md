# Changelog

## 3.0.0 (in progress)

### Removed
- `browser_tools` and progressive mode (`BROWSER_CONTROLLER_PROGRESSIVE`): every tool is listed directly; Claude Code already loads MCP tool schemas on demand.
- `browser_gif`, `browser_webmcp_list`, `browser_webmcp_call`, `browser_shortcuts`, `browser_run_action` (use `browser_evaluate`).
- `browser_observe` / `browser_act` (a second, synthetic-only action pipeline with its own refs; `browser_snapshot` + the action tools cover it), `browser_find` (now `browser_snapshot {query}`), and `browser_snapshot source:"native"`, `compact`, `filter`, `depth`. `browser_text mode:"article"` (it dropped real paragraphs).

### Changed
- `browser_snapshot` returns indented lines `role "name" [ref]` with state, value and the row text of look-alike controls, instead of JSON; "+ " marks what is new since the previous snapshot; link targets only with `links: true`. On the 8 test pages the inline snapshot of `browser_navigate` went from 38,287 to 21,475 tokens while showing about twice as many elements (1 page cut at the limit instead of 5). Elements under `opacity:0`, `inert` or `aria-hidden` are left out; the extension's own frame never shows up. Default `maxChars` 12 000.
- A stale ref answers `REF_GONE` with a hint to take a new snapshot (it used to attach 40 unrelated refs, ~800 tokens).
- `browser_text` and `browser_wait text` include same-origin iframe text on every page (it depended on the page having shadow DOM).

### Fixed
- While no daemon was running, the extension retried every ~30 s and each try added "WebSocket connection to 'ws://127.0.0.1:7225/' failed … ERR_CONNECTION_REFUSED" to chrome://extensions → Errors (6 in the first 45 s, then one every 30 s). It now checks with a silent request first and only opens the WebSocket when the daemon answers.

## 2.8.1

### Fixed
- `browser_evaluate` whose script opened a dialog (`confirm()` …) hung until its timeout. It now returns at once with `dialog: { type, message }`, and script calls made while a dialog is open fail with `DIALOG_OPEN` instead of running after it closes.

## 2.8.0

### Fixed
- `browser_snapshot` printed the value of password fields (including ones the browser filled in). A filled password field now shows `••••`, and `browser_type` reports one the same way.
- A full-page screenshot of a long page was bigger than the daemon accepts, which closed the extension's connection and failed every agent's call in flight. Screenshots now fit: no side over 8000 px, JPEG and smaller when needed. Any result over the limit is answered with `RESULT_TOO_LARGE`; the connection stays up.
- `browser_handle_dialog` could not answer a dialog that was already open, and when called with none open it made the page answer every later `confirm()` on its own. The tab's debugger session now notices dialogs as they open: the action that opened one returns at once with `dialog: { type, message }` (it used to hang ~10 s), page tools fail fast with `DIALOG_OPEN`, and `browser_handle_dialog` answers it. With none open it says `NO_DIALOG` and prepares nothing.
- `browser_find` returned nothing for any query with a hyphen (`sign-in`, `e-mail`, `SKU-150`).
- `browser_navigate` reported the requested URL instead of where a redirect landed, called a 404 or a refused connection a success, and waited 55 s for a download or a `204`. It now returns the landed `url`, `httpStatus` for 4xx/5xx, fails on network errors, and returns at once with `status: "not-navigated"` for a download or `204`.
- `browser_click` reported success on a hidden, disabled or covered element. It now fails with `HIDDEN`, `DISABLED` or `COVERED` and clicks nothing. A menu item shown by `browser_hover` now gets a real click instead of a synthetic one.
- `browser_upload_file` fired `input` and `change` twice (React `onChange` ran twice).
- After the daemon restarted, a tab lock of the old run stayed in the browser, kept its blue frame, blocked other agents for 30 s per call, and passed to the new agent that got the same session id. Locks of an earlier daemon run are now released when the extension reconnects.
- `browser_gif` recording a background tab brought it to the front for every frame, hiding the tab the user was on. `activate` now defaults to `false`; `start` says when frames will be skipped.
- `browser_intercept`: one regex Chrome cannot use (a lookahead) silently disabled every block/redirect/header rule. Each rule is now checked first and a bad one is refused by index and id; if Chrome rejects an update anyway, the call fails and the tab keeps its previous rules.

### Changed
- `browser_intercept set-rules` needs a `tabId` (or rules with `tabIds`). A rule without a tab applied to every tab in the user's browser; it is now refused.
- The daemon's hello to the extension now carries its message size limit and a per-run id.

## 2.7.0

### Added
- `browser_inspect_element`: computed styles, the CSS rules that match (with file:line and overridden declarations), and event listeners of one element.
- `browser_network captureBodies: true`: keeps response bodies of document/XHR/fetch requests; `requestId` then returns `responseBody` (credentials in JSON redacted, binary and >5 MB skipped).
- `browser_intercept` mock rules: the page really receives the mocked status, body and headers (CORS preflights answered).
- `browser_observe maxChars` (default 20 000): caps the element list and says `truncated: true`.

### Changed
- `browser_console` reads the page's console from Chrome through the debugger. It now includes uncaught errors and promise rejections with their stack, and starts empty on each new page. It covers the current page from its load, up to 200 entries; console output of cross-origin iframes is not included.
- The extension no longer injects any script into the pages you browse. Before, it wrapped every page's `console`, so a site's own `console.error` (for example GitHub's "Error reading query stream") showed up as an error of the extension at `console-main.js:32`. After updating, reload tabs that were open before, since they still hold the old wrapper.
- Tool descriptions are shorter (the full tool list is about 7,100 tokens). In progressive mode `browser_tools list` returns names and summaries only; per-tool guidance comes with `search` and `details`.
- `browser_observe` results are leaner (no default-valued fields, rounded boxes).
