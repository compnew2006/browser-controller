---
name: browser-automation
description: Control the user's real browser via Real Browser MCP. Use when asked to interact with web pages, test UIs, fill forms, or read page content.
---

# Browser Automation with Real Browser MCP

Use this skill when you need to interact with the user's actual browser - clicking, typing, reading pages, taking screenshots, or navigating.

## CRITICAL: Always target a tab explicitly (v2)

This is a **multi-client** server — other agents may be using other tabs. You MUST pass `tabId` to every page-interaction tool; actions never hit "the active tab" implicitly.

1. First call `browser_tabs` with `action: "list"` to discover tabs and get a `tabId`
2. Pass that same `tabId` to `browser_snapshot`, `browser_click`, `browser_type`, etc.
3. Refs from a snapshot are valid **only for the tabId that produced them** — never reuse a ref from tab 10 on tab 20
4. If you need exclusive use of a tab, `browser_tabs { action: "lock", tabId }` first, then `unlock` when done

If `tabId` is missing you'll get: *"tabId is required. Call browser_tabs list first."*

## Before You Start

1. Verify the extension is connected: `browser_tabs { action: "list" }` (returns the tab list)
2. If disconnected, ask the user to check the extension icon (should show green "ON")
3. Never close tabs you didn't create

## Reading Pages

`browser_snapshot { tabId }` returns the accessibility tree with refs like "e12" that you use for interaction.

For large pages, scope with a selector: `browser_snapshot { tabId, selector: "main" }`.

Use `browser_text { tabId }` to extract raw text when you need full content.

## Interacting

Always pass `tabId`, then use refs from that tab's snapshot:
- `browser_click { tabId, ref: "e12" }`
- `browser_type { tabId, ref: "e5", text: "hello" }`
- `browser_press_key { tabId, key: "Enter" }`
- `browser_scroll { tabId, direction: "down" }`

## Dynamic Content (SPAs, social media)

1. `browser_scroll { tabId, direction: "down" }` to load more
2. `browser_wait { tabId, selector }` for lazy-loaded elements
3. Snapshot again after scrolling - refs are regenerated
4. For virtual scroll containers (Twitter, Reddit), pass the container's CSS selector to `browser_scroll`

## Debugging (per-tab)

- `browser_console { tabId }` reads console output for that tab
- `browser_network { tabId }` shows XHR/fetch requests for that tab
- `browser_screenshot { tabId }` captures the tab (activates it first to capture)

## Common Mistakes

- Forgetting `tabId` → "tabId is required" error
- Using a ref from one tabId against a different tabId
- Using stale refs after navigation/scroll (always re-snapshot)
- Holding a tab lock too long (other agents queue behind you)
