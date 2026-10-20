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
- To read page content I'm looking at (`browser_text` is the cheapest read)
- To debug visual issues or check responsive layout (`browser_emulate { tabId, viewport }`)

## Reading the page efficiently

- Use `query` or `target` on `browser_snapshot` to read one part of a large page.
- After a click that opens something, snapshot again with `query` for what appeared.
- A `REF_GONE` error means the page changed: take a new `browser_snapshot` and use its refs.
- Use `browser_logs { tabId, errors: true }` for console errors and failed requests.

## Important

- This is my REAL browser. I'm already logged in everywhere.
- Always pass `tabId` — never assume the active tab is the one to act on.
- Don't close tabs I didn't ask you to close.
- Don't navigate away from the current page unless I ask you to.
- Use element refs from snapshots for any interactions; refs are valid only for the tabId that produced them.
