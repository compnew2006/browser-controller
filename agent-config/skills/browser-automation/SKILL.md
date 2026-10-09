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

### If only `browser_tools` is visible (progressive mode)

The server hides tool definitions until needed (`BROWSER_CONTROLLER_PROGRESSIVE=1`). Use `browser_tools { action: "list" }` or `{ action: "search", query: "…" }` to discover tools, then `{ action: "details", tool: "browser_click" }` to get the schema and activate it. A `"Tool X disabled"` error means activate it via `details` first; once activated it stays callable for the session.

## Reading Pages

`browser_snapshot { tabId }` returns the accessibility tree with refs like "e12" that you use for interaction.

For large pages, scope with a selector: `browser_snapshot { tabId, selector: "main" }`.

When the default tree mislabels or misses a control (custom widgets, `aria-labelledby` chains, `aria-hidden` overlays), ask for Chrome's own accessibility tree: `browser_snapshot { tabId, source: "native" }`. Same output shape and the refs work with every tool; it attaches the debugger (yellow banner) and falls back to the default tree, with `nativeUnavailable`, if it can't.

Use `browser_text { tabId }` to extract raw text when you need full content — it is the cheapest read (`mode: "article"` keeps only the main content; page long text with `offset`).

To locate one control without a full snapshot: `browser_find { tabId, query: "search input" }` returns refs you can use directly.

### Reading efficiently (don't re-scan everything)

- **`isNew: true`** on a ref means that element appeared since the last snapshot. When something just changed (an overlay opened after a click, a dropdown rendered), filter to `isNew` refs instead of re-reading the whole tree — big token saver on large pages.
- After `browser_scroll`, expect **`refsMayBeStale: true`** — the feed may have recycled DOM nodes. Re-snapshot before your next interaction.

## Interacting

Always pass `tabId`, then use refs from that tab's snapshot:
- `browser_click { tabId, ref: "e12" }`
- `browser_type { tabId, ref: "e5", text: "hello" }`
- `browser_press_key { tabId, key: "Enter" }`
- `browser_scroll { tabId, direction: "down" }`

Also available: `browser_navigate { tabId, url }` (returns an inline snapshot of the new page), `browser_click_text { tabId, text }` (React portals/overlays missing from the snapshot), `browser_hover`, `browser_select` (native `<select>`), `browser_drag`, `browser_handle_dialog { tabId, action: "accept" }` (an alert/confirm/prompt freezing the page) and `browser_run_action` (a JS action object via CDP).

### When a ref breaks (automatic recovery)

On dynamic sites (React re-renders, virtualized feeds) refs can go stale. The extension handles this automatically — you usually don't need to do anything:

- The response includes **`via: "fallback"`** if the element was found via a robust selector or text+role scan. Keep going, but know that ref may be stale for future calls — re-snapshot when convenient.
- If the response includes **`freshRefs: [...]`**, the element was scrolled away entirely and a fresh snapshot was captured inline. **Retry with one of the new refs in the same step** — no separate snapshot needed.

### Forms, keys and files

- `browser_fill_form { tabId, fields: [{ ref: "e5", value: "a@b.c" }, { ref: "e7", value: true }], submit: true }` fills several fields in one call
- `browser_type` types like a person: `change` fires only when focus leaves, so follow it with `browser_press_key { tabId, key: "Tab" }`
- `browser_press_key` takes combos (`"ctrl+a"`) and sequences (`"ArrowDown ArrowDown Enter"`)
- `browser_upload_file { tabId, ref, filePath: "/abs/path/file.pdf" }` sets a file input without opening the file dialog
- No ref? `browser_click` also takes `x` / `y` read off a `browser_screenshot` (the screenshot result tells you how image pixels map to them)

### Fewer round-trips: `browser_batch`

When you already know the next steps, send them in ONE call. It stops at the first failing step and skips the rest, so you never act on a page that didn't reach the expected state:

```
browser_batch { tabId: 15, output: "last", actions: [
  { tool: "browser_click",     params: { ref: "e3" } },
  { tool: "browser_type",      params: { ref: "e5", text: "hello@example.com" } },
  { tool: "browser_press_key", params: { key: "Tab" } },
  { tool: "browser_wait",      params: { text: "Welcome" } }
] }
```

The top-level `tabId` applies to every step that doesn't set its own. Use `output: "last"` or `"errors"` on long batches to save tokens; `continueOnError: true` keeps going after a failure.

### Acting safely on a changing page: `browser_observe` → `browser_act`

`browser_observe { tabId }` returns a `snapshotId` and compact refs with their `allowedActions`. `browser_act { tabId, snapshotId, action: "click", ref }` re-checks the page (document, visibility, enabled state, what covers the click point) before acting. `DOCUMENT_CHANGED`, `STALE_STATE`, `TARGET_OCCLUDED` or `ACTION_NOT_ALLOWED` mean nothing was done — call `browser_observe` again.

## Repeated Flows: `browser_shortcuts`

Save a flow once with `{{variables}}`, then run it in one call with different values:

```
browser_shortcuts { action: "save", name: "add-todo", description: "Add an item to the todo list", actions: [
  { tool: "browser_click",     params: { selector: "#new-todo" } },
  { tool: "browser_type",      params: { text: "{{item}}" } },
  { tool: "browser_press_key", params: { key: "Enter" } }
] }
browser_shortcuts { action: "run", name: "add-todo", tabId: 15, vars: { item: "Buy milk" } }
```

`list`, `show` and `delete` manage them. A run behaves like `browser_batch` (stops at the first failing step). Shortcuts are stored locally in `~/.browser-controller/shortcuts.json`.

## Showing the User What You Did: `browser_gif`

1. `browser_gif { tabId, action: "start" }` before the flow
2. Do the work — a frame is captured after every page-changing action (navigate, click, type, keys, scroll, forms…); clicks are marked with a red ring
3. `browser_gif { tabId, action: "export" }` writes a `.gif` (default `~/Downloads/browser-recording-<time>.gif`, or pass `path`) and returns its `path` — tell the user where it is

Read-only tools (snapshot, text, find…) add no frames; add one with `action: "frame"`. `stop` pauses, `status` reports the frame count, `clear` discards. A background tab is shown for a moment per frame because Chrome doesn't paint hidden tabs.

## Network Control: `browser_intercept`

Block, redirect or add request headers for one tab with `action: "set-rules"` (rules match a URL regex), see matched requests with `list-captures`, and export a HAR with `export-har` (headers and bodies are left out). Always check `enforcement` in the result: `capture-only` means Chrome is not applying the rules, and `mock` rules are only recorded — Chrome can't fake response bodies.

## Running JavaScript

`browser_evaluate { tabId, expression }` works like the DevTools console: top-level `await`, several statements, the last expression's value is returned. It runs over CDP, so page CSP doesn't block it (a yellow "being debugged" banner shows meanwhile). Use `browser_click` / `browser_type` rather than dispatching events by hand.

## Windows and Browsers

- `browser_resize_window { tabId, width: 390, height: 844 }` for responsive checks — it resizes the user's window, so prefer a separate one; `state` (`"normal"`, `"maximized"`, `"minimized"`, `"fullscreen"`) switches the window state
- Several Chrome profiles connected? `browser_list_browsers`, then `browser_select_browser { browserId }`. Tab ids belong to their browser — list tabs again after switching

## Dynamic Content (SPAs, social media)

1. `browser_scroll { tabId, direction: "down" }` to load more
2. `browser_wait { tabId, selector }` for lazy-loaded elements
3. After scrolling, expect `refsMayBeStale: true` → snapshot again before interacting
4. For virtual scroll containers (Twitter, Reddit), pass the container's CSS selector to `browser_scroll`

## Debugging (per-tab)

- `browser_console { tabId, pattern: "error|fail" }` reads console output for that tab (filter with `pattern`, `level`, `limit`)
- `browser_network { tabId, failed: true }` shows requests for that tab (`urlPattern`, `filter`, `failed`, `limit`)
- `browser_screenshot { tabId, maxWidth: 1024, format: "jpeg" }` captures the tab over CDP (a background tab is shown for a moment); `maxWidth` and JPEG keep the image small

## Common Mistakes

- Forgetting `tabId` → "tabId is required" error
- Using a ref from one tabId against a different tabId
- Ignoring `freshRefs` and re-sending a stale ref that already failed
- Re-reading the whole tree when `isNew` refs would suffice
- Holding a tab lock too long (other agents queue behind you)
- Five separate calls for steps you already knew — one `browser_batch` would do
- Resizing the user's own window for a responsive check without asking
