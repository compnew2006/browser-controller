# Browser Controller - Agent Config

## Browser Control

This project has `browser-controller` configured. Use it to interact with the user's real browser.

The daemon runs on `127.0.0.1:7225` (WS + HTTP). The Chrome extension auto-pairs a token and connects automatically. Multiple agents can connect at once — they share a single daemon, each getting its own sessionId (visible in the popup alongside its agent name and uptime). Reconnecting with the same agent name replaces the old session (no duplicates), and dead connections are evicted by a heartbeat after ~45s. Name the agent explicitly with `--agent <name>` in the MCP config args, or `MCP_AGENT_NAME` env.

## Tool discovery (progressive disclosure)

By default, all 22 browser tools are visible directly (`browser_click`, `browser_snapshot`, etc.). No discovery step needed.

To cut tool-definition tokens, set `BROWSER_CONTROLLER_PROGRESSIVE=1` in the agent's env: the initial tools/list drops ~96% (~150 vs ~4200 tokens); a typical task that activates 3-5 tools still nets ~75-80%. Then only `browser_tools` is visible, and you discover + activate others on demand:

1. `browser_tools { action: "list" }` — see all tool names + short summaries (~400 tokens vs ~4200)
2. `browser_tools { action: "search", query: "click" }` — find tools by keyword
3. `browser_tools { action: "details", tool: "browser_click" }` — get the full schema AND activate the tool (it becomes callable directly after this)

Once activated, a tool stays visible for the rest of the session. You only need to activate each tool once.

## CRITICAL: Tab targeting (v2)

This is a multi-client server. **Never assume which tab your actions hit.** You MUST target a tab explicitly with `tabId`.

1. `browser_tabs` with `action: "list"` → get a `tabId`
2. Pass that **same `tabId`** to every page-interaction tool
3. Refs from a snapshot are valid **only for the tabId that produced them**
4. For exclusive access: `browser_tabs { action: "lock", tabId }` → `unlock` when done

## Element refs + automatic recovery

Refs (`e5`) can break on dynamic sites (React re-renders, virtualized feeds like Facebook/Instagram). The extension handles this automatically — you don't need to do anything special:

- If a ref breaks but the element still exists → it's found via a robust CSS selector, then text+role scan. The response includes `via: "fallback"`.
- If the element is gone entirely (scrolled away) → the response includes `freshRefs: [...]` with a fresh snapshot so you can retry in ONE step with a new ref. Do not re-send the old ref.
- After `browser_scroll`, expect `refsMayBeStale: true` — re-snapshot before your next interaction on virtualized feeds.

## Tools (22)

Navigation: `browser_navigate` (tabId optional), `browser_tabs` (list/create/close/focus/lock/unlock)
Interaction (tabId required): `browser_click`, `browser_click_text`, `browser_type`, `browser_press_key`, `browser_scroll`, `browser_hover`, `browser_select`, `browser_drag`, `browser_fill_form`, `browser_upload_file`
Reading (tabId required): `browser_snapshot`, `browser_screenshot`, `browser_text`, `browser_find`
JS/Dialogs (tabId required): `browser_evaluate` (MAIN world, no banner), `browser_handle_dialog`, `browser_run_action`
Waiting: `browser_wait`
Debug (tabId required, per-tab, capped 200 entries): `browser_console`, `browser_network`

## Pattern

1. `browser_tabs { action: "list" }` → pick a `tabId`
2. `browser_snapshot { tabId }` to see the page and get refs (refs are tab-scoped)
3. Use `{ tabId, ref }` with interaction tools
4. Re-snapshot after navigation/DOM changes to refresh refs
5. `browser_wait { tabId, selector }` before interacting with dynamic content
6. On a `freshRefs` response, retry with one of the new refs immediately (no separate snapshot needed)
