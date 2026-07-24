# Graph Report - real-browser-mcp  (2026-07-24)

## Corpus Check
- 54 files · ~66,852 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 56 nodes · 137 edges · 8 communities
- Extraction: 83% EXTRACTED · 17% INFERRED · 0% AMBIGUOUS · INFERRED: 23 edges (avg confidence: 0.5)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `3d7ef69a`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- background.js
- dispatch
- safeExec
- broadcastStatus
- connect
- handleMessage
- drive.mjs
- handleClick

## God Nodes (most connected - your core abstractions)
1. `dispatch()` - 24 edges
2. `resolveTab()` - 21 edges
3. `safeExec()` - 16 edges
4. `connect()` - 8 edges
5. `handleMessage()` - 8 edges
6. `handleClick()` - 6 edges
7. `handleType()` - 6 edges
8. `broadcastStatus()` - 5 edges
9. `handleSnapshot()` - 5 edges
10. `buildStatusPayload()` - 4 edges

## Surprising Connections (you probably didn't know these)
- `scheduleReconnect()` --indirect_call--> `connect()`  [INFERRED]
  extension/background.js → extension/background.js  _Bridges community 4 → community 3_
- `dispatch()` --indirect_call--> `handleClick()`  [INFERRED]
  extension/background.js → extension/background.js  _Bridges community 1 → community 7_
- `dispatch()` --indirect_call--> `handleClickByText()`  [INFERRED]
  extension/background.js → extension/background.js  _Bridges community 1 → community 2_
- `dispatch()` --indirect_call--> `handleConsole()`  [INFERRED]
  extension/background.js → extension/background.js  _Bridges community 1 → community 0_
- `dispatch()` --indirect_call--> `handleTabs()`  [INFERRED]
  extension/background.js → extension/background.js  _Bridges community 1 → community 3_

## Import Cycles
- None detected.

## Communities (8 total, 0 thin omitted)

### Community 0 - "background.js"
Cohesion: 0.21
Nodes (10): consoleByTab, fallbackByTab, getActiveTab(), getTabBuffer(), handleConsole(), handleNavigate(), handleNetwork(), networkByTab (+2 more)

### Community 1 - "dispatch"
Cohesion: 0.30
Nodes (12): dispatch(), handleEvaluate(), handleFillForm(), handleGetPageText(), handleHover(), handleRunAction(), handleScreenshot(), handleScroll() (+4 more)

### Community 2 - "safeExec"
Cohesion: 0.29
Nodes (7): handleClickByText(), handleDialog(), handleDrag(), handleFind(), handlePressKey(), handleSnapshot(), safeExec()

### Community 3 - "broadcastStatus"
Cohesion: 0.33
Nodes (6): broadcastStatus(), buildStatusPayload(), getConnectionState(), handleTabs(), scheduleReconnect(), tabLocksToJSON()

### Community 4 - "connect"
Cohesion: 0.50
Nodes (5): autoPairToken(), connect(), initConnection(), updateBadge(), wsUrl()

### Community 5 - "handleMessage"
Cohesion: 0.40
Nodes (5): extractTabId(), handleMessage(), hideOverlay(), sendResponse(), showOverlay()

### Community 6 - "drive.mjs"
Cohesion: 0.40
Nodes (4): params, sock, sockPath, STATE

### Community 7 - "handleClick"
Cohesion: 0.67
Nodes (4): autoReSnapshot(), getFallback(), handleClick(), handleType()

## Knowledge Gaps
- **9 isolated node(s):** `consoleByTab`, `networkByTab`, `fallbackByTab`, `tabMutex`, `tabLocks` (+4 more)
  These have ≤1 connection - possible missing edges or undocumented components.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `dispatch()` connect `dispatch` to `background.js`, `safeExec`, `broadcastStatus`, `handleMessage`, `handleClick`?**
  _High betweenness centrality (0.061) - this node is a cross-community bridge._
- **Why does `resolveTab()` connect `dispatch` to `background.js`, `safeExec`, `handleClick`?**
  _High betweenness centrality (0.035) - this node is a cross-community bridge._
- **Why does `safeExec()` connect `safeExec` to `background.js`, `dispatch`, `handleClick`?**
  _High betweenness centrality (0.015) - this node is a cross-community bridge._
- **Are the 22 inferred relationships involving `dispatch()` (e.g. with `handleClick()` and `handleClickByText()`) actually correct?**
  _`dispatch()` has 22 INFERRED edges - model-reasoned connections that need verification._
- **What connects `consoleByTab`, `networkByTab`, `fallbackByTab` to the rest of the system?**
  _9 weakly-connected nodes found - possible documentation gaps or missing edges._