---
name: browser-automation
description: Control the user's real browser via Browser Controller. Use when asked to interact with web pages, test UIs, fill forms, or read page content.
---

# Browser Automation with Browser Controller

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

### Reading efficiently (don't re-scan everything)

- **`isNew: true`** on a ref means that element appeared since the last snapshot. When something just changed (an overlay opened after a click, a dropdown rendered), filter to `isNew` refs instead of re-reading the whole tree — big token saver on large pages.
- After `browser_scroll`, expect **`refsMayBeStale: true`** — the feed may have recycled DOM nodes. Re-snapshot before your next interaction.

## Interacting

Always pass `tabId`, then use refs from that tab's snapshot:
- `browser_click { tabId, ref: "e12" }`
- `browser_type { tabId, ref: "e5", text: "hello" }`
- `browser_press_key { tabId, key: "Enter" }`
- `browser_scroll { tabId, direction: "down" }`

### When a ref breaks (automatic recovery)

On dynamic sites (React re-renders, virtualized feeds) refs can go stale. The extension handles this automatically — you usually don't need to do anything:

- The response includes **`via: "fallback"`** if the element was found via a robust selector or text+role scan. Keep going, but know that ref may be stale for future calls — re-snapshot when convenient.
- If the response includes **`freshRefs: [...]`**, the element was scrolled away entirely and a fresh snapshot was captured inline. **Retry with one of the new refs in the same step** — no separate snapshot needed.

## Dynamic Content (SPAs, social media)

1. `browser_scroll { tabId, direction: "down" }` to load more
2. `browser_wait { tabId, selector }` for lazy-loaded elements
3. After scrolling, expect `refsMayBeStale: true` → snapshot again before interacting
4. For virtual scroll containers (Twitter, Reddit), pass the container's CSS selector to `browser_scroll`

## Debugging (per-tab)

- `browser_console { tabId }` reads console output for that tab
- `browser_network { tabId }` shows XHR/fetch requests for that tab
- `browser_screenshot { tabId }` captures the tab (activates it first to capture)

## Common Mistakes

- Forgetting `tabId` → "tabId is required" error
- Using a ref from one tabId against a different tabId
- Ignoring `freshRefs` and re-sending a stale ref that already failed
- Re-reading the whole tree when `isNew` refs would suffice
- Holding a tab lock too long (other agents queue behind you)
