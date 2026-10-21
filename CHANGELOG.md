# Changelog

## 3.0.4

### Fixed
- `browser_type` into a same-origin iframe editor (TinyMCE) said `typed` but nothing changed. A frame that does not have the focus still has an active element (its `<body>`), and that counted as focused, so no click focused the editor. Focus is now read from the top document. Real Chrome, `/tinymce` on the-internet: the text is in the editor.
- `browser_click` on a target that moves:
  - A target already in full view is no longer scrolled. A scroll runs the page's scroll handlers, and a menu that follows the scroll moved away from the point that had just been measured.
  - After a scroll, or while a CSS animation or transition runs on the target or an element around it (a dialog that grows into place), the target is measured again until it holds still (up to 1 s).
  - A press that lands on another element now fails `CLICK_MISSED` and names that element. Before, the result said `clicked`.
  - Real Chrome: on `/floating_menu`, scroll 1500 px and click `News` now reaches `#news` (before: nothing happened). The `/entry_ad` dialog closes while its `popin` animation runs.
- `browser_type` with a `target` that is a slider, checkbox, radio, select, button or link that does not have the focus: the click that focused it also changed it. It moved a slider to its centre and toggled a checkbox. Such controls are now focused without a click. Real Chrome: a slider at 4.5 takes `ArrowLeft` and reads 4; `Space` toggles a checkbox once.
- `browser_evaluate` with several statements and no `return` gave `undefined` with no hint. The description now says statements need `return`, and such a result carries a `note:` that shows how.
- `browser_navigate` with `snapshot: true` on a page of frames showed only the frame that loaded first. Navigation now waits up to 3 s for same-origin child frames to load. On `/nested_frames` the snapshot has LEFT, MIDDLE, RIGHT and BOTTOM.
- `browser_scroll` with `dy` right after a navigation in a background tab could fail `NOT_SCROLLABLE`, because the wheel had not started yet. When the page has room to scroll, the scroll now waits up to 1.5 s for the wheel to start. This was seen once and not reproduced; the fix follows the code.
- A tab that one of the agent's tabs opened (a `target="_blank"` link, `window.open`) was listed as `[user, focused]` and took the focus from the user. It now belongs to the agent (`[own]`), and the tab the user was on is made active again, unless the user was looking at the tab that opened it. The opener comes from `webNavigation`, because Chrome's `openerTabId` names the active tab when the opener is in the background. This adds the `webNavigation` permission. Chrome words its warning like the `tabs` permission already does ("Read your browsing history"), so no new prompt appears. Reload the unpacked extension at `chrome://extensions`.
- Key combos sent only the main key. Each modifier now gets its own keydown and keyup, held around the key as a person holds it. On `/key_presses`, `Shift+a` reports `SHIFT` then `A`.
- A target whose own box its content collapses failed `ELEMENT_HIDDEN`. Examples: a list of floats (0 px high), or a column squeezed to 0 px wide with its text overflowing it. A box that does not clip its overflow is now visible when a child element or its own text is. Real Chrome: `ul` on `/disappearing_elements`, `#sibling-50.3` on `/large`.
- `ELEMENT_DISABLED` from `browser_type` said `nothing was clicked`. It now says `nothing was typed`. A failing `browser_batch` step no longer reads `.;` before `N skipped`.

## 3.0.3

### Added
- `scripts/pages/drag-and-drop.html`: a page that judges five drags by itself (a card onto a column that accepts it, a card onto one that refuses it, a sortable list, a link onto a drop zone, a plain mouse drag). Results are in a table, in `5 of 5 passed`, and in `window.dndResults`. A wrong drag reads `FAIL: <why>`, so the page cannot pass a drag that did not happen.
- `npm run smoke:real-chrome` runs those five drags in your own Chrome and names the platform (`drag and drop ok: 5 of 5 (win32)`). HTML5 drag and drop depends on the operating system: this is the check to run on Windows and macOS.

### Fixed
- `npm run smoke:real-chrome` on Windows: it looked for the daemon at a Unix socket path; it now uses the named pipe the daemon listens on (`\\.\pipe\browser-controller`). It also reads the daemon's folder from `BC_STATE_DIR` when that is set.
- `npm run smoke:real-chrome` never exited after `PASS` when your daemon was already running: it restarted the daemon as its own child and waited on it (Ctrl+C then stopped the daemon too). The restarted daemon now runs on its own and keeps running after the test.

## 3.0.2

### Fixed
- `browser_click` `dragTo` on an HTML5 drag source (`draggable="true"`, a link, an image). Chrome hands such a drag to the operating system's drag loop, which follows the real mouse and not the debugger's; on Windows and macOS it ended at once, with no drop. Drags are now intercepted: Chrome gives the drag's data back (`Input.setInterceptDrags`), and the rest of the gesture is sent as `dragenter`, `dragover` and `drop` at the same points. The source still gets `dragend`, a target that does not accept the drop gets none, and the result says `html5:`. A plain mouse drag is unchanged. Checked in a real Chrome, headless and with a window (Linux): a card dropped on a column, a sortable list, a link onto a drop zone, a refused drop, then a plain drag and a click. Windows and macOS were not available to test.
- `browser_scroll` with `dy`/`dx` in a tab that had been in the background a few seconds said `NOT_SCROLLABLE: nothing moved` although the page did scroll (the wheel waited for the tab's next frame, about a second). The tab now draws frames while the wheel settles: 395 ms and the right position, in a tab hidden for 16 s.

## 3.0.1

### Fixed
- `browser_navigate` in a background tab (every tab it opens without `tabId`) took about 1 s even for a small page. Chrome runs a hidden page's timers at most once a second, and the 200 ms quiet-DOM wait ran on a page timer. Its clock now runs in the extension; the page only records when its DOM last changed. In a real Chrome a small page in a background tab went from 1,000 ms to 240 ms, the same as in a visible tab.
- `browser_click` `dragTo` in a background tab took 1.4 to 9.5 s and could fail `TIMEOUT` after the drag had run. Chrome holds each mouse move of a hidden tab until its next frame, about one a second once the tab has been hidden a few seconds. A small screencast now keeps the tab drawing frames while the drag runs: 0.5 s per drag in a tab hidden for 16 s, every move delivered.
- `browser_click` `dragTo` said `dragged` when the page never got the mouse release. A drag over text leaves that text selected, and a press on selected text starts Chrome's own text drag, which ends without a `mouseup`. Any text selection is now cleared before the press.

## 3.0.0

### Breaking
- The server exposes 17 tools (was 35 + `browser_tools`). Removed tools no longer exist; use the mapping below.
- Element parameters (`ref`, `selector`, `x`/`y`) are one `target` string: `e12` (a ref from `browser_snapshot`), `text=Sign in`, `x,y` (viewport CSS px) or a CSS selector.
- Failures are `isError` results whose text is `CODE: message`. Reads return plain text lines, not JSON.
- Tab ownership is implicit: a tab that `browser_navigate` opens without `tabId` belongs to that session. Another session's call on it fails with `TAB_LOCKED`. There are no lock or unlock calls.
- The blue shield shows only while a tool call runs on a tab. A tab a session owns no longer keeps the frame between calls, so the user's input on it is not blocked then.
- Input is always trusted CDP input. If the debugger cannot attach, input fails with `DEBUGGER_UNAVAILABLE`; there is no synthetic-event fallback.
- Progressive mode (`BROWSER_CONTROLLER_PROGRESSIVE`) is removed; every tool is listed.
- Update the MCP clients, the daemon and the extension together. Every peer must send an explicit `protocolVersion` and the `tools-v3` capability before any tool call is routed. There is no legacy window: a pre-3.0 peer is refused. After you pull 3.0, stop the old daemon, restart your MCP clients so the 3.0 daemon starts, and reload the extension. The refusal texts are:
  - A 3.0 MCP client meets a running 2.x daemon: `The running Browser Controller daemon is older than 3.0: stop it (npm run daemon:stop, or end the pid in its daemon.lock), then restart your MCP client so the 3.0 daemon starts.`
  - A 2.x MCP client meets a 3.0 daemon: `This MCP client is older than 3.0: restart your MCP client so it starts the 3.0 client.`
  - A 3.0 extension meets a 2.x daemon: `The Browser Controller daemon is older than 3.0: restart your MCP client so it starts the 3.0 daemon.`
  - A 2.x extension meets a 3.0 daemon: `The Browser Controller extension is older than 3.0: reload it at chrome://extensions.`
- The `?token=` query on the WebSocket upgrade is removed. The token travels only in the `bc-auth.<token>` WebSocket subprotocol.
- Unknown parameters fail `INVALID_ARGUMENT: unknown parameter <name>`. A removed 2.x name gets a short hint, for example `unknown parameter ref (use target with the ref from browser_snapshot)`.
- The extension no longer requests the `declarativeNetRequest` and `declarativeNetRequestFeedback` permissions.

| 2.x | 3.0 |
|---|---|
| `browser_find` | `browser_snapshot {query}` |
| `browser_observe`, `browser_act` | `browser_snapshot` + `browser_click` / `browser_type` / `browser_fill` |
| `browser_click_text` | `browser_click {target: "text=…"}` |
| `browser_hover` | `browser_click {hover: true}` |
| `browser_drag` | `browser_click {dragTo}` |
| `browser_press_key` | `browser_type {key}` |
| `browser_select`, `browser_fill_form`, `browser_upload_file` | `browser_fill` |
| `browser_run_action` | `browser_evaluate` |
| `browser_shortcuts` | `browser_batch` |
| `browser_resize_window` | `browser_emulate {viewport}` |
| `browser_list_browsers`, `browser_select_browser` | `browser_tabs {browser}` |
| `browser_console`, `browser_network` | `browser_logs` |
| `browser_intercept` | `browser_mock` (tab-scoped; no global, DNR, log rules or HAR) |
| `browser_gif`, `browser_webmcp_list`, `browser_webmcp_call`, `browser_tools` | removed |
| `ref` / `selector` / `x`,`y` params | `target` |
| `browser_tabs` create / reload / lock / unlock | `browser_navigate` (no tabId / `url: "reload"`); ownership is implicit |
| `browser_handle_dialog {action}` | `{accept, promptText}` |

### Added
- `browser_fill`: up to 50 fields in one call. Text, select (by value, else label), checkbox and radio (boolean), and file inputs (absolute paths, checked before anything is sent: `FILE_NOT_FOUND`).
- `browser_fill` also sets date, time, datetime-local, month, week, colour and range inputs (the whole value, as the picker sets it; a rejected value fails `VALUE_NOT_SET`), and elements with role `checkbox`, `radio` or `switch` (boolean; an unchanged `aria-checked` fails `VALUE_NOT_SET`). A value may be a number.
- `browser_type` `key` takes several keys in order, separated by spaces (`ArrowDown ArrowDown Enter`). Every name is checked before anything is sent.
- `browser_logs`: console (with uncaught errors and stacks) and network in one tool. `requestId` reads one request; `bodies` adds response bodies.
- `browser_mock`: per-tab response rules (`block`, or `status`, `body`, `headers`). `rules` replaces the set; listing shows hit counts.
- `browser_navigate`: `url` may be `back`, `forward` or `reload` (these need `tabId`); `snapshot: true` appends a snapshot.
- `browser_tabs` `browser` parameter: picks the Chrome profile for the session. With several profiles connected, `list` shows them first.
- `browser_emulate` `viewport`: sets the page viewport without resizing the window.
- `browser_snapshot` `query`: the elements that hold every word of the query in their role, name or value (whole-word matches first, else substring), with their ancestor lines. `save button` finds `button "Save draft"`.
- `browser_fill` refuses hidden and credential file paths before anything is sent (`FILE_NOT_ALLOWED`). A field that keeps its old value fails `VALUE_NOT_SET`, and input on a tab with an open dialog fails `DIALOG_OPEN`.
- Named failure codes `RATE_LIMITED`, `NOT_CONNECTED`, `INSPECT_FAILED`, `NOT_FOUND` and `INTERNAL_ERROR`. A failure with no code of its own reads `INTERNAL_ERROR`. The README lists the codes.

### Changed
- `browser_click`: `hover: true` only moves; `dragTo` drags to a second target. The result adds `navigated:` or `dialog:` when either happens within 300 ms of the press.
- `browser_type`: `target` is optional (default: the focused element). A `key` alone goes to whatever has focus. `submit` presses Enter last.
- `browser_wait`: exactly one of `target`, `url`, `ms`. `ms` longer than `timeout` fails `INVALID_ARGUMENT`. A `url` with `*` is a glob over the whole URL; otherwise a substring.
- `browser_evaluate`: statement bodies run as an async function body (use `return`). Default `timeout` 5000 ms (min 1000, max 30000). Falls back to `chrome.scripting` (`via: scripting`) when the debugger cannot attach.
- `browser_handle_dialog`: `accept` (boolean) and `promptText` replace `action`.
- `browser_snapshot`: `maxChars` default 8000, max 50000; refs past the cut are not issued.
- `browser_screenshot`: JPEG, longest side at most 1568 px. Background tabs are captured over CDP without activating them.
- `browser_batch`: up to 50 steps, any tool except `browser_batch`. Its `tabId` fills steps that omit it. A failure reports `step i/n <tool>: CODE: message; k skipped`.
- Refs are `e<n>`, stable per element for the life of the page. A re-rendered element is found again by its snapshot description, and the result adds a `note:` line. `REF_GONE` means take a new `browser_snapshot`.
- Tool definitions are shorter. The 17 `tools/list` definitions are 11,050 characters of JSON: 2,630 tokens, plus 260 for the server instructions (2,890 in all, o200k), down from 7,406 in 2.8.0.
- `browser_navigate` waits for the new page's DOM to be ready, then until the DOM has had no change for 200 ms (1 s at most). It no longer waits for images and other subresources, and the fixed 500 ms pause is gone. In a real Chrome, a plain local page went from 520 ms to 220 ms (median of 5), and a page with a 2 s image from 2,526 ms to 309 ms. The landed URL, `status`, `NAVIGATION_FAILED` and the 204 and download results are unchanged.
- A JavaScript dialog no longer stalls page reads: snapshot, text, wait, scroll, screenshot, inspect_element and evaluate fail `DIALOG_OPEN` at once on a tab with an open dialog (before, they waited about 8 s and failed `TAB_WEDGED`). Any other result on such a tab gets a `dialog:` line.
- `browser_evaluate` with a script that opens a dialog returns at once with a `dialog:` line; the script stays paused until `browser_handle_dialog` answers it (before, it waited for the whole timeout).
- While the daemon is down, the extension checks its `/status` address before it opens the WebSocket, so `chrome://extensions` no longer fills with `ERR_CONNECTION_REFUSED` errors. The check sends no token or secret.
- Shared conventions (targets, errors, input, page data) are sent once in the server instructions.
- `browser_tabs list`: tabs of other sessions are not listed. They are counted in one line, `+N tabs used by other agents`.
- Mock rules, emulation overrides and response-body capture end with the session that set them: they are cleared when that session disconnects, and a closed tab forgets them. A disconnect never clears another session's settings.
- `browser_evaluate` refuses a source that closes its wrapper early before it runs (`SCRIPT_ERROR: … nothing was run`).
- `browser_emulate` `reset: true` clears every override and reports each one (`cleared:` and one line per override), or `no overrides`.
- `browser_screenshot` on a frozen tab fails `TAB_WEDGED` after 8 s instead of hanging.
- `browser_emulate` `geolocation`: the tab's debugger cannot grant the geolocation permission. The page reads the emulated position only when the site already has geolocation allowed in Chrome.

### Removed
- Tools: `browser_find`, `browser_observe`, `browser_act`, `browser_click_text`, `browser_hover`, `browser_drag`, `browser_press_key`, `browser_select`, `browser_fill_form`, `browser_upload_file`, `browser_run_action`, `browser_shortcuts`, `browser_gif`, `browser_resize_window`, `browser_list_browsers`, `browser_select_browser`, `browser_webmcp_list`, `browser_webmcp_call`, `browser_console`, `browser_network`, `browser_intercept`, `browser_tools`.
- Progressive mode and `BROWSER_CONTROLLER_PROGRESSIVE`.
- WebMCP support, GIF recording, saved shortcuts.
- Global and declarative net-request rules, HAR export and capture ledger.
- `npm run smoke:webmcp` and its script.
- Explicit tab locks (`lock`, `unlock`, `create`, `reload` on `browser_tabs`).
- Synthetic input (`trusted: false`), and the screenshot options `fullPage`, `scale`, `format`, `quality`, `maxWidth`.
- `browser:true` on logs (Chrome-reported messages and DevTools Issues).
- `source: "native"` snapshots.
- Element refs in formats other than `e<n>`.
- Response fields `freshRefs`, `via: "fallback"`, `isNew` and `refsMayBeStale`.

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
