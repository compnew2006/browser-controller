# Inventory — Chrome extension (MV3, JavaScript)

The browser side: service worker router, tool handlers, page-side scripts, popup UI, vault page.

Symbols: **686** across **44** files.

Evidence column: `D` = purpose taken from the doc comment in the source; `R` = purpose written after reading the body; `B` = no doc comment, the quoted line is the whole body; `N` = no doc comment and a multi-statement body, so the purpose is derived from the identifier only (shown with `~`) — treat those as a label, not a verified description.

## extension/events.js

225 lines · 4 symbols · 1 exported · fan-in 1 · fan-out 6

| line | kind | symbol | purpose | ev |
|---:|---|---|---|---|
| 47 | function | releaseVaultTabState (async) | The vault state a tab owned when it closed or was replaced: its private UI page and its protected documents. … | D |
| 53 | function | registerEventListeners (exp, cx29) | ~ registers event listeners | N |
| 145 | object-function | store | ~ store | N |
| 200 | function | watchOpenedTabs | A tab that an agent's own tab opens (a target=_blank link, window.open) is that agent's tab too, so browser_tabs lists … | D |

## extension/handlers/action-safety.js

117 lines · 3 symbols · 1 exported · fan-in 1 · fan-out 2

| line | kind | symbol | purpose | ev |
|---:|---|---|---|---|
| 15 | function | pageActionCategories (cx42) | Page side. This returns risk categories, never the page's label or field value. | D |
| 21 | const-function | focusedElement | ~ focused element | N |
| 74 | function | handleClassifyAction (exp, async, cx38) | Internal wire action; not exposed as an MCP tool. | D |

## extension/handlers/emulate.js

165 lines · 9 symbols · 2 exported · fan-in 1 · fan-out 3

| line | kind | symbol | purpose | ev |
|---:|---|---|---|---|
| 20 | function | isProtectedUrl | Browser-internal pages refuse a debugger; about:blank is an ordinary page to emulate. | D |
| 25 | function | realUserAgentMetadata (async) | The real browser's client hints, as navigator.userAgentData reports them here; undefined when unavailable. | D |
| 47 | const-function | lostWarningOf | ~ lost warning of | N |
| 50 | function | activeLines | One line per active override, as the agent reads it. | D |
| 75 | function | geolocationPermission (async) | The page's geolocation permission state ("granted", "prompt", "denied"), or undefined when the page cannot tell. | D |
| 89 | function | report | The result: `text` is what the agent reads; `active` and `lost` are data. | D |
| 99 | function | resetReport | Result of reset: the overrides it cleared (data), or "no overrides" when there were none. | D |
| 112 | function | clearEmulation (exp, async) | Clear every override this handler can set on the tab, and forget them in the stored state. The session is … | D |
| 138 | function | handleEmulate (exp, async) | ~ handles emulate | N |

## extension/handlers/evaluate.js

163 lines · 9 symbols · 1 exported · fan-in 1 · fan-out 4

| line | kind | symbol | purpose | ev |
|---:|---|---|---|---|
| 15 | const-function | pause | ~ pause | N |
| 18 | function | evaluateReply | The `text` of an evaluate reply: the value as compact JSON, strings unquoted; cut at EVAL_TEXT_MAX_CHARS. | D |
| 37 | function | handleEvaluate (exp, async) | browser_evaluate (contract 3.0): the source is one expression, or statements that `return` a value. Over CDP (page CSP does not … | D |
| 75 | function | evalStep | The page side of the chrome.scripting fallback, run in the page's main world (serialized into the page: it uses nothing … | D |
| 76 | const-function | forget | ~ forget | N |
| 120 | function | evaluateByScripting (async) | The chrome.scripting path (the debugger cannot attach). The page runs the source through evalStep; a SYNC poll reads the value … | D |
| 122 | const-function | left | ~ left | N |
| 130 | const-function | onPage | ~ callback for page | N |
| 132 | const-function | giveUp (async) | Gives up on the run: a value it settles later is discarded on the page. Bounded, since a busy page … | D |

## extension/handlers/inspect.js

166 lines · 7 symbols · 1 exported · fan-in 1 · fan-out 5

| line | kind | symbol | purpose | ev |
|---:|---|---|---|---|
| 22 | function | coded | `const err = new Error(`${code}: ${message}`);` | B |
| 28 | function | matchedRules (async) | ~ matched rules | N |
| 47 | function | listenersOf (async) | ~ listeners of | N |
| 57 | const-function | listen (async) | ~ listen | N |
| 86 | function | inspectCdpFailure | A CDP error once the debugger is attached, worded by what it says: a node the page no longer has … | D |
| 99 | function | debuggerInspect (async) | The CDP reads for the element at `path` (pageInspect's path): rules and/or listeners; null when the DOM moved on. A … | D |
| 126 | function | handleInspectElement (exp, async, cx23) | ~ handles inspect element | N |

## extension/handlers/inspection.js

595 lines · 35 symbols · 4 exported · fan-in 2 · fan-out 7

| line | kind | symbol | purpose | ev |
|---:|---|---|---|---|
| 31 | const-function | pause | ~ pause | N |
| 34 | function | intOption | An integer option within [lo, hi]; `fallback` when it is missing. | D |
| 40 | function | failureOf | A page result's failure as the wire error. A ref miss is worded from `issued` (lib/ref-errors.js). | D |
| 46 | const-function | reboundLine | The note line a reply carries when its target ref was re-found by its descriptor ("" when it was not). | D |
| 49 | function | fallbackFor | The fallback descriptor of a ref target (the snapshot's re-find recipe), or null. | D |
| 54 | function | globSource | browser_wait: a `URL` glob (" " = any run of characters) as a RegExp source, anchored to the whole URL. | D |
| 63 | function | handleWait (exp, async, cx28) | browser_wait (contract 3.0): exactly one of target / URL / ms. `target` waits until it is visible (`gone: true`: hidden … | D |
| 72 | const-function | elapsed | ~ elapsed | N |
| 73 | const-function | ok | ~ ok | N |
| 108 | function | waitPage | Page side of browser_wait: one poll of the condition. Self-contained (serialized into the page). | D |
| 132 | function | positionLine | The position line of a scroll reply: `x: 40 y: 1234 atEnd: false` (x only when scrolled sideways). | D |
| 137 | function | edgeOf | The edge a scroll heads for, for the NOT_SCROLLABLE reason. | D |
| 148 | function | handleScroll (exp, async) | browser_scroll (contract 3.0). `target` alone scrolls it into view (instant). With dx/dy, a real mouse wheel (CDP Input.dispatchMouseEvent) at the … | D |
| 204 | function | settleScroll (async) | Polls the scroll position until two reads in a row agree (a wheel scrolls smoothly), or the settle budget ends. … | D |
| 227 | function | scrollAimPage (cx42) | Page side of a wheel: where the wheel lands (the target's centre, after scrolling it into view, or the viewport … | D |
| 247 | const-function | scrolls | ~ scrolls | N |
| 248 | const-function | movable | ~ movable | N |
| 273 | function | scrollStatePage | Page side: the scroll position of the container the last wheel aimed at, and whether it is at the edge … | D |
| 288 | function | scrollIntoViewPage (cx25) | Page side of `target` alone: scroll it into view (instant) and report the container that moved. | D |
| 297 | const-function | scrolls | ~ scrolls | N |
| 326 | function | handleSnapshot (exp, async) | browser_snapshot (contract 3.0): the page as text lines, one per element that matters, indented by depth: `role "name" [e12] value="…" … | D |
| 355 | function | snapshotPage (cx134) | Page side of browser_snapshot. Self-contained: chrome.scripting serializes this function, so helpers live inside it. Two passes: the printable tree (items), … | D |
| 377 | const-function | isCheckable | ~ tests whether checkable | N |
| 378 | const-function | kidsOf | ~ kids of | N |
| 381 | function | nameOf | Name for the line: landmarks and generic wrappers take an explicit label or their own text only. | D |
| 392 | function | labelledCheckable | A native checkbox/radio drawn over by its visible label is the control a person clicks. | D |
| 399 | function | vis | 'show' = a line of its own, 'pass' = no box of its own (children still count), false = hidden … | D |
| 413 | function | crossOriginOf | A same-origin frame is walked; one whose document cannot be read is named, not dropped. | D |
| 421 | const-function | valueOf | ~ value of | N |
| 430 | function | flagsOf | Flags that apply, in the order the line prints them. | D |
| 432 | const-function | aria | ~ aria | N |
| 450 | const-function | visit | ~ visit | N |
| 513 | const-function | lineOf | ~ line of | N |
| 562 | function | handleGetPageText (exp, async) | browser_text (contract 3.0): the readable text of the page, or of `target`, through one walker (same-origin frames and open shadow … | D |
| 577 | function | textPage | Page side of browser_text: the visible text of the root, cut to `max` (the rest is only counted). | D |

## extension/handlers/interaction-advanced.js

365 lines · 15 symbols · 2 exported · fan-in 1 · fan-out 5

| line | kind | symbol | purpose | ev |
|---:|---|---|---|---|
| 18 | function | shortMessage | The dialog's message as one short line (line breaks become spaces), or null when there is none. | D |
| 33 | function | handleDialog (exp, async) | browser_handle_dialog: answers the JavaScript dialog open on the tab, over the tab's debugger session. The session records each dialog as … | D |
| 74 | function | pageFieldKind (cx26) | Page-side: the kind of field a target is, and its state. Reads only: no scroll, no focus, no input. Kinds: … | D |
| 106 | function | pageSetPicker | Page-side: set a picker input (date, time, datetime-local, month, week, color, range) as the picker does: the native value setter … | D |
| 126 | function | pageAriaChecked | Page-side: the aria-checked state of a target now (ARIA checkbox, radio or switch). | D |
| 138 | function | pageChooseOptions | Page-side: pick options of a <select>. A value matches the option's value exactly, else its label (trimmed, case-insensitive). A miss … | D |
| 145 | const-function | labelOf | ~ label of | N |
| 165 | function | pageMarkFile | Page-side: mark the file input with a one-shot token (CDP finds it by the marker). | D |
| 177 | function | pageUnmarkFile | Page-side: remove the one-shot marker, wherever the input lives. | D |
| 185 | function | findMarkedExpression | Main-world expression returning the node marked data-bc-upload=token (pierces open shadow roots / same-origin frames). | D |
| 197 | const-function | isAbsolutePath | An absolute path: POSIX (/…) or a Windows drive (C:\\… or C:/…). | D |
| 200 | function | setFiles (async) | DOM.setFileInputFiles on a file input (the input's marker is found over CDP). Returns an error string or null. | D |
| 223 | function | refuseMissingFiles (async) | The server flags the path-like values it could not read (`missingFiles`, names only). Only a file input refuses the whole … | D |
| 239 | function | fillField (async, cx53) | Fill one field by its kind. Returns null when it is filled, else `CODE: message`. `input` is the call's input … | D |
| 320 | function | handleFill (exp, async) | browser_fill: each field by its element kind. Fields are filled in order; one field that fails does not stop the … | D |

## extension/handlers/interaction.js

393 lines · 19 symbols · 3 exported · fan-in 1 · fan-out 7

| line | kind | symbol | purpose | ev |
|---:|---|---|---|---|
| 27 | function | modifiersOf | Modifier bits for a list of names. | D |
| 36 | function | countOf | clickCount: 1 to 3 (double and triple click). | D |
| 43 | function | parseKeyCombo (exp) | "ctrl+a" / "Control+Shift+Tab" -> { key: 'a', mods: ['ctrl'] }; plain keys pass through. | D |
| 62 | function | keyCombosOf | A `key` value as its key presses, in order: one key or combo ("Enter", "Control+a"), or several separated by spaces … | D |
| 75 | function | tabUrl (async) | The tab's URL, or null when the tab is gone. | D |
| 84 | function | settle (async) | What an input did within SETTLE_MS: a top-level navigation, or a JS dialog that was not open before the input. … | D |
| 100 | function | inputResult | The answer of an input: its own lines, then what it navigated or opened, then the notes (a ref re-found … | D |
| 114 | const-function | pointOf | ~ point of | N |
| 116 | const-function | outsideLines | A point target outside the viewport lands nowhere: the answer says so. | D |
| 119 | function | reboundNotes | A located ref that was re-found by its snapshot descriptor: one note line for it (lib/ref-errors.js). | D |
| 125 | function | missedError | CLICK_MISSED: the press at `loc` landed on `hit` (pageRelease), not on `target`; what it then did is named. | D |
| 135 | function | refused (async) | Failed locate: release the input window and return the answer (nothing was sent). | D |
| 145 | function | hoverTo (async) | Mouse move to a target, no press (hover:true). The tab draws frames while the move goes out (a background tab … | D |
| 178 | function | dragBetween (async, cx29) | Press on `from`, move in DRAG_STEPS steps to `to`, release. Both points are measured after the last scroll: revealing one … | D |
| 179 | const-function | pair (async) | ~ pair | N |
| 209 | const-function | dragEvent | ~ drag event | N |
| 257 | function | handleClick (exp, async, cx21) | browser_click: one trusted mouse path. The target is checked first (hidden, disabled or covered: nothing is clicked, the error says … | D |
| 318 | function | handleType (exp, async, cx61) | browser_type: `target` is focused by a trusted click when it is not focused yet; without one, the focused field takes … | D |
| 364 | const-function | shown | ~ shown | N |

## extension/handlers/logs.js

304 lines · 26 symbols · 1 exported · fan-in 1 · fan-out 6

| line | kind | symbol | purpose | ev |
|---:|---|---|---|---|
| 28 | function | checkParams (cx25) | ~ check params | N |
| 51 | function | withDebugger (async) | Run fn(send) on the tab's debugger; an attach failure is DEBUGGER_UNAVAILABLE (errors from fn pass through). | D |
| 62 | function | bodyCaptureActive | Is the tab's body capture still running? Its session detaching (banner closed) ends it. | D |
| 76 | function | startBodyCapture (async) | Network domain on the tab's debugger session, bodies read as responses finish, session pinned so it is not idle-detached. Network.disable … | D |
| 81 | object-function | getBody | ~ reads body | N |
| 98 | function | stopBodyCapture | ~ stops body capture | N |
| 107 | const-function | captureState | ~ capture state | N |
| 111 | const-function | clock | --- console lines ----------------------------------------------------------- | D |
| 114 | function | consoleLines | `error 12:01:02 message (src:line)`, then continuation lines and, for errors, up to STACK_LINES frames. | D |
| 129 | const-function | errorName | --- network lines ---------------------------------------------------------- | D |
| 130 | const-function | typeName | ~ type name | N |
| 131 | const-function | shortUrl | ~ short URL | N |
| 134 | function | sizeOf | Response size from its Content-Length header (decimal kB, as Chrome's network panel shows). | D |
| 143 | function | networkLine | `r17 GET 200 xhr 1.2kB 120ms https://…`: failed requests show their error instead of the status. | D |
| 153 | const-function | isFailed | ~ tests whether failed | N |
| 156 | const-function | startOf | When a request started (its entry is stored when it ends); an entry without a time counts as the newest. | D |
| 163 | function | pageStartOf | Where the current page's requests begin in a tab's buffer: the start of its last document request (type main_frame), or … | D |
| 176 | function | afterRequest | The entries after request `since` (an ID from an earlier list): later in the buffer, which is in the order … | D |
| 184 | const-function | headerLine | --- one request in full ---------------------------------------------------- | D |
| 186 | function | payloadLine | ~ payload line | N |
| 199 | function | bodyLines | ~ body lines | N |
| 211 | function | responseBodyOf | The body of a captured request, or why there is none. | D |
| 218 | function | requestDetail (async) | ~ request detail | N |
| 244 | function | section | One section: `console (N):` with N entries, then its lines, then a note when the limit cut older ones and … | D |
| 251 | function | handleLogs (exp, async, cx23) | ~ handles logs | N |
| 283 | const-function | fits | ~ fits | N |

## extension/handlers/mock.js

203 lines · 17 symbols · 4 exported · fan-in 1 · fan-out 3

| line | kind | symbol | purpose | ev |
|---:|---|---|---|---|
| 16 | const-function | invalid | ~ invalid | N |
| 17 | const-function | countOf | ~ count of | N |
| 19 | function | parseRule (cx27) | ~ parses rule | N |
| 42 | function | parseRules | The rule set a call asks for, validated whole: one bad rule stops the call before anything changes. | D |
| 48 | function | base64Utf8 | `let bin = '';` | B |
| 54 | function | looksLikeJson | `if (!/^\s*[[{]/.test(text)) return false;` | B |
| 65 | function | fulfillParams (exp) | Fetch.fulfillRequest params for an answer {status, body, headers} and the paused request: the answer's headers are the response headers, a … | D |
| 68 | const-function | get | ~ get | N |
| 70 | const-function | has | ~ has | N |
| 97 | function | urlMatches (exp) | URL pattern of a mock rule: with a ` ` it is a glob over the whole URL (` ` … | D |
| 114 | function | mockActive | `return !!mockByTab.get(tabId)?.off && isCdpPinned(tabId, PIN);` | B |
| 119 | function | answer (async) | Answer one paused request: the first matching rule decides; a request nothing matches goes on. | D |
| 137 | function | attachMock (async) | Start Fetch interception on the tab (every request pauses: Chrome cannot filter a CORS preflight by type, and a rule … | D |
| 166 | function | releaseMock (exp) | Stop interception and forget the tab's rules: `rules: []`, the session that set them being released (releaseSession), or the tab … | D |
| 175 | function | summaryOf | `return rules.map(({ match, block, status, hits }) => ({ match, block, status: b...` | B |
| 179 | function | listRules | ~ list rules | N |
| 190 | function | handleMock (exp, async) | ~ handles mock | N |

## extension/handlers/navigation.js

485 lines · 26 symbols · 2 exported · fan-in 1 · fan-out 6

| line | kind | symbol | purpose | ev |
|---:|---|---|---|---|
| 35 | function | getActiveTab (exp, async) | The active tab of the user's last focused window. A session's new tab opens in that window; any other tab … | D |
| 50 | function | settleNewTab (async) | A tab that was just opened starts on about:blank, and that page's own `complete` must not end the wait of … | D |
| 63 | function | openSessionTab (async) | The new tab for a call that names none: a background tab in the user's last focused window, owned by … | D |
| 83 | function | cancellationOf | A promise that rejects when the call is cancelled (client gone, or the timeout forwarded from the bridge), or null … | D |
| 85 | const-function | cancelled | ~ cancelled | N |
| 97 | function | documentState | Runs in the page. The document's identity and readiness: `origin` (performance.timeOrigin) is fixed for one document, so it tells the … | D |
| 109 | function | mutationClock | Runs in the page. The page's side of the quiet-DOM wait: a MutationObserver that only records when the DOM last … | D |
| 132 | function | pageRun (async) | Runs `func` in the tab's page for a load's own probes. Unlike safeExec it never marks the tab wedged and … | D |
| 149 | function | isNewDocument | Is `doc` (a documentState sample) a document other than `old`, the one the load replaces? Without a sample of `old` … | D |
| 160 | function | navigateAndWait (async) | Start a load in the tab (`startLoad`) and wait for the outcome. Resolves when the NEW document is interactive or … | D |
| 163 | const-function | endWait | ~ end wait | N |
| 176 | const-function | finish | ~ finish | N |
| 188 | const-function | probeReady (async) | DOM-ready: Chrome's tabs.onUpdated reports only 'loading' and 'complete', never // 'interactive', so the new document's readyState is polled in the … | D |
| 195 | const-function | listener | `if (tId !== tab.id) return;` | B |
| 227 | function | settleDom (async) | The quiet-DOM wait that follows every load: done once the DOM has not changed for QUIET_MS, or at QUIET_CAP_MS on … | D |
| 247 | function | loadingFrames | Runs in the page. How many same-origin frames (iframes and frameset frames, at any depth) are still loading: a document … | D |
| 249 | const-function | visit | ~ visit | N |
| 269 | function | settleFrames (async) | The top document is ready before its frames are: a frameset page (/nested_frames) shows only the frames that happened to … | D |
| 284 | function | stepHistory (async) | One step back or forward in the tab's own history, through the page's history.go(). chrome.tabs.goBack skips entries the user did … | D |
| 299 | const-function | done | ~ done | N |
| 305 | const-function | listener | `if (id !== tab.id) return;` | B |
| 331 | function | navigationLines | The lines the agent reads about one navigation. | D |
| 343 | function | replacedClause | The clause that names a frozen tab's replacement in an error text (a success text says the same as `note:`). | D |
| 352 | function | replacementFailure | A failure after a frozen tab was replaced. A `CODE: message` keeps its code; any other error becomes NAVIGATION_FAILED. The … | D |
| 368 | function | handleNavigate (exp, async) | browser_navigate. `URL` is an address (the scheme is optional), or "back", "forward" or "reload". Without tabId the call opens a … | D |
| 379 | function | navigateTab (async, cx49) | ~ navigate tab | N |

## extension/handlers/screenshot.js

407 lines · 25 symbols · 4 exported · fan-in 1 · fan-out 7

| line | kind | symbol | purpose | ev |
|---:|---|---|---|---|
| 39 | function | withTimeout | ~ wrapper that supplies timeout | N |
| 47 | function | coded | `const err = new Error(`${code}: ${message}`, cause ? { cause } : undefined);` | B |
| 59 | function | shieldStep | One shield step (a page script). A page that does not answer it within the page-call budget is marked wedged … | D |
| 67 | function | imageSize (exp) | Pixel size of a base64 PNG/JPEG (null if it can't be read). | D |
| 70 | const-function | at | ~ at | N |
| 94 | function | planScale (exp) | The image scale for a capture of cssW × cssH CSS px at device ratio dpr, cut down when the … | D |
| 105 | function | fitToBudget (exp, async) | Bring an encoded JPEG under the frame budget: each try lowers the quality and shrinks the scale by the size … | D |
| 119 | const-function | errText | ~ err text | N |
| 121 | function | b64ToBlob | ~ b64 to blob | N |
| 128 | function | blobToB64 (async) | ~ blob to b64 | N |
| 136 | function | pageDpr (async) | Device pixels per CSS pixel: window.devicePixelRatio, else the layout-metrics ratio. | D |
| 149 | function | cropOf | The part of a w × h viewport (CSS px) a crop covers: the crop cut to the viewport. `clipped` … | D |
| 165 | function | frameOf | The pixel → viewport mapping of a picture: viewportX = origin[0] + imageX / scale. | D |
| 174 | function | viewportOf (async) | CSS size of the page's viewport (innerWidth × innerHeight), or null when the page does not answer. | D |
| 187 | function | cdpCapture (async) | CDP capture (Page.captureScreenshot, debugger attached) of the viewport, or of `crop` inside it. A background tab is captured this way, … | D |
| 201 | const-function | once (async) | ~ once | N |
| 230 | function | visibleScreenshot (async) | The active tab, from captureVisibleTab: the viewport as it is on screen, cropped and downscaled here, so the picture is … | D |
| 251 | const-function | encode (async) | ~ encode | N |
| 279 | function | debuggerShot (async) | A CDP capture that failed is DEBUGGER_UNAVAILABLE: the caller learns the picture is not there. | D |
| 292 | function | takeShot (async) | One picture, by where the tab is. The active tab comes from captureVisibleTab; if that fails, CDP is tried. A … | D |
| 304 | function | pageBoxOf | Page side (self-contained, serialized): the top-level viewport box of the element a target resolves to. | D |
| 321 | function | elementBox (async) | The box of `target` in viewport CSS px. The locator (lib/trusted-input.js) resolves it and scrolls it into view, with the … | D |
| 343 | function | checkRequest | Validates the call; returns the parsed target (null without one). format, quality and maxWidth (removed in 3.0) are ignored: the … | D |
| 360 | function | handleScreenshot (exp, async) | ~ handles screenshot | N |
| 371 | function | captureScreenshot (async) | ~ capture screenshot | N |

## extension/handlers/tabs.js

113 lines · 9 symbols · 1 exported · fan-in 1 · fan-out 5

| line | kind | symbol | purpose | ev |
|---:|---|---|---|---|
| 16 | function | refuseLocked | A locked tab belongs to its owner session: closing or focusing it from another session (or an anonymous caller) would … | D |
| 22 | const-function | clip | Clip to `max` characters; the last one becomes an ellipsis. | D |
| 25 | function | addressOf | host + path of a web address, 80 characters at most. Other addresses are shown as they are. | D |
| 34 | const-function | titleOf | The title on one line, 60 characters at most, in quotes. | D |
| 43 | function | listTabs (async) | browser_tabs list. The session's own tabs first, then the user's focused tab. Tabs another session owns or is driving are … | D |
| 63 | const-function | line | ~ line | N |
| 70 | const-function | roleOf | ~ role of | N |
| 80 | function | requireTabId | close and focus name the tab they act on. | D |
| 87 | function | handleTabs (exp, async) | ~ handles tabs | N |

## extension/lib/browser-log.js

113 lines · 9 symbols · 1 exported · fan-in 1 · fan-out 0

| line | kind | symbol | purpose | ev |
|---:|---|---|---|---|
| 25 | function | argText | RemoteObject → text, without asking the page. | D |
| 33 | const-function | wantsJson | Plain objects and arrays read best as JSON; errors, nodes, maps… by their description. | D |
| 35 | function | consoleText (async) | ~ console text | N |
| 54 | function | exceptionText | The message of an uncaught exception. Where it happened is `source`, kept apart so a line shows it once. | D |
| 60 | const-function | capText | ~ cap text | N |
| 64 | const-function | frameText | ~ frame text | N |
| 65 | const-function | framesOf | ~ frames of | N |
| 66 | function | sourceOf | `const top = frames.find((f) => f.url);` | B |
| 76 | function | collectPageConsole (exp, async, cx20) | Enable Runtime, gather the replayed console calls and uncaught exceptions of the current document, switch it off again. `levels` (a … | D |

## extension/lib/cdp-evaluate.js

228 lines · 17 symbols · 2 exported · fan-in 1 · fan-out 2

| line | kind | symbol | purpose | ev |
|---:|---|---|---|---|
| 19 | function | serializeThis (cx26) | Page-side serializer, run with `this` = the evaluated value. | D |
| 20 | const-function | describe | ~ describe | N |
| 49 | function | capped | ~ capped | N |
| 62 | function | racer | Every CDP call that can wait on the page is raced against the budget, the abort and, when a tab … | D |
| 73 | const-function | off | ~ off | N |
| 81 | object-function | guarded | ~ guarded | N |
| 82 | object-function | stop | ~ stop | N |
| 90 | const-function | pausedReply | The script opened a JavaScript dialog: its Runtime.evaluate waits for the dialog, so the call answers now as a success … | D |
| 99 | function | resultOf (async) | The remote value of an evaluate reply as a result object (both entry points). | D |
| 120 | function | messageOf | A thrown value's message: the first line of its description (no stack), or the thrown primitive. | D |
| 129 | function | cdpFailure (exp) | A CDP call that failed (the debugger detached, the target went away): DEBUGGER_UNAVAILABLE with the protocol's message, never the raw … | D |
| 145 | function | parse | Does `expression` parse? Runtime.evaluate of a function expression builds the function, and a SyntaxError comes back as exceptionDetails. throwOnSideEffect makes … | D |
| 150 | const-function | refusedBy | V8 refused a parse check: the source would have run code outside its function (see parse). | D |
| 153 | const-function | refusedReply | A parse check refused a break-out: nothing ran, the call fails with a coded message. | D |
| 159 | const-function | cancelledReply | The caller (the bridge) gave up on the call: nothing more runs, the failure says so. | D |
| 162 | function | dialogRefusal | DIALOG_OPEN for a call on a tab whose JavaScript dialog is open (nothing is sent), else null. | D |
| 174 | function | cdpEvaluateSource (exp, async) | browser_evaluate (contract 3.0): `source` is one expression, or statements that `return` a value. It is compiled first (nothing runs when … | D |

## extension/lib/cdp-session.js

338 lines · 25 symbols · 21 exported · fan-in 14 · fan-out 0

| line | kind | symbol | purpose | ev |
|---:|---|---|---|---|
| 23 | function | bounded | ~ bounded | N |
| 39 | function | settleWithin (exp) | Resolve with `promise`'s outcome, or with TIMED_OUT after `ms`. A CDP or chrome.scripting call into a frozen page never answers, … | D |
| 56 | function | armIdle | ~ arm idle | N |
| 72 | function | pinCdp (exp) | Keep the tab's live session attached for `reason` until unpinned. The pin lives on the session, so it is gone … | D |
| 80 | function | unpinCdp (exp) | `const s = sessions.get(tabId);` | B |
| 87 | function | isCdpPinned (exp) | Pinned for `reason`, or for anything when no reason is given. | D |
| 96 | function | isCdpInUse (exp) | Whether something other than the idle timer needs the tab's session now: a CDP call in flight, a capture or … | D |
| 103 | function | getCdpEmulation (exp) | Overrides browser_emulate set on the tab's live session ({} when none or detached). | D |
| 108 | function | setCdpEmulation (exp) | Record the active overrides; while any are set the session is not idle-detached. | D |
| 116 | function | getLostEmulation (exp) | Overrides Chrome removed when the tab's debugger session ended and nobody has been told yet. | D |
| 122 | function | clearLostEmulation (exp) | The lost overrides were reported to the agent (or deliberately reset). | D |
| 127 | function | clearCdpEmulation (exp) | browser_emulate reset: forget the overrides without reporting them as lost. | D |
| 134 | function | getOpenDialog (exp) | The JavaScript dialog Chrome reported open on the tab ({type, message, defaultPrompt, URL}), or null. | D |
| 143 | function | dialogLabel (exp) | `confirm "Delete this item?"`: a dialog as a result line names it. The page wrote the message, so it is … | D |
| 150 | function | dialogOpenError (exp) | The DIALOG_OPEN error a call gets while a JavaScript dialog blocks its tab (the wording of trusted-input's assertInputReady). | D |
| 157 | function | clearOpenDialog (exp) | Forget the recorded dialog: it was answered, or Chrome says none is showing. | D |
| 162 | function | attach (async) | ~ attach | N |
| 189 | function | ensureViewport (exp, async) | A tab opened in the background and never shown has a 0x0 viewport: nothing is laid out, so every element … | D |
| 206 | function | ensureCdp (exp, async) | Attach (or reuse) the tab's session and return a `send(method, params)` helper. | D |
| 237 | function | sendAttached (exp) | Send on the tab's existing debugger attachment, without attaching one. Rejects ("Debugger is not attached") when there is none, so … | D |
| 242 | function | withCdp (exp, async) | Run fn(send) with the tab's session; no idle detach while fn runs. | D |
| 258 | function | endSession | Drop a tab's session. Overrides still set are kept as lost, so the next browser_emulate call reports them. | D |
| 268 | function | detachCdp (exp, async) | ~ detach CDP | N |
| 275 | function | hasCdp (exp) | `return sessions.has(tabId);` | B |
| 286 | function | subscribeCdpEvents (exp) | Receive the tab's CDP events (method, params) until the returned function is called. A subscriber that answers a Fetch.requestPaused returns … | D |

## extension/lib/connection.js

598 lines · 33 symbols · 19 exported · fan-in 4 · fan-out 6

| line | kind | symbol | purpose | ev |
|---:|---|---|---|---|
| 54 | object-function | getSocket | ~ reads socket | N |
| 54 | object-function | isConnected | ~ tests whether connected | N |
| 65 | function | setMessageHandler (exp) | `messageHandler = fn;` | B |
| 69 | function | isWsConnected (exp) | `return connected;` | B |
| 73 | function | setCurrentActivity (exp) | `currentActivity = name;` | B |
| 78 | function | sendJson (exp) | Send a JSON frame to the daemon if (and only if) the socket is open. | D |
| 84 | function | sendVaultProtectionTabRemoved (exp) | `vaultChannel.sendProtectionTabRemoved(removal);` | B |
| 88 | function | sendVaultUiClosed (exp) | `vaultChannel.sendUiClosed();` | B |
| 92 | function | requestVaultUi (exp) | `return vaultChannel.requestUi(payload);` | B |
| 103 | function | autoPairToken (async) | Auto-pair: fetch the daemon's auth token over localhost. The background service worker can fetch() (it has host_permissions for 127.0.0.1:7225), and … | D |
| 129 | function | notePairing | Tell the popup's activity log how pairing went (each distinct note once). | D |
| 136 | function | nativePairingHint | Actionable text for chrome.runtime.sendNativeMessage failures. | D |
| 150 | function | nativePair (async) | Ask the native pairing host for the enrollment secret. Returns true when it changed something (secret or port), i.e. when … | D |
| 183 | function | ensurePairing (exp, async) | Get a token. When the daemon refuses the enrollment secret (403: none stored yet, or rotated), fetch it from the … | D |
| 195 | function | defaultBrowserLabel | ~ default browser label | N |
| 202 | function | initConnection (exp, async) | ~ init connection | N |
| 250 | function | adoptDaemonInstance (exp) | Locks, control entries and shields belong to the daemon instance that granted them. A hello from a DIFFERENT instance means … | D |
| 264 | function | wsUrl | ~ WebSocket URL | N |
| 281 | function | wsSubprotocols | Subprotocols to offer on the WS handshake. The daemon extracts the auth token from the `bc-auth.<token>` offer (kept out of … | D |
| 298 | function | daemonListening (async) | Is the daemon listening on its port? A WebSocket to a closed port makes Chrome log "WebSocket connection … failed" … | D |
| 314 | function | connect (exp, async, cx31) | ~ connect | N |
| 443 | function | refuseDaemon | Refuse the daemon on this socket: its reason becomes the status, and the socket closes. The reconnect loop retries later, … | D |
| 453 | function | scheduleReconnect | ~ schedule reconnect | N |
| 475 | function | updateBadge (exp) | --- Badge & status --------------------------------------------------------- | D |
| 487 | function | getConnectionState (exp) | `if (connected) return 'connected';` | B |
| 493 | function | buildStatusPayload (exp) | ~ builds status payload | N |
| 522 | function | getOpenTabs (exp, async) | Tabs for the popup's Open Tabs panel: every tab of the current window, then any tab in ANOTHER window that … | D |
| 529 | const-function | row | ~ row | N |
| 548 | function | broadcastStatus (exp, async) | ~ broadcast status | N |
| 558 | function | resetAndReconnect | Tear down the current WS and reconnect (shared by all three setters). | D |
| 566 | function | applyPort (exp) | ~ applies port | N |
| 578 | function | applyToken (exp) | ~ applies token | N |
| 592 | function | applyEnrollment (exp, async) | The popup owns the user-facing entry of the enrollment secret. Persist it, re-pair (so /pair runs under the new secret … | D |

## extension/lib/drag-input.js

86 lines · 9 symbols · 3 exported · fan-in 2 · fan-out 3

| line | kind | symbol | purpose | ev |
|---:|---|---|---|---|
| 16 | function | clearSelection (exp, async) | Before a drag: no text selected. A press on selected text starts Chrome's own text drag, and the page then … | D |
| 21 | function | pageDragStart | Page-side: 'arm' watches for the page's own dragstart; 'check' says whether one ran and the page let it go on … | D |
| 40 | function | interceptDrags (exp, async) | HTML5 drag and drop (draggable=true, links, images). Left alone, Chrome hands such a drag to the operating system's drag loop, … | D |
| 42 | const-function | wake | ~ wake | N |
| 47 | const-function | watch | ~ watch | N |
| 51 | getter | data | ~ exposes data of  | N |
| 53 | object-function | started (async) | The drag's data when the page started one; waits up to `ms` for Chrome to hand it over. | D |
| 60 | object-function | stop (async) | `off();` | B |
| 74 | function | withFrames (exp, async) | A background tab draws no frames, and Chrome holds each mouse move for the next frame: about 1 s per … | D |

## extension/lib/emulation.js

114 lines · 4 symbols · 2 exported · fan-in 1 · fan-out 0

| line | kind | symbol | purpose | ev |
|---:|---|---|---|---|
| 17 | const-function | isViewportSize | ~ tests whether viewport size | N |
| 24 | function | userAgentMetadataFrom (exp) | The Emulation.UserAgentMetadata that matches a real browser's client hints. A bare userAgent override makes Chrome empty navigator.userAgentData (brands and platform … | D |
| 25 | const-function | pairs | ~ pairs | N |
| 46 | function | emulationPlan (exp, cx25) | Commands for the requested settings and the resulting active state. Settings merge with `active`; "none", rate 1, null and "" … | D |

## extension/lib/input-outcome.js

116 lines · 6 symbols · 2 exported · fan-in 1 · fan-out 1

| line | kind | symbol | purpose | ev |
|---:|---|---|---|---|
| 12 | function | releaseShield (exp, async) | Close the tab's input window and read back what the input did (pageRelease). `typed` is the text just inserted, when … | D |
| 20 | function | inputBlockedError (exp) | INPUT_BLOCKED: the page got none of `what` (a click at…, the keys…). Chrome's own dialogs over a tab take its … | D |
| 30 | function | pageRelease (cx60) | Close the agent's input window; report ordinary field values and only booleans for sensitive fields, (`missed`) a press that landed … | D |
| 90 | function | watchOutcome | What the watched input did (pageLocate watchInput): a missed press, and which kinds of it arrived. | D |
| 98 | const-function | hovered | A pointer that does not move gets no move event: one already over the target has hovered it. | D |
| 106 | function | pressMissed | The element a watched press landed on instead of its target, or null. | D |

## extension/lib/inspect-element.js

343 lines · 23 symbols · 9 exported · fan-in 1 · fan-out 0

| line | kind | symbol | purpose | ev |
|---:|---|---|---|---|
| 50 | function | pageInspect (exp, cx39) | Page side (isolated world, via execDom; self-contained — it is serialized). The element `t` (a parseTarget object) resolves to (lib/page-DOM.js … | D |
| 121 | function | describeNode (exp) | "button#go.btn.primary" from a CDP DOM.Node. | D |
| 123 | const-function | get | ~ get | N |
| 129 | const-function | hasAuthorShadow | ~ tests whether there is author shadow | N |
| 138 | function | nodesAtPath (exp) | Follow a structural path (pageInspect's `path`) in a DOM.getDocument pierce dump: the target node and its ancestor elements within its … | D |
| 162 | function | cap | `return text.length > max ? `${text.slice(0, max)}…` : text;` | B |
| 166 | function | sourceOf | ~ source of | N |
| 174 | const-function | declared | Declarations written in the source (implicit longhand expansions have no range). | D |
| 176 | const-function | longhands | Longhands the entry sets, declared or expanded from a shorthand. | D |
| 177 | const-function | longhandsOf | ~ longhands of | N |
| 180 | function | entriesOf | Ascending-priority entries of one element: matched rules, then its inline style. | D |
| 187 | function | cascadeWinners | Longhand name -> index of the entry that wins it. | D |
| 199 | function | view | One entry in the agent's view; `keep` filters its declarations, `lost` marks overridden ones. | D |
| 218 | const-function | isAuthor | ~ tests whether author | N |
| 226 | function | shapeMatchedStyles (exp) | `matched` is a CSS.getMatchedStylesForNode result; `sheets` maps styleSheetId to { URL, startLine }; `ancestors[k]` labels matched.inherited[k] (null: unknown). Returns { … | D |
| 273 | function | shapeListeners (exp) | The element's own listeners and those on its ancestors (`on` names the ancestor), with the script URL and line each … | D |
| 285 | function | declLines | Text: one line per declaration, with what overrode it or made it invalid. | D |
| 302 | const-function | ruleHead | Head line of a rule: `selector file:line @media …`. | D |
| 305 | function | formatRules (exp) | The shaped rules as lines: { rules, inherited, pseudo } (each an array of lines). | D |
| 306 | const-function | block | ~ block | N |
| 315 | function | formatListeners (exp) | Own listeners first, then the ancestors' (the event bubbles up to them). | D |
| 324 | function | formatStyles (exp) | Computed styles as `prop: value` lines. `all` ([" "]) is capped and says so. | D |
| 337 | function | renderInspect (exp) | The whole answer: the element's header line, then the sections. A lone styles section is printed bare; with more, each … | D |

## extension/lib/keys.js

119 lines · 4 symbols · 3 exported · fan-in 1 · fan-out 0

| line | kind | symbol | purpose | ev |
|---:|---|---|---|---|
| 9 | function | modifierBits (exp) | `return mods.reduce((bits, m) => bits \| (MOD_BITS[m] \|\| 0), 0);` | B |
| 56 | function | keyDefinition (exp) | CDP key definition for a key name ("Enter", "a", "7", "ب"). | D |
| 77 | function | selectAllCombo | Control+a / Meta+a (no alt, no shift): select all in the focused field. macOS Chrome binds Control+a to "line start" … | D |
| 90 | function | cdpKeyPress (exp, async) | One full key press (keyDown[+char] / keyUp). The modifiers are held as a person holds them: each one's own keydown … | D |

## extension/lib/lock-ops.js

41 lines · 2 symbols · 2 exported · fan-in 3 · fan-out 3

| line | kind | symbol | purpose | ev |
|---:|---|---|---|---|
| 21 | function | lockTabUi (exp) | Lock a tab for `owner`, persist the lock, broadcast. Throws when another session already owns the tab (TabLockMap.lock refuses to … | D |
| 32 | function | releaseTabUi (exp) | Release a tab's lock unconditionally, persist, drop any shield still on the tab, broadcast. The tab is handed back, so … | D |

## extension/lib/main-frame.js

68 lines · 8 symbols · 3 exported · fan-in 2 · fan-out 1

| line | kind | symbol | purpose | ev |
|---:|---|---|---|---|
| 15 | function | watchMainFrame (exp) | Main-frame network facts for one tab while a navigation runs. webRequest is the only source of the HTTP status (webNavigation … | D |
| 19 | object-function | stop | ~ stop | N |
| 22 | const-function | onStart | `if (d.tabId === tabId) facts.started = true;` | B |
| 26 | const-function | onHeaders | Every redirect hop is a main-frame response: the last one seen is the final one. | D |
| 34 | const-function | onError | ~ callback for error | N |
| 45 | object-function | stop | `wr.onBeforeRequest?.removeListener?.(onStart);` | B |
| 57 | function | untilResponse (exp, async) | Resolve once the watched request has a response or an error, or after `ms`. | D |
| 65 | function | downloadLine (exp) | The result line of a download a click started (browser_navigate words its own the same way). | D |

## extension/lib/network-capture.js

216 lines · 17 symbols · 7 exported · fan-in 3 · fan-out 1

| line | kind | symbol | purpose | ev |
|---:|---|---|---|---|
| 39 | function | redactHeaders (exp) | [{name, value}] with credential-bearing values replaced; undefined when absent. | D |
| 44 | const-function | clip | ~ clip | N |
| 47 | function | redactDeep | Secret-looking values replaced anywhere inside a parsed JSON value. | D |
| 59 | function | redactTextKeys (exp) | Text-level pass for bodies that cannot be parsed whole: secret-looking key/value pairs only. Returns the text and the names of … | D |
| 69 | function | redactText | `return redactTextKeys(text).text;` | B |
| 77 | function | redactUrl (exp) | The URL with the values of secret-looking query keys replaced by ` ` (the keys stay, so the request is … | D |
| 93 | function | looksBinary | Control characters (other than tab, newline, carriage return) or several replacement characters mean binary data; one replacement is a multi-byte … | D |
| 104 | function | headBytes | Concatenate the first `max` bytes of the raw body parts (each part has a bytes ArrayBuffer, or a file path). | D |
| 126 | function | summarizeRequestBody (exp, cx22) | What browser_logs shows for a request body (webRequest requestBody), or undefined when there is none: { kind: 'form', fields } … | D |
| 162 | function | createNetworkCapture (exp) | Listener bodies for chrome.webRequest. `store(tabId, entry)` receives each finished request (completed or failed) of a real tab. | D |
| 165 | function | finish | ~ finish | N |
| 177 | object-function | onBeforeRequest | ~ callback for before request | N |
| 183 | object-function | onSendHeaders | `const started = pending.get(d.requestId);` | B |
| 187 | object-function | onCompleted | `const responseHeaders = redactHeaders(d.responseHeaders);` | B |
| 191 | object-function | onErrorOccurred | `finish(d, { error: d.error });` | B |
| 198 | function | pushNetworkEntry (exp) | Append one entry to a tab's network buffer; when full, static assets go first, then the oldest entry. | D |
| 207 | function | listView (exp) | One entry as a list row carries it: network fields only, long URLs cut unless fullUrls. | D |

## extension/lib/overlay.js

177 lines · 8 symbols · 4 exported · fan-in 6 · fan-out 0

| line | kind | symbol | purpose | ev |
|---:|---|---|---|---|
| 20 | function | agentCursorEnabled (exp, async) | The agent cursor is opt-in (popup → Settings): its glide holds every mouse action ~200–350 ms on a visible tab. … | D |
| 43 | function | showLockShield (exp, async) | Lock-shield: a full-viewport translucent frame with a blue inner glow, shown // only while an agent tool call runs on … | D |
| 47 | object-function | func | ~ func | N |
| 63 | const-function | block | ~ block | N |
| 128 | function | hideLockShield (exp, async) | ~ hide lock shield | N |
| 132 | object-function | func | ~ func | N |
| 159 | function | setAgentCursorHidden (exp, async) | Hide or restore the agent cursor (lib/page-DOM.js) around a screenshot, so it never covers what the agent is looking at. … | D |
| 165 | object-function | func | `const el = document.getElementById('__bc-agent-cursor');` | B |

## extension/lib/page-dom.js

929 lines · 64 symbols · 1 exported · fan-in 1 · fan-out 0

| line | kind | symbol | purpose | ev |
|---:|---|---|---|---|
| 25 | function | PAGE_DOM_INSTALL (exp, cx484) | `refBase`: the highest ref number the tab's earlier documents showed (lib/state.js refHighWaterByTab). This document's counter starts there, so its refs … | D |
| 44 | function | styleOf | Computed style from the element's own window (frames have their own). | D |
| 47 | const-function | connected | ~ connected | N |
| 49 | const-function | clean | ~ clean | N |
| 50 | const-function | attr | ~ attr | N |
| 57 | function | isExtensionNode | ~ tests whether extension node | N |
| 77 | function | peekRef | The ref an element has, or the one it will get: nothing is issued or registered. | D |
| 81 | function | refFor | The element's stable ref, registered in the page registry (the first sight issues it). | D |
| 92 | function | refIssued | Was this ref issued in this tab (this document or an earlier one)? `e<n>` with n at most the counter. | D |
| 97 | function | refIsEarlier | Was this ref issued by an earlier document of the tab (its number is at or below this document's start)? | D |
| 102 | function | pruneRegistry | Drop the registry entries whose element has left the document (each snapshot runs this). | D |
| 107 | function | shadowOf | Open or closed shadow root (closed ones via chrome.DOM in the isolated world). | D |
| 116 | function | frameDoc | `if (!el \|\| el.tagName !== 'IFRAME' && el.tagName !== 'FRAME') return null;` | B |
| 122 | function | allRoots | Every search root: documents (top + same-origin frames) and shadow roots. | D |
| 125 | const-function | visit | ~ visit | N |
| 141 | function | queryAll | ~ query all | N |
| 153 | function | isVisible (cx24) | Composed-ancestor aware: display/visibility/opacity/content-visibility + a real box. `ignoreOpacity`: opacity:0 still counts as rendered (a real click reaches it). | D |
| 183 | function | textHasBox | Does a text node lay out a box of its own (it shows even when its element has none)? | D |
| 194 | function | flatChildren | Flat-tree children: shadow content replaces light children, slots show what is assigned. | D |
| 211 | function | roleOf (cx24) | ~ role of | N |
| 247 | function | composedText (cx24) | Composed text (includes shadow content) — innerText misses shadow roots. `shownOnly` leaves out what does not show: a display:none subtree, … | D |
| 250 | const-function | walk (cx24) | ~ walk | N |
| 274 | function | nameOf (cx22) | `shownOnly`: a name from the element's own text counts only the text that shows (composedText). | D |
| 303 | function | ownText | Text the element holds itself: its direct text nodes, cleaned (descendants excluded). | D |
| 310 | function | isInteractive | ~ tests whether interactive | N |
| 321 | function | preciseMatch | Exact, or wanted + non-letter suffix ("Login »"). | D |
| 329 | function | firstVisible | `if (!list \|\| !list.length) return null;` | B |
| 337 | function | byFallback (cx31) | Fallback descriptor → element, only when the match is unambiguous. | D |
| 342 | const-function | effRole | ~ eff role | N |
| 343 | const-function | textOk | `\|\| preciseMatch(clean(el.textContent).split('\n')[0], fb.text)` | B |
| 347 | const-function | same | A descriptor names its role the generator's way (role attribute or tag name) or the snapshot's (roleOf: link, textbox…). | D |
| 370 | function | composedParent | The node above `n` in the composed tree: parent, shadow host or frame element. | D |
| 378 | function | isAccessibilityHidden | ~ tests whether accessibility hidden | N |
| 393 | function | byText | `text=<words>` (lib/target.js): the visible elements whose accessible name or text equals the words (case-insensitive, whitespace collapsed); when none equals, the … | D |
| 403 | const-function | holds | ~ holds | N |
| 426 | function | byRole | Exact accessible role and name match, optionally selecting a zero-based occurrence. | D |
| 453 | function | resolveTarget (cx26) | The one target resolver. `t` is the object lib/target.js parseTarget returns; `fb` is the snapshot's fallback descriptor for a ref … | D |
| 505 | function | centerOf | Top-level viewport centre of an element (adds same-origin iframe offsets). | D |
| 524 | function | isOwnOverlay | The extension's own overlays (lock shield, agent cursor: IDs __bc- ) are transparent to hit-testing: a click is judged against … | D |
| 528 | function | topAt | Topmost page element at a point in one document or shadow root. | D |
| 537 | function | elementAt | Composed hit-test: the deepest element at a top-level point (pierces shadow roots and same-origin frames). | D |
| 562 | function | isDisabled | Disabled natively (incl. inside a disabled fieldset) or aria-disabled="true" on it or an ancestor. | D |
| 577 | function | labelsOf | The <label>s that name a form control (el.labels, which already includes an enclosing <label> that names it). Not any enclosing … | D |
| 581 | const-function | isCheckable | ~ tests whether checkable | N |
| 583 | function | rendered | Displayed (display, visibility, ancestors), opacity ignored; the box itself may be empty. | D |
| 591 | function | hitAt | Topmost element at a top-level point, or null (detached mid-measure). | D |
| 599 | function | reachesControl | Does a click that lands on `hit` reach `el`? Yes for `el` itself, anything inside it, and anything inside one … | D |
| 603 | function | coveredBy | `return { message: `ELEMENT_COVERED: the click point of ${describe(el)} is cover...` | B |
| 612 | function | clickBlocker | Why a real click on `el` would not reach it, or null when it would. Checked before any click (CDP … | D |
| 632 | function | clickTarget | Where a click on `el` goes: { node, x, y, via? } for a click that can reach it, or … | D |
| 650 | function | composedContains | ~ composed contains | N |
| 671 | function | rowContextOf | Text of the table/grid row holding `el` (a TR or role="row" ancestor, across shadow roots), minus the cell(s) that contain … | D |
| 672 | const-function | up | ~ up | N |
| 695 | function | describe | `if (!el) return null;` | B |
| 711 | function | flatText (cx42) | Visible text of the flat tree (shadow roots, slots, same-origin frames), block elements on their own lines. `article` skips navigation, … | D |
| 714 | const-function | push | ~ push | N |
| 716 | const-function | walk (cx42) | pre: inside white-space:pre the text keeps its own line breaks. | D |
| 772 | function | makeCursor | ~ makes cursor | N |
| 798 | function | cursorEffect | ~ cursor effect | N |
| 821 | function | cursor (cx24) | ~ cursor | N |
| 866 | const-function | sensitiveFieldValue | `if (typeof el?.value === 'string') return el.value;` | B |
| 870 | function | looksLikeCardNumber | ~ looks like card number | N |
| 883 | function | isSensitiveField | ~ tests whether sensitive field | N |
| 895 | function | redactSensitiveText | ~ redact sensitive text | N |

## extension/lib/page-exec.js

209 lines · 14 symbols · 9 exported · fan-in 16 · fan-out 5

| line | kind | symbol | purpose | ev |
|---:|---|---|---|---|
| 16 | function | resolveTab (exp, async) | Resolve a tab by ID, throwing a clear, actionable error if it's gone. Replaces the old getActiveTab()-style silent fallback — … | D |
| 26 | function | tabGoneError | A tab ID that no longer names a tab: TAB_REPLACED with the tab that took its place, else TAB_NOT_FOUND. | D |
| 39 | function | getFallback (exp) | Get the stored smart-selector fallback for a (tabId, ref). Returns null if the ref was never snapshotted or the snapshot … | D |
| 52 | function | withTimeout (exp) | Race a promise against a timer; the timer's error comes from makeError(). | D |
| 58 | function | wedgedError (exp) | ~ wedged error | N |
| 67 | function | probeResponsive (exp, async) | Is a previously wedged tab answering again? Clears the mark when it is. | D |
| 69 | object-function | func | ~ func | N |
| 87 | function | replaceFrozenTab (exp, async) | A frozen page holds every navigation/reload of its tab hostage until its main thread frees up (57 s measured on … | D |
| 100 | function | assertResponsive (exp, async) | Fail fast when the tab is known to be frozen (one short probe, no queueing). | D |
| 114 | function | safeExec (exp, async) | safeExec (task 2.5): run chrome.scripting.executeScript against a tab, turning "can't access chrome:// / webstore / devtools pages" into a clear … | D |
| 162 | function | scriptError | `const err = new Error(`SCRIPT_ERROR: ${message}`);` | B |
| 172 | function | takePageError (async) | Reads and clears the last uncaught error recorded in the page's isolated world since `since` (null when none). Older errors … | D |
| 177 | object-function | func | `const recorded = globalThis.__bcPageError ?? null;` | B |
| 197 | function | execDom (exp, async) | Run a page function that uses the shared DOM runtime (globalThis.__bcDom, lib/page-DOM.js). Page functions start with `if (!globalThis.__bcDom) return { … | D |

## extension/lib/protocol.js

68 lines · 2 symbols · 2 exported · fan-in 3 · fan-out 0

| line | kind | symbol | purpose | ev |
|---:|---|---|---|---|
| 25 | function | validateDaemonHello (exp) | The daemon's hello must carry an explicit protocol version and the 3.0 tool contract. A hello without them comes from … | D |
| 56 | function | buildExtensionHelloAck (exp) | ~ builds extension hello ack | N |

## extension/lib/ref-errors.js

46 lines · 3 symbols · 3 exported · fan-in 7 · fan-out 0

| line | kind | symbol | purpose | ev |
|---:|---|---|---|---|
| 11 | function | refErrorMessage (exp) | The one wording of a stale or unknown ref, shared by every ref tool. Handlers return the bare code (REF_GONE) … | D |
| 23 | function | reboundNote (exp) | The note a reply carries when a stale ref was re-found by its snapshot descriptor (the page changed under it, … | D |
| 33 | function | highestRefIn (exp) | The highest ref number a page result shows the agent: the refs of a snapshot and the candidates of an … | D |

## extension/lib/response-bodies.js

147 lines · 11 symbols · 3 exported · fan-in 1 · fan-out 1

| line | kind | symbol | purpose | ev |
|---:|---|---|---|---|
| 29 | function | parsesAsJson | Does `text` parse as JSON? | D |
| 38 | function | redactBody (exp) | Redact a body for browser_logs. JSON is redacted by key at any depth (redactJsonBody). Any other text, and JSON cut … | D |
| 48 | function | redactJsonBody (exp) | Replace the string values under credential keys (access_token, password, apiKey…) in a JSON body, at any depth below the key … | D |
| 52 | const-function | walk | ~ walk | N |
| 71 | function | bodyView | ~ body view | N |
| 92 | function | createBodyCapture (exp, cx24) | `onEvent(method, params)` takes the tab's CDP events (it returns the body read's promise for loadingFinished, so tests can await it); … | D |
| 96 | const-function | keep | `bodies.push(record);` | B |
| 102 | object-function | onEvent | ~ callback for event | N |
| 130 | object-function | find | The body of a webRequest entry ({method, URL, timestamp, durationMs}): same method and URL, closest start. | D |
| 143 | getter | size | ~ exposes size of  | N |
| 144 | object-function | clear | ~ clear | N |

## extension/lib/router.js

420 lines · 17 symbols · 2 exported · fan-in 1 · fan-out 18

| line | kind | symbol | purpose | ev |
|---:|---|---|---|---|
| 73 | function | dispatch (exp, async) | `const handler = HANDLERS[tool];` | B |
| 83 | function | withDialogLine | A success on a tab whose JavaScript dialog is open gets the `dialog:` line the input tools give (a navigate … | D |
| 92 | function | overlayStep | ~ overlay step | N |
| 99 | function | sendResponse | `sendJson({ id, ...response });` | B |
| 110 | function | sendToolResponse | Unified error channel (architecture): handlers signal failure EITHER by throwing OR by returning {success:false,...}. Both must reach the daemon as … | D |
| 123 | function | cancelledError | The error a call answers with when its caller cancelled it before it ran (X1). | D |
| 131 | function | clearTabSetting | Clear one tab setting whose owner session was released (state.js claimTabSetting). Each kind goes through the module that owns it. … | D |
| 144 | function | noteTabSetting | Record which session owns a tab setting after a call changed it (state.js claimTabSetting). A call that only reads (no … | D |
| 160 | function | extractTabId | Which tabId does this call target? null = tab-agnostic (tabs list/create). | D |
| 169 | const-function | canDrawShield | Whether a call's tab can take the show step. A frozen page cannot run it, and neither can a page … | D |
| 172 | const-function | vaultPermissionDenied | ~ vault permission denied | N |
| 175 | function | isVaultActionMessage | A malformed vault call is dropped before any work starts. | D |
| 181 | function | vaultErrorCode | `const message = error instanceof Error ? error.message : '';` | B |
| 187 | function | runVaultActionInTab | A tab-bound vault action holds that tab's lock and shows it busy, like any other call. | D |
| 203 | function | handleVaultMessage (async) | ~ handles vault message | N |
| 211 | const-function | action (async) | `? vaultPermissionDenied()` | B |
| 226 | function | handleMessage (exp, async, cx50) | ~ handles message | N |

## extension/lib/state.js

306 lines · 16 symbols · 15 exported · fan-in 16 · fan-out 2

| line | kind | symbol | purpose | ev |
|---:|---|---|---|---|
| 57 | function | refBaseFor (exp) | The counter base a new document of this tab starts from. | D |
| 61 | function | noteRefsShown (exp) | Record the refs a page result showed (`highest`: their largest number); persisted when it moves up. | D |
| 81 | object-function | nameOf | ~ name of | N |
| 100 | function | replacementOf (exp) | The tab that `tabId` was replaced by, following a chain (replaced twice: the last tab). Undefined when the tab was … | D |
| 110 | function | followReplacedTab (exp) | A tab was replaced by a new one in the same place. The new tab takes over the old one's … | D |
| 127 | function | getAdoptedDaemonInstance (exp) | `return adoptedDaemonInstance;` | B |
| 130 | function | setAdoptedDaemonInstance (exp) | `adoptedDaemonInstance = instanceId;` | B |
| 134 | function | getTabBuffer (exp) | ~ reads tab buffer | N |
| 152 | function | claimTabSetting (exp) | `sessionId` set `kind` on `tabId`. An anonymous caller (no session) clears the claim: nobody owns it. | D |
| 163 | function | tabSettingOwner (exp) | The session that owns `kind` on `tabId`, or undefined. | D |
| 172 | function | releaseSessionSettings (exp) | Take every setting `sessionId` owns, forgetting its claims. Returns [{tabId, kind}] for the caller to clear. Synchronous, like TabLockMap.releaseByOwner. @returns … | D |
| 190 | function | releaseBodyCapture (exp) | Stop a tab's response-body capture: its listener, its bodies and its pin on the debugger session (the session may then … | D |
| 216 | function | persistSessionState (exp) | Persist lock ownership + smart-selector fallbacks to chrome.storage.session. Called after every mutation (cheap: the payload is small). Failures are swallowed … | D |
| 242 | function | loadSessionState (exp, async, cx23) | Restore locks + fallbacks after a service-worker recycle. Must complete BEFORE the WS connect (so the shield sweep honors restored … | D |
| 282 | function | dropDocumentState (exp) | Invalidate document-bound refs without releasing the tab's durable lock. | D |
| 291 | function | dropTabState (exp) | Drop one tab's durable state (tab closed). Its mock rules go with it: the listener is unsubscribed, so nothing keeps … | D |

## extension/lib/tab-concurrency.js

348 lines · 29 symbols · 29 exported · fan-in 6 · fan-out 0

| line | kind | symbol | purpose | ev |
|---:|---|---|---|---|
| 16 | class | TabMutexMap (exp) | Per-tab promise chain: calls to one tab serialise, different tabs run in parallel. | R |
| 17 | constructor | TabMutexMap.constructor (exp) | `this.queues = new Map();` | B |
| 29 | method | TabMutexMap.run (exp) | Queues a function behind the tab's chain and drops the map entry once it is still the latest. | R |
| 54 | method | TabMutexMap.isIdle (exp) | Whether nothing is pending for a tab (test helper). | R |
| 66 | function | tabLockedMessage (exp) | The TAB_LOCKED refusal text naming the owning session, agent and time. | R |
| 79 | class | TabLockMap (exp) | Per-tab exclusive ownership by one session, with the grant kept for the refusal message. | R |
| 85 | constructor | TabLockMap.constructor (exp) | Stores the agent-name resolver used when a lock is taken. | R |
| 92 | method | TabLockMap.owner (exp) | The owning session id of a tab, if any. | R |
| 97 | method | TabLockMap.grantOf (exp) | A copy of the full lock grant for a tab. | R |
| 111 | method | TabLockMap.lock (exp) | Claims a tab for a session without stealing it; a holder keeps its original grant. | R |
| 123 | method | TabLockMap.unlock (exp) | Releases a tab only when the caller owns it. | R |
| 130 | method | TabLockMap.release (exp) | Releases a tab unconditionally (tab closed). | R |
| 142 | method | TabLockMap.releaseByOwner (exp) | Releases every tab owned by a session and returns the ids (agent disconnected). | R |
| 154 | method | TabLockMap.snapshot (exp) | A serialisable list of current locks for the popup and persistence. | R |
| 164 | method | TabLockMap.unlockAll (exp) | Drops all locks. | R |
| 176 | method | TabLockMap.check (exp) | Throws TAB_LOCKED immediately when another session owns the tab. | R |
| 197 | class | TabControlMap (exp, cx22) | Records which session is acting on a tab (display only), lingering after the last call. | R |
| 202 | constructor | TabControlMap.constructor (exp) | Stores the linger window and the clock. | R |
| 216 | method | TabControlMap.begin (exp) | Registers one in-flight call on a tab and returns its handle. | R |
| 236 | method | TabControlMap.end (exp) | Removes one call handle and expires the entry when it was the last and no linger applies. | R |
| 251 | method | TabControlMap.controller (exp) | The live controller of a tab, or undefined once idle past the linger window. | R |
| 261 | method | TabControlMap.settle (exp) | Marks a tab as handed back so its linger is skipped. | R |
| 269 | method | TabControlMap.move (exp) | Moves a tab's control entry when a frozen tab is replaced. | R |
| 278 | method | TabControlMap.release (exp) | Forgets a closed tab. | R |
| 286 | method | TabControlMap.clear (exp) | Forgets every tab (the daemon that drove them is gone). | R |
| 294 | method | TabControlMap.releaseByOwner (exp) | Drops a session's calls and its label, promoting the latest remaining caller. | R |
| 309 | method | TabControlMap.prune (exp) | Drops entries idle past the linger window. | R |
| 314 | method | TabControlMap.expired (exp) | Whether an entry has no calls and has outlived the linger window. | R |
| 337 | function | runOnTab (exp, async) | Checks the lock before and inside the per-tab queue, deferring and retrying when the tab changed hands. | R |

## extension/lib/target.js

66 lines · 2 symbols · 2 exported · fan-in 7 · fan-out 0

| line | kind | symbol | purpose | ev |
|---:|---|---|---|---|
| 20 | function | parseTarget (exp, cx23) | ~ parses target | N |
| 58 | function | targetLabel (exp) | Human-readable locator label for action receipts and errors. | D |

## extension/lib/trusted-input.js

567 lines · 39 symbols · 15 exported · fan-in 5 · fan-out 8

| line | kind | symbol | purpose | ev |
|---:|---|---|---|---|
| 23 | function | cdpClickAt (exp, async) | ~ CDP click at | N |
| 31 | const-function | sleep | ~ sleep | N |
| 43 | function | pageLocate (cx152) | Page-side: resolve `target` (the parsed lib/target.js object) through the shared DOM runtime (D.resolveTarget), scroll it into view when it is … | D |
| 63 | const-function | deepActive | The element the keyboard reaches: from the top document down through focused shadow roots // and same-origin frames. A frame … | D |
| 167 | const-function | isFocused | `const a = deepActive();` | B |
| 201 | function | inFullView | Is `el` wholly inside the viewport (its own frame's and the top one), with nothing over its centre? A box … | D |
| 205 | const-function | fits | ~ fits | N |
| 214 | function | animating | Does a CSS animation or transition run on `node` or on an element around it? | D |
| 224 | function | clickActs | Controls whose click does more than focus them. | D |
| 231 | function | readOnlyField | A text field that takes no typing: readonly applies to textareas and text-like inputs only. | D |
| 243 | function | watchInput (cx27) | Record the trusted input this measurement is for as the page gets it (pageRelease reads it): whether any of it … | D |
| 244 | const-function | opaque | ~ opaque | N |
| 256 | object-function | off | ~ off | N |
| 258 | const-function | record | `if (!e.isTrusted) return;` | B |
| 274 | function | pagePointInfo | Page-side: what is at a top-level viewport point (pierces shadow roots and same-origin frames), open the agent's input window, and … | D |
| 300 | function | pointInfo (exp, async) | Describe the element at (x, y), let trusted input through the shield, and — when the agent cursor is switched … | D |
| 313 | function | targetAim (exp) | What a `target` locator aims at: the parsed locator and, for a ref, its snapshot fallback (the descriptor the page … | D |
| 323 | function | wordTargetRefMiss (exp) | A ref miss on the target path is worded here. The page says whether the ref was ever issued (`issued`); … | D |
| 334 | function | locateTarget (exp, async) | Locate the element (or point) a tool acts on: `target` is the shared locator contract (contract principle 2). Without one, … | D |
| 338 | const-function | run | ~ run | N |
| 363 | function | untilStill (async) | The scroll that brought a target into view ran the page's scroll handlers, which can move it (a menu that … | D |
| 383 | function | locatePointer (exp, async) | locateTarget for mouse input. With the agent cursor switched on, it glides to the target first (`effect`: 'move' \| 'click'); … | D |
| 402 | function | requireSender (exp, async) | The tab's CDP session. Browser input never falls back to synthetic events: when the debugger cannot attach this throws DEBUGGER_UNAVAILABLE. | D |
| 411 | function | clipText (exp) | A page-controlled text cut to `max` characters for a result line ("…" marks the cut). | D |
| 417 | function | dialogSummary (exp) | `confirm "Delete this item?"`: the dialog as a result line names it (type, clipped message). | D |
| 424 | const-function | cancelledError | ~ cancelled error | N |
| 427 | const-function | isRelease | A release (mouse up, key up) completes a press that already went out: it is sent even when the call … | D |
| 434 | function | assertInputReady (exp) | Refuse an input before anything is sent: a JS dialog is open on the tab (the page takes no input … | D |
| 454 | function | inputSession (exp) | The CDP send for one input call. Two things a bare `await send(...)` gets wrong: - A JS dialog that … | D |
| 465 | getter | blocked | ~ exposes blocked of  | N |
| 468 | object-function | send (async) | ~ send | N |
| 485 | object-function | close | ~ close | N |
| 496 | function | focusByClick (exp, async) | Focus a target the way a person does: a trusted click on it, unless it already has focus. A control … | D |
| 507 | function | pageMeasure | Page-side: where a target is now. No scroll, no focus, no actionability check. | D |
| 520 | function | measureTarget (exp, async) | Where a target's centre is right now, as measured by the page, and whether that point is inside the viewport. … | D |
| 527 | function | pageSelectFocused | Page-side: select everything in the field that has focus (a DOM selection, no key events). | D |
| 548 | function | selectFocused (exp, async) | First step of clear: select the focused field's whole contents, so the next insert or Backspace replaces them. | D |
| 552 | function | pageCursor | `const D = globalThis.__bcDom;` | B |
| 563 | function | cursorTo (exp, async) | Glide the agent cursor to (x, y) without waiting; returns the glide's duration in ms (0: nothing to wait for, … | D |

## extension/lib/vault-connection.js

107 lines · 13 symbols · 13 exported · fan-in 1 · fan-out 1

| line | kind | symbol | purpose | ev |
|---:|---|---|---|---|
| 8 | class | VaultConnectionChannel (exp, cx24) | Owns the optional vault protocol state layered on the base WS connection. | D |
| 9 | constructor | VaultConnectionChannel.constructor (exp) | ~ constructs VaultConnectionChannel | N |
| 16 | method | VaultConnectionChannel.setSupported (exp) | `this.supported = Boolean(supported);` | B |
| 20 | method | VaultConnectionChannel.isReady (exp) | `return this.isConnected() && this.supported;` | B |
| 24 | method | VaultConnectionChannel.failure (exp) | `return { success: false, code, message };` | B |
| 28 | method | VaultConnectionChannel.settleUiRequest (exp) | ~ settle UI request on VaultConnectionChannel | N |
| 36 | method | VaultConnectionChannel.sendProtectionState (exp) | ~ sends protection state on VaultConnectionChannel | N |
| 48 | method | VaultConnectionChannel.sendProtectionTabRemoved (exp) | `if (!removal \|\| !Number.isSafeInteger(removal.sequence) \|\| !Number.isInteger(re...` | B |
| 54 | method | VaultConnectionChannel.sendUiClosed (exp) | `if (this.isReady()) this.sendJson({ type: 'vaultUiClosed' });` | B |
| 58 | method | VaultConnectionChannel.requestUi (exp) | ~ request UI on VaultConnectionChannel | N |
| 78 | method | VaultConnectionChannel.handleMessage (exp) | ~ handles message on VaultConnectionChannel | N |
| 96 | method | VaultConnectionChannel.failUiRequests (exp) | `for (const id of [...this.pendingUiRequests.keys()]) {` | B |
| 102 | method | VaultConnectionChannel.sendJson (exp) | `const socket = this.getSocket();` | B |

## extension/lib/vault.js

600 lines · 37 symbols · 16 exported · fan-in 5 · fan-out 2

| line | kind | symbol | purpose | ev |
|---:|---|---|---|---|
| 24 | function | isPrivateVaultUrl (exp) | Whether a URL is the extension's own private vault page. | R |
| 33 | function | safeFailure | Maps a failure code to the user-facing message returned to the agent. | R |
| 47 | function | canonicalOrigin | Accepts only HTTPS, or HTTP on localhost, with no credentials in the URL; returns its origin. | R |
| 57 | function | getMainDocument (async) | Reads the tab, its main frame document id and a canonical origin in one step. | R |
| 68 | function | executeVaultScript (async) | Runs one injected vault script with a timeout and abort handling, marking the tab wedged on timeout. | R |
| 74 | const-function | finish | ~ finish | N |
| 87 | const-function | onAbort | ~ callback for abort | N |
| 94 | function | getSameOriginFrames (async) | Enumerates the frames, rejecting duplicate ids and requiring the top frame to still have the expected origin. | R |
| 119 | function | sameFrameDocuments | Whether two frame lists describe the same documents (frame id, document id and URL). | R |
| 124 | function | clearInspectionsInFrames (async) | Best-effort clears one inspection nonce in every given frame, without throwing. | R |
| 134 | function | inspectPasswordField (exp, cx35) | Runs in the page's isolated world: finds every visible password input across open shadow roots and retains only the single one that is safe to fill. | R |
| 137 | const-function | collect | Chrome serializes only this function when using chrome.scripting. Keep all // page-side helpers nested so no extension module scope is … | D |
| 142 | const-function | visible (cx27) | ~ visible | N |
| 171 | function | clearPasswordInspection | Runs in the page: drops the retained password element when the nonce matches. | R |
| 177 | function | fillInspectedPassword (exp, cx40) | Runs in the page: re-proves the retained element is still the only safe password field, then sets its value without submitting. | R |
| 180 | const-function | collect | `for (const field of root.querySelectorAll?.('input[type="password"]') ?? []) if...` | B |
| 185 | const-function | visible (cx21) | ~ visible | N |
| 221 | function | protectionSnapshot | Snapshots protected documents and pending removals for persistence and the popup. | R |
| 228 | function | saveRuntimeState (async) | Persists protection state: the durable may-contain-secrets marker first, then session state, then clears a stale marker. | R |
| 258 | function | pruneInspections | Drops expired inspection nonces. | R |
| 263 | function | bumpProtectionSequence | Increments and returns the monotonic protection sequence. | R |
| 268 | function | getVaultProtectionSnapshot (exp, async) | Returns the current protection snapshot for the private page, including uncertainty flags. | R |
| 280 | function | restoreVaultRuntimeState (exp, async, cx57) | Rebuilds in-memory protection state after a worker restart and fails closed when the durable marker cannot be reconciled. | R |
| 346 | function | acknowledgeVaultProtection (exp) | Accepts a protection acknowledgement without ever clearing protection. | R |
| 351 | function | acknowledgeVaultRemoval (exp, async) | Removes an acknowledged pending removal and re-persists state. | R |
| 359 | function | isPrivateVaultTab (exp) | Whether a tab is the private vault page. | R |
| 363 | function | isPrivateVaultSender (exp) | Whether a message sender is this extension's own vault page. | R |
| 367 | function | openPrivateVault (exp, async) | Focuses the existing private vault tab, or opens one. | R |
| 382 | function | registerPrivateVaultTab (exp) | Remembers a tab as a private vault tab. | R |
| 386 | function | forgetPrivateVaultTab (exp) | Forgets a private vault tab. | R |
| 390 | function | removeProtectedTab (exp, async) | Un-protects a closing tab and queues a removal event for the daemon, restoring state if persistence fails. | R |
| 413 | function | markDocumentCurrent (exp, async) | Marks which protected document in a tab is the current one and bumps the sequence when that changed. | R |
| 429 | function | clearInspectionState (exp, async) | Clears in-memory inspection nonces (they expire anyway on worker recycle). | R |
| 435 | function | inspectAction (async, cx25) | The inspect action: proves one safe password field exists in one document and issues a one-shot nonce. | R |
| 504 | function | markRecoveryRequired (async) | Marks a document recovery_required after a fill that could not be proven safe. | R |
| 510 | function | fillAction (async, cx51) | The fill action: consumes the nonce, re-proves the document, marks the tab protected before typing, then fills and re-proves the outcome. | R |
| 587 | function | handleVaultAction (exp, async) | Dispatches one vault action (inspect, fill, openUi) and converts any throw into a safe failure. | R |

## extension/popup/open-tabs-view.js

113 lines · 6 symbols · 6 exported · fan-in 2 · fan-out 0

| line | kind | symbol | purpose | ev |
|---:|---|---|---|---|
| 8 | function | escapeHtml (exp) | Pure rendering for the popup's Open Tabs panel: strings in, strings out — no DOM, no chrome. — so it … | D |
| 13 | function | agentFor (exp) | The daemon-roster entry for a sessionId (undefined when it isn't listed). | D |
| 22 | function | agentLabelFor (exp) | Human label for a sessionId ("name · ID"). Falls back to `fallbackName` (e.g. the name the agent sent with its … | D |
| 34 | function | controlBadgeParts (exp) | Badge for a tab an agent is driving without a lock: filled dot while a call runs, hollow during the … | D |
| 51 | function | openTabsSignature (exp) | Everything that changes the rows' STRUCTURE. The running/idle flag of a controlled tab is deliberately left out: it flips on … | D |
| 66 | function | renderOpenTabRows (exp) | The rows' HTML. `picks` (Map tabId → sessionId, '' = none) holds Pin choices the user made but hasn't applied: … | D |

## extension/popup/popup-vault.js

9 lines · 1 symbols · 1 exported · fan-in 1 · fan-out 0

| line | kind | symbol | purpose | ev |
|---:|---|---|---|---|
| 1 | function | bindVaultOpenButton (exp) | ~ bind vault open button | N |

## extension/popup/popup.js

599 lines · 20 symbols · 0 exported · fan-in 0 · fan-out 2

| line | kind | symbol | purpose | ev |
|---:|---|---|---|---|
| 42 | function | switchTab | ~ switch tab | N |
| 68 | function | setNeedsSetup | First-run hint: the Settings tab glows amber until enrollment is set. | D |
| 90 | function | addLog | ~ add log | N |
| 108 | function | daemonHttpBase | ── Daemon HTTP (auto-pair, agents, disconnect) ──────────────────────────── // The popup talks to the daemon's HTTP endpoints (same port as the … | D |
| 119 | function | daemonFetch (async) | Authenticated fetch wrapper: sends the enrollment secret in the X-BC-Enrollment header on every daemon HTTP call. Without this, /pair (and … | D |
| 132 | function | autoPairToken (async) | Auto-pair: fetch the daemon's token over localhost and hand it to the background worker, which offers it in the WS … | D |
| 148 | function | refreshAgents (async) | Poll the daemon for connected agents and render them. | D |
| 162 | function | setAgents | ~ sets agents | N |
| 172 | function | renderAgents | ~ renders agents | N |
| 203 | function | disconnectAgent (async) | Kick a connected agent off the daemon immediately (don't wait ~45s for the heartbeat to evict it). Calls the daemon's … | D |
| 232 | function | renderOpenTabs | ~ renders open tabs | N |
| 268 | function | patchControlBadges | Refresh each control badge's running/idle state without touching the row. | D |
| 282 | function | updateUI | ── Status rendering ─────────────────────────────────────────────────────── | D |
| 324 | function | refreshStatus | Fetch connection + tabs + locks state from the background worker. | D |
| 338 | function | startPolling | ~ starts polling | N |
| 348 | function | stopPolling | ~ stops polling | N |
| 393 | function | bindDebouncedInput | ── Settings inputs (shared debounced wiring — was 3 copy-pasted blocks) ─── | D |
| 515 | function | applySize | ~ applies size | N |
| 547 | function | flushResize | `rafHandle = 0;` | B |
| 580 | function | endDrag | ~ end drag | N |

## extension/utils/navigation.js

94 lines · 5 symbols · 3 exported · fan-in 4 · fan-out 0

| line | kind | symbol | purpose | ev |
|---:|---|---|---|---|
| 22 | function | isHashOnlyChange (exp) | Does `toUrl` differ from `fromUrl` only by the hash/fragment? Same protocol/host/port/pathname/search AND a different hash → true. Identical URLs (including … | D |
| 56 | function | normalizeNavigationUrl (exp) | The address to load for what the agent typed. The scheme is optional: "example.com" → https://example.com, "localhost:3000" → HTTP://localhost:3000. Without … | D |
| 67 | function | filenameOf | `const m = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disposition);` | B |
| 83 | function | classifyMainResponse (exp) | What a main-frame response means for its tab, from its webRequest status and headers. A 204/205 "No Content" never replaces … | D |
| 84 | const-function | header | ~ header | N |

## extension/utils/smart-selector.js

193 lines · 9 symbols · 1 exported · fan-in 2 · fan-out 0

| line | kind | symbol | purpose | ev |
|---:|---|---|---|---|
| 27 | function | PAGE_FALLBACK_INSTALL (exp, cx76) | --------------------------------------------------------------------------- // Page-side runtime. Self-contained inside PAGE_FALLBACK_INSTALL — injected // via chrome.scripting `func:`. generateFallback returns // { robustSelector, text, ro | D |
| 36 | function | generateFallback (cx75) | Snapshot-side: capture a stable fallback descriptor for a ref'd element. `pass` is one object per snapshot (or find) pass, shared … | D |
| 39 | function | isStableId | ~ tests whether stable ID | N |
| 50 | function | isGeneratedClass | ~ tests whether generated class | N |
| 62 | function | esc | `try { return CSS.escape(String(value)); } catch { return String(value).replace(...` | B |
| 66 | function | buildSelector | ~ builds selector | N |
| 120 | function | computeNth (cx27) | nth = how many visible same-role elements before `target` (document order) share its text. The pass indexes the body once, … | D |
| 123 | const-function | isTextMatch | ~ tests whether text match | N |
| 144 | const-function | textOf | Visible text of one candidate, read at most once per pass (null when hidden). | D |

## extension/vault/vault.js

508 lines · 29 symbols · 0 exported · fan-in 0 · fan-out 0

| line | kind | symbol | purpose | ev |
|---:|---|---|---|---|
| 1 | const-function | $ | ~  | N |
| 17 | function | element | ~ element | N |
| 24 | function | setNotice | `notice.textContent = message;` | B |
| 30 | function | explain | ~ explain | N |
| 52 | function | rpc | ~ rpc | N |
| 64 | function | setBusy | `busy = value;` | B |
| 69 | function | invoke (async) | ~ invoke | N |
| 88 | function | refreshState (async) | ~ refresh state | N |
| 104 | function | renderState | ~ renders state | N |
| 116 | function | renderRequests | ~ renders requests | N |
| 153 | function | requestTitle | ~ request title | N |
| 160 | function | renderRequest | ~ renders request | N |
| 200 | function | actionButton | ~ action button | N |
| 207 | function | actionRow | `const row = element('div', 'request-actions');` | B |
| 213 | function | declineButton | `return actionButton('Decline', '', () => invoke({ operation: 'decline', request...` | B |
| 217 | function | field | ~ field | N |
| 232 | function | checkbox | ~ checkbox | N |
| 240 | function | renderSaveRequest | ~ renders save request | N |
| 253 | const-function | submit | ~ submit | N |
| 278 | function | renderApprovalRequest | ~ renders approval request | N |
| 298 | function | captureAccountFocus | ~ capture account focus | N |
| 309 | function | restoreAccountFocus | ~ restores account focus | N |
| 331 | function | renderAccounts | ~ renders accounts | N |
| 349 | const-function | accountAction | `const button = actionButton(label, className, callback);` | B |
| 377 | function | renderAccess | ~ renders access | N |
| 415 | function | loadBackups (async) | ~ loads backups | N |
| 443 | function | entryField | `return form.elements.namedItem(name);` | B |
| 447 | function | showEntryForm | ~ show entry form | N |
| 466 | function | editEntry | `showEntryForm(entry);` | B |
