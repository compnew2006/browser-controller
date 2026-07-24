# Real Browser MCP - Agent Config

## Browser Control

This project has `real-browser-mcp` configured. Use it to interact with the user's real browser.

The MCP server runs on `ws://127.0.0.1:7225` by default. The Chrome extension connects automatically. Multiple agents can connect at once — they share a single daemon.

## CRITICAL: Tab targeting (v2)

This is a multi-client server. **Never assume which tab your actions hit.** You MUST target a tab explicitly with `tabId`.

1. `browser_tabs` with `action: "list"` → get a `tabId`
2. Pass that **same `tabId`** to every page-interaction tool
3. Refs from a snapshot are valid **only for the tabId that produced them**
4. For exclusive access: `browser_tabs { action: "lock", tabId }` → `unlock` when done

## Tools

Navigation: `browser_navigate` (tabId optional), `browser_tabs` (list/create/close/focus/lock/unlock)
Interaction (tabId required): `browser_click`, `browser_click_text`, `browser_type`, `browser_press_key`, `browser_scroll`, `browser_hover`, `browser_select`
Reading (tabId required): `browser_snapshot`, `browser_screenshot`, `browser_text`, `browser_find`
Waiting (tabId required): `browser_wait`
JS/Dialogs (tabId required): `browser_evaluate` (MAIN world, no banner), `browser_handle_dialog`
Debug (tabId required, per-tab): `browser_console`, `browser_network`

## Pattern

1. `browser_tabs { action: "list" }` → pick a `tabId`
2. `browser_snapshot { tabId }` to see the page and get refs (refs are tab-scoped)
3. Use `{ tabId, ref }` with interaction tools
4. Re-snapshot after navigation/DOM changes to refresh refs
5. `browser_wait { tabId, selector }` before interacting with dynamic content
