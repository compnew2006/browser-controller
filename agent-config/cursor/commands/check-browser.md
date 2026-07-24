# check-browser

Use Browser Controller to check what's currently showing in my browser.

## Steps

1. Call `browser_tabs { action: "list" }` to get a `tabId`
2. Call `browser_snapshot { tabId }` to see the current page structure (refs are tab-scoped)
3. Based on what you find, take a `browser_screenshot { tabId }` if visual verification is needed
4. Report back what you see - page title, key elements, any errors or unexpected state
5. If I asked you to verify something specific, focus on that

## When to use

- After making a code change, to verify it rendered correctly
- To check if a form works, a button does what it should, or content loaded
- To read page content I'm looking at
- To debug visual issues or check responsive layout

## Reading the snapshot efficiently

- **`isNew: true`** on a ref means that element appeared since the last snapshot — focus on those when something just changed (e.g. an overlay opened after a click). You don't need to re-read the whole tree.
- After `browser_scroll`, expect `refsMayBeStale: true` — re-snapshot before interacting on feeds like Facebook/Instagram that recycle DOM nodes.
- If a click returns `freshRefs`, the element was scrolled away — retry with one of the new refs in the same response (no separate snapshot needed).

## Important

- This is my REAL browser. I'm already logged in everywhere.
- Always pass `tabId` — never assume the active tab is the one to act on.
- Don't close tabs I didn't ask you to close.
- Don't navigate away from the current page unless I ask you to.
- Use element refs from snapshots for any interactions; refs are valid only for the tabId that produced them.
