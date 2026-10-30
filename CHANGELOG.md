# Changelog

## Unreleased

Run `npm run build`, reload the extension at `chrome://extensions` and restart the daemon after updating.

### Added
- `browser_wait {until:"stable"}`: waits until the page stops changing, by fingerprinting its rendered text every 100 ms. Two identical readings mean the page settled; a page that never settles (a clock, a live feed) reaches the timeout and says so.
- `browser_tabs {action:"session"}`: the session's own policy, and the way to change it. `isolation:"isolated"` restricts the session to the tabs it opened itself (any other tab fails `TAB_NOT_OWNED`, and the tab list shows the session's own tabs only); `access:"read-only"` refuses every call that changes something with `READ_ONLY`, before anything is dispatched. Both are session settings, and the default stays trusted and writable.
- `browser_batch {onError:"continue"}`: the batch runs the steps after a failing one and names every failure (`STEP_FAILED: 2 step(s) failed, 3 completed`). The default is still `stop`.
- Site map routes (spec 005): the map remembers pages an agent read completely and whether each has its own address. A page reached through a content link or from another site is recorded once it is opened by its address.
- A click whose page changes address a moment later is credited with that destination, within 120 s and when no other action ran in the tab.
- Each map keeps up to 5 entrances: pages on other sites a click left from. `browser_site_map` lists them as `entered before from …`, and marks a page whose last direct open landed on a sign-in page as `sign-in expected`.
- Routes are computed when a map is read. The `browser_navigate` reminder lists up to 3 known addresses to open directly.
- Vault site approval (spec 006): one approval covers listing and filling the saved accounts of one site in one Chrome profile, for every agent session, until the vault locks, the owner revokes it, a backup is restored or the daemon restarts.
- The owner approves on a card that the extension draws on the requesting tab, in a closed shadow root that page scripts cannot read. It shows the site, the profile, the agent and whether the vault will be unlocked, never a password. It accepts a decision only from the user's own input, once the whole card has been visible and in place for 600 ms. A card the page covers, restyles or the window resizes waits again; a card the page moves or removes sends the owner to the vault page. Agent snapshots and locators do not see inside it. Only when the card cannot be shown does the extension page open, as before.
- While the card shows, agent input to that tab fails `VAULT_APPROVAL_PENDING`. A `browser_vault` `list` or `fill` call that started the card waits up to 40 s for the decision; Deny returns `VAULT_DECLINED`.
- Sites the owner always allows: added on the card or in the vault page's new "Site access" section, kept inside the encrypted vault, and never visible to agent tools. Listing and filling there need no request and write a grant audit event. Removing a site from the list ends every approval of that site in that profile at once, however it was given.
- When the agent session that asked ends while its card shows, even during the owner's decision, its call ends as cancelled, but the card stays until it expires. Allow there still approves the site and answers the other sessions' requests that joined the card. A new request for that site gets its own card, which names its own agent, and takes over the waiting requests. Requests still waiting when a card ends without a decision move to the vault page, so the owner can still decide them.
- A card the daemon already ended answers Allow and Deny with an error instead of going away as if they worked; "Decide on the vault page" opens the vault page. The daemon takes cards down through the browser connection that drew them, so a card in a second Chrome profile also closes after its session ended.
- The vault page's "Site access" section lists site approvals with how each was given, and revokes each one. Revoking a site's approval also takes the site off the always-allowed list, which would otherwise approve it again on the next call. The approval ends first: if the vault cannot be written, the owner sees the error and the list does not approve the site again until the owner allows it again or the vault locks. The page's notice says what a Revoke or Remove changed.
- New extension capability `vault-site-approval`.

### Changed
- An action now waits for the page to settle before the call returns: the page's rendered text is read inside the page until it stops changing. A read that follows an action sees what the action produced, not the page before it — an SPA that redraws a list in place no longer answers with the old list.
- `browser_navigate` waits for the page the same way. The load event is not the end of the page: an app that renders after it is still empty when the navigation returns, and the read that follows would see it empty.
- An `expect` is polled for up to 1.5 s instead of being read once, so a page that changes a moment after the click still meets it. The result says how long it waited.
- `ELEMENT_HIDDEN` now says how to go on (`use browser_evaluate to act on it, or hover it first`) instead of leaving the agent to guess.
- "No current window" (a Chrome window that closed under the session) now names the browsers that still have a window, so the agent can pick one instead of retrying the same call.
- A fill writes the saved username into the one username field of the same form, then the password. With several fields that look like a username, the password goes alone. A first step that shows only a username field gets the username alone. The result reports `filled_fields` and never a value.
- Parallel vault calls on one tab no longer replace each other's page inspection, which made the first fill end `VAULT_OUTCOME_UNKNOWN`.
- Map files may hold `entrances` and `read` pages. An older daemon quarantines such a file as `MEMORY_CORRUPT`; before downgrading, run `npm run memory -- map delete --all`.
- An earlier daemon cannot read a vault that holds an always-allowed site. Remove every always-allowed site in the vault page before downgrading.
- `scripts/smoke-vault-isolated.mjs` checks the card flow, the always-allowed list and the username fill. New `npm run smoke:vault-card` checks the card's own guards in Chromium with real mouse input; it needs no daemon or extension.

### Fixed
- `browser_batch` dropped every step but the last one: a batch that read the page twice answered with the second read only, and the first read — and any screenshot step before it — was lost. Every step's result comes back now, each under its own step label, and `structuredContent` carries one entry per step. A failing step keeps the steps that already ran as context. The batch's whole text is capped at 120 000 characters (`maxChars` changes it); past the cap the later steps are cut and the cut is said out loud, so the agent knows to read that step again.
- A website memory or site map delete could lose its tombstone when the queue emptied in the same millisecond as the delete. Work enqueued in that millisecond could then bring the deleted site back. Tombstones now stay until the queue empties at a later time.
- `npm run memory -- map` commands failed `MEMORY_UNAVAILABLE` when `map-counters.json` could not be read, because each result reports the counters. They now run, report no counters and name the failure in `mapCountersError`. A profile's `delete --all` deletes its maps and leaves that file's counters for the profile in place.
- `browser_site_map` named the site map when it could not read the memory policy. It now names the policy that failed.

## 3.1.1

Reload the extension at `chrome://extensions` and restart the daemon after updating.

### Added
- Site map, off by default and enabled per Chrome profile (spec 004): with website memory on, the daemon remembers a site's structural pages, the controls in its header, navigation, sidebar and footer, and where they lead, for that profile only. Page text, form values, queries and content areas are never stored; personal-looking path segments are masked. See README "Site map".
- `browser_site_map {tabId | origin, query?, cursor?}` (read-only): matching pages with ready `browser_click` locators, or an outline of the site. `browser_navigate` reminders add the page's known controls. The tool count is now 22.
- `browser_memory_policy` takes `map_enable`, `map_disable`, `map_exclude_path`, `map_include_path`, `map_inspect`, `map_export` and `map_delete`, each confirmed by the owner, and a `path` parameter.
- `npm run memory -- map status | enable | disable | exclude-path | include-path | inspect | export | delete`: owner CLI for the map. `delete <origin>` and `delete --all` also delete the matching maps.
- `scripts/map-bench.mjs` and `specs/004-site-navigation-map/baseline.md` for the map performance baseline.
- ADR-0004 (map storage and the profile boundary) and ADR-0005 (observing clicks), both proposed.

### Changed
- With the map on, `browser_click` is observed: the extension reports the tab URL before and after the click (no page script, no cookies). New extension capability `site-map`; an older extension keeps working, and the map then learns no click destinations.
- Shared JSON store helpers moved from `memory/store.ts` to `memory/record-files.ts`, without a behavior change.
- Roles follow HTML-AAM more closely: a `<header>` or `<footer>` inside `article`, `aside`, `main`, `nav` or `section` is `generic`, not `banner` or `contentinfo`, and `<article>` is `article`. `browser_snapshot` prints an unnamed `article` line where a post starts, and role locators see the new roles. `browser_text` article mode now keeps a `<header>` inside an `<article>` or `<main>`, as its tag rule intended.

## 3.1.0

### Added
- Website memory, off by default: agents sharing one Chrome profile can reuse a small set of allowlisted facts about a site (page language, search box, login form, well-known control names), stored locally under `<state dir>/memory/`. See README "Website memory".
- `browser_memory {tabId}` (read-only) and a labelled reminder on `browser_navigate` results when memory is on.
- `browser_memory_policy {action, tabId?}`: an agent can ask to enable, disable, exclude, include, inspect, export or delete memory; the owner must approve a prompt in the MCP client.
- `npm run memory -- status | enable | disable | exclude | include | inspect | export | delete`: owner CLI over the daemon's local socket.
- `scripts/memory-bench.mjs` for the memory performance baseline.

### Changed
- The extension requests the `cookies` permission (cookie names only, never values) to tell whether a page is anonymous. Chrome will ask to approve it: reload the extension at `chrome://extensions` and restart the daemon after updating. The tool count is now 21.

### Fixed
- A click, key, drag or `browser_evaluate` script that makes the page open a file chooser (an upload button, `input.click()`) no longer opens the native file dialog, which an agent cannot answer and which covered the user's screen on Windows. While agent input or a script runs, and for 0.5 s after it, Chrome intercepts the chooser and the page gets a cancel; the next result says `fileChooser:` and points to `browser_fill` with absolute paths. The user's own clicks show the dialog as before. Extension reload needed.

## 3.0.9

Reload the extension at `chrome://extensions` and restart the daemon (`npm run daemon:restart`) after updating.

### Added
- `browser_navigate` with `incognito: true` opens the new tab in a private window: an open one, else a new background window. It needs "Allow in Incognito" for the extension at `chrome://extensions`; without it the call fails `INCOGNITO_NOT_ALLOWED`. The window stays open when the session ends. `browser_tabs` marks private tabs with `incognito`, and a normal new tab never opens in a private window the user has focused. Extension reload needed.

### Changed
- `browser_wait` reads the names other browser tools use: `text` (a `text=` target), `textGone` (the same with `gone: true`), `time` (seconds) and `selector`. `browser_screenshot` ignores `scale`, `format` and `quality`. Each result says how the name was read, so the next call can use the 3.0 form. Any other unknown parameter fails as before, and the error now lists the parameters the tool takes.
- A `browser_wait` `TIMEOUT` says when the target matched nothing (a wrong selector) or only hidden elements.
- Right after the daemon starts, and within 60 s of an extension dropping, a call waits up to 15 s for the extension to reconnect, instead of failing `NOT_CONNECTED` after 5 s. With no extension seen for longer, the wait stays 5 s. `BC_RECONNECT_WAIT_MS` sets the longer wait; `0` keeps 5 s.

## 3.0.8

After updating: run `npm run build`, restart the daemon (`npm run daemon:restart`), reload the extension at `chrome://extensions`, and restart MCP clients that still run an older build.

### Security
- The daemon and the extension authenticate each other with the enrollment secret. The extension proves itself before the daemon accepts its connection, and the daemon signs its nonce-bound hello, so another local process or extension cannot pose as either side. `/pair` hands out the auth token only for a fresh proof under the secret. The secret reaches the extension through the native pairing host (`npm run setup:pairing`) or is pasted once in the popup; it is never sent over HTTP.
- `npm run pairing:rotate` replaces the enrollment secret and the daemon auth token and prints neither. Restart the daemon after it. Running MCP clients pick up the new token on their next reconnect.
- With safety mode on, `browser_evaluate` follows the site's effective action (`block`, `ask` or `allow`), as click, type and fill do.
- With safety mode on, click, type and fill check the classified element again just before the input. If the page swapped it, the call fails `SAFETY_TARGET_CHANGED` and no input is sent.
- Request and response bodies use one secret-key redaction policy, and every scalar under a secret key is hidden except numeric counters. JSON-escaped, URL-encoded and base64 forms of vault secrets of 8 or more characters are scrubbed too. `browser_evaluate` results are still not a secret-safe channel.
- Only the newest three vault recovery backups are kept. Each backup holds the key and every credential it had.
- The daemon refuses a tool name it does not know from an IPC client (`UNKNOWN_TOOL`).
- A malformed HTTP request target no longer crashes the daemon; it gets 400.
- Four transitive advisories under the MCP SDK are cleared (`npm audit` reports 0).

### Fixed
- `browser_fill` uploads to a hidden file input, as on Odoo. Target the input by selector (`input[type=file]`), its label, or the visible upload button, with absolute paths. No page fetch and no Chrome "Local network access" prompt is involved. The safety policy treats such a fill as an upload. Extension reload needed.
- With safety mode on, click, type and fill on an element failed in real pages: the classifier used patterns that Chrome does not send with the page function. Extension reload needed.
- A focused Enter inside a closed shadow root no longer fails `SAFETY_TARGET_CHANGED`.
- `browser_wait` ends with its own `TIMEOUT` inside the tool timeout on a frozen page, and a cancel stops it at once.
- An oversized `browser_evaluate` object result is cut in the page, so it no longer crosses the debugger in full.
- A tab lock no longer outlives its session when a release was lost while the extension was disconnected: the daemon sends its live sessions on each connect and the extension frees the others. A failed read of the stored lock state fails tool calls with `STATE_UNAVAILABLE` until a read succeeds, instead of starting empty. A late successful read keeps what happened meanwhile.
- A socket that never proved itself can no longer fail agents' calls during a reconnect. A connection that never answers the handshake is reported as such, with the reload hint, not as an older extension.
- Calls on a backed-up extension socket (over 4 MiB buffered) fail `BROWSER_BUSY` instead of queueing. An IPC client that sends no hello within 10 s is disconnected.
- A daemon or vault lock is taken over only once when stale, and a reused pid no longer blocks the daemon from starting. `npm run daemon:stop` keeps a live or starting daemon's lock, and `status` and `stop` report a missing build instead of "not running".
- `browser_batch` says a write step cut by the batch budget may have completed.
- A failed vault action reports its own reason (`DOCUMENT_CHANGED`, `ORIGIN_MISMATCH`, `VAULT_PAGE_UNRESPONSIVE`, `VAULT_ORIGIN_UNSUPPORTED`) instead of claiming the page has no password field.
- The popup says the daemon rejected the enrollment secret instead of "daemon not reachable".

## 3.0.7

### Added
- `browser_vault` gets private credential help for the current site. A call carries only an action (`status`, `list`, `fill`, `save_login`, `unlock`), a tab id and an opaque account handle: passwords are typed in the extension's **Open vault** page and never reach the tool call, its result or the daemon's log. A `fill` writes one saved password once and never submits the page.
- Accounts are kept per browser in an AES-256-GCM encrypted store whose key is a separate file with owner-only permissions. The Open vault page covers unlock, review, replacing and removing accounts, session grants, protected local recovery snapshots and restore. A recovery snapshot holds both the encrypted accounts and the key, so anyone with a copy can recover the accounts; keep that folder private. This is local app access, not encryption against another process running as the same OS user.
- A document that took a fill stays marked as protected after it, across worker and daemon reconnects, until the vault is locked or the tab is closed. While a protected or uncertain recovery state is live, profile-wide evaluation, mocks, raw logs and screenshots are blocked, and text and interaction results are redacted. A fill that cannot be proven safe fails `VAULT_OUTCOME_UNKNOWN` and leaves the document marked for recovery instead of guessing.
- No browser tool can read, click in or navigate the private vault page, and its tab is not listed as an ordinary tab. Extension reload needed.
- `browser_click`, `browser_type` and `browser_fill` accept optional `expect` postconditions and `observe: "diff"`; each returns a structured action receipt while keeping its existing text output. `browser_batch` collects receipts for those steps.
- `browser_safety` configures optional per-MCP-session allow/ask/block rules for recognized submit, delete and upload actions. `ask` uses client elicitation and fails closed if confirmation is unavailable.
- Element targets accept `{ role, name, nth? }` alongside the existing string locators. Names match exactly, and `nth` is zero-based.

### Changed
- `browser_tabs list` lists the user's other tabs (not focused, not owned by any session) as `[other]` lines with title and address. Before, they were counted as `+N other tabs`. Tabs that another session owns or drives are still only counted, in `+N tabs used by other agents`.

## 3.0.6

### Fixed
- `text=` matched a substring of an accessible name (an aria-label such as `Like, thumbs up` on a send-like icon button) and clicked it, so a click could send a message. It now matches only shown text: a containing match needs the words in the text that shows, and an accessible name counts only when it equals the words. Extension reload needed.

## 3.0.5

### Changed
- `browser_logs` lists the network requests of the current page only: the requests since the tab's last top-level load. Before, every call sent the tab's whole history again (up to 200 requests), although the agent already had what it read. Requests of earlier pages are counted in one line, `… N from earlier pages not shown (all: true lists them)`. Two new parameters:
  - `since: "r42"` lists only the requests after `r42`, so a later call sends only what is new.
  - `all: true` lists earlier pages too.

  `since` and `all` apply to the network list only, and not with `requestId`.

### Fixed
- A click, hover or key that the page never got was reported as done. Chrome shows its own dialog over a tab after a login with a password found in a data breach ("Change your password"). Permission prompts do the same. While it is open, the page gets none of the debugger's mouse and key input, but the input itself does not fail. Each input is now checked when it arrives, and one the page never got fails `INPUT_BLOCKED`, which says to close the dialog or use a new tab. Playwright does not meet this, because its fresh profile has no breach check.
- `browser_type` and `browser_fill` into a read-only field said `typed`. They now fail `ELEMENT_READONLY`, and nothing is typed.
- `browser_type` with text that left the field unchanged said `typed`. This happens when the page refuses the text, or the field is already at its `maxlength`. It now fails `VALUE_NOT_SET`, with the value the field kept, and its `maxlength` when it is full.
- An empty password field read `value: ••••`, so it looked filled. It now reads `value: ""`. `browser_fill` shows `kept ""` the same way.
- `text=` matched text that the page hides inside an element, for example a closed submenu or a `display: none` caption. Only text that is shown counts now. Open tabs get the new matching on their next call.
- A click on a link to a file said only `clicked`. When the click starts a page load, the call now waits up to 2 s for its response. A file adds `download: true (file <name>); Chrome saves it to the Downloads folder, the tab did not navigate` and a `download` field. A navigation slower than the 300 ms check is reported as `navigated:`.
- `browser_emulate` with `geolocation` said nothing when the site may not read the location, and the page's request then waited on Chrome's prompt or failed. The result now says `geolocation permission: not decided for this site` or `blocked for this site`, with a `permission` field. Only the user can allow it.
- An MCP client reconnected to the daemon once only. After a second `npm run daemon:restart`, every call of a client that had used its reconnect failed `NOT_CONNECTED: Not connected to daemon` until its MCP host restarted it (5 clients, 3 sessions back). A client now reconnects after every drop. Tries back off from 0.25 s to 5 s, up to 8 tries; then the next tool call tries again. A call made while the client reconnects waits up to 10 s for it, instead of failing at once. A client starts a daemon at most 3 times a minute: one that cannot stay up is not restarted in a loop, and calls then fail `NOT_CONNECTED: Not connected to daemon: the daemon was started 3 times in 60 s and did not stay up; see <path>/daemon.log`.
- During a restart, each client that found no daemon started one, and each but the first died with `Fatal: Error: Browser Controller daemon lock is held by live process <pid>` and a full stack. `~/.browser-controller/daemon.log` reached 228 MB. Now:
  - A client waits for a daemon whose `daemon.lock` names a live PID, instead of starting another.
  - A daemon that loses the lock writes one line (`… lock is held by live process <pid>; this daemon exits and clients use that one`) and exits with code 0. Its client connects to the first daemon.
  - A daemon that read the lock while the first one was still writing it took it as stale and removed it, so two daemons ran on one lock. A lock younger than 5 s that cannot be read now counts as held.
  - `daemon.log` larger than 5 MB moves to `daemon.log.1` before a daemon starts, from a client or from `npm run daemon:start`. One old copy is kept.
- The popup's ✕ on an agent that is still running: the agent connects again, as a new session. Before, this happened the first time only.
- A tab id that no longer named a tab failed `INTERNAL_ERROR: Tab 566237764 not found, call browser_tabs list first.`. A tab that `browser_navigate` replaced (a frozen tab) now fails `TAB_REPLACED` and names the new tab id; a tab that is gone fails `TAB_NOT_FOUND`. A tab that Chrome replaces (`chrome.tabs.onReplaced`: a discarded or prerendered tab) passes the session's lock and control to the new tab, as a frozen-tab replacement already did. The replacement map is in memory: after a worker restart an old id fails `TAB_NOT_FOUND`.

### Documented
- The console list has the page's own console calls and errors. Messages that Chrome writes itself (`Failed to load resource`, CSP and deprecation warnings) are not in it; a failed load shows in the network list.

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
