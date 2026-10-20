# Changelog

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
