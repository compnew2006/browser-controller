# Browser Controller - Agent Config

## Browser Control

This project has `browser-controller` configured. Use it to interact with the user's real browser.

The daemon runs on `127.0.0.1:7225` (WS + HTTP). The Chrome extension connects to it once paired: after a one-time `npm run setup:pairing` it pairs itself; otherwise the user pastes the enrollment secret from `~/.browser-controller/enrollment.json` into the popup's Settings (the auth token is fetched automatically). Multiple agents can connect at once — they share a single daemon, each getting its own sessionId (visible in the popup alongside its agent name and uptime). Reconnecting with the same agent name replaces the old session if it is dead; a live session with the same name keeps running beside the new one (each has its own sessionId). Dead connections are evicted by a heartbeat after ~45s. Name the agent explicitly with `--agent <name>` in the MCP config args, or `MCP_AGENT_NAME` env.

**Daemon lifecycle:** one daemon owns port `7225`; every MCP client is a thin adapter that talks to it over a local socket.

- **Default:** the first MCP client that finds no running daemon starts it; later clients connect to the same one. If a client loses the connection, it reconnects once — starting the daemon again if none is alive; if the connection drops a second time, the browser tools stay unavailable until the MCP client is restarted.
- **No takeovers:** a second daemon refuses to start — the `daemon.lock` names the live owner's PID, and a held port 7225 is reported as an error. Nothing is killed automatically.
- **Explicit control** (run inside the browser-controller checkout): `npm run daemon:start`, `npm run daemon:status` (JSON health), `npm run daemon:stop`, `npm run daemon:restart` (keeps the token and enrollment secret, so the extension stays paired).
- **Under a supervisor** (systemd — example unit in `deploy/systemd/` — or launchd): set `BROWSER_CONTROLLER_DAEMON_MODE=connect` in every MCP client's env, so clients only connect and never start a competing daemon. Don't combine a supervisor with self-starting clients.

## Tool discovery (progressive disclosure)

By default, all 31 browser tools are visible directly (`browser_click`, `browser_snapshot`, etc.). No discovery step needed.

To cut tool-definition tokens, set `BROWSER_CONTROLLER_PROGRESSIVE=1` in the agent's env: the initial tools/list drops ~96% (~150 vs ~4200 tokens); a typical task that activates 3-5 tools still nets ~75-80%. Then only `browser_tools` is visible, and you discover + activate others on demand:

1. `browser_tools { action: "list" }` — see all tool names + short summaries (~400 tokens vs ~4200)
2. `browser_tools { action: "search", query: "click" }` — find tools by keyword
3. `browser_tools { action: "details", tool: "browser_click" }` — get the full schema AND activate the tool (it becomes callable directly after this)

Once activated, a tool stays visible for the rest of the session. You only need to activate each tool once.

## CRITICAL: Tab targeting (v2)

This is a multi-client server. **Never assume which tab your actions hit.** You MUST target a tab explicitly with `tabId`.

1. `browser_tabs` with `action: "list"` → get a `tabId`
2. Pass that **same** `tabId` to every page-interaction tool
3. Refs from a snapshot are valid **only for the tabId that produced them**
4. For exclusive access: `browser_tabs { action: "lock", tabId }` → `unlock` when done. A listed tab with `controlledBy` is being driven by another agent right now — pick another tab or lock it first

Note: while any tool runs on a tab, the USER sees a blue frame and their input on that tab is blocked (that is by design — it protects your workflow); a lock keeps the frame for the lock's whole lifetime.

## Element refs + automatic recovery

Refs (`e5`) can break on dynamic sites (React re-renders, virtualized feeds like Facebook/Instagram). The extension handles this automatically — you don't need to do anything special:

- If a ref breaks but the element still exists → it's found via a robust CSS selector, then text+role scan. The response includes `via: "fallback"`.
- If the element is gone entirely (scrolled away) → the response includes `freshRefs: [...]` with a fresh snapshot so you can retry in ONE step with a new ref. Do not re-send the old ref.
- After `browser_scroll`, expect `refsMayBeStale: true` — re-snapshot before your next interaction on virtualized feeds.

## Tools (31 + `browser_tools`)

Every page tool needs `tabId`; only `browser_navigate` makes it optional.

Reading: `browser_text` (cheapest read; `mode: "article"`, `offset` paging), `browser_snapshot` (refs; `source: "native"` = Chrome's own tree), `browser_find` (natural-language lookup → refs), `browser_screenshot` (`maxWidth` / `format: "jpeg"` cut tokens; the result maps image pixels to click `x`/`y`), `browser_observe` (compact state + `snapshotId` for `browser_act`)
Interaction: `browser_click` (`ref` / `selector` / `x`+`y`, `clickCount`, `modifiers`), `browser_click_text`, `browser_type` (follow with Tab to commit), `browser_press_key` (combos, sequences, `repeat`), `browser_scroll`, `browser_hover`, `browser_select`, `browser_drag`, `browser_fill_form`, `browser_upload_file` (local paths, sets `<input type="file">` with no dialog, fires input+change; or `imageBase64` / `fromScreenshot`), `browser_wait` (selector, `text`, `urlIncludes` or `delay`), `browser_act` (validated action on a `browser_observe` snapshot)
Chain & record: `browser_batch` (up to 200 tool calls in one round-trip, stops at the first failing step), `browser_shortcuts` (save a flow with `{{variables}}`, `run` it in one call), `browser_gif` (record the tab as an animated GIF, clicks marked with a red ring; `export` writes the file and returns its `path`)
Tabs & windows: `browser_navigate` (also `"back"` / `"forward"`; returns an inline snapshot unless `snapshot: false`), `browser_tabs` (list/create/close/focus/reload/lock/unlock), `browser_resize_window` (responsive testing — resizes the user's window), `browser_list_browsers` / `browser_select_browser` (when several Chrome profiles are connected)
JS/Dialogs: `browser_evaluate` (DevTools-console style over CDP by default: not blocked by page CSP, yellow debugger banner; `mode: "scripting"` = no banner but CSP-bound), `browser_handle_dialog` (works even on a frozen page), `browser_run_action` (action object via CDP, always)
Debug (per-tab, capped 200 entries): `browser_console` (`pattern`, `level`, `limit`), `browser_network` (`urlPattern`, `filter`, `failed`, `limit`), `browser_intercept` (block/redirect/add request headers, captures, HAR export — check `enforcement` in the result)

## Pattern

1. `browser_tabs { action: "list" }` → pick a `tabId`
2. `browser_snapshot { tabId }` to see the page and get refs (refs are tab-scoped). Add `source: "native"` for Chrome's own accessibility tree (exact accessible names, roles and states; uses the debugger) when the default tree misses or mislabels a control
3. Use `{ tabId, ref }` with interaction tools
4. Re-snapshot after navigation/DOM changes to refresh refs
5. `browser_wait { tabId, selector }` before interacting with dynamic content
6. On a `freshRefs` response, retry with one of the new refs immediately (no separate snapshot needed)
7. Several steps you already know → one `browser_batch { tabId, actions: [{ tool, params }, …] }` call
8. When acting must fail safely on a changing page → `browser_observe { tabId }`, then `browser_act { tabId, snapshotId, action, ref }`; `DOCUMENT_CHANGED` / `STALE_STATE` / `TARGET_OCCLUDED` / `ACTION_NOT_ALLOWED` mean nothing was done — observe again
9. To show the user what you did → `browser_gif { tabId, action: "start" }` before the flow, `{ action: "export" }` after, and give them the returned `path`
