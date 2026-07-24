# Graph Report - .  (2026-07-24)

## Corpus Check
- cluster-only mode — file stats not available

## Summary
- 438 nodes · 714 edges · 23 communities (19 shown, 4 thin omitted)
- Extraction: 96% EXTRACTED · 4% INFERRED · 0% AMBIGUOUS · INFERRED: 27 edges (avg confidence: 0.51)
- Token cost: 856 input · 1,430 output

## Graph Freshness
- Built from commit: `4bd588f3`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- Browser Interaction Tools
- Background Script Utilities
- Daemon IPC Configuration
- Package Manifest Metadata
- Extension Manifest Config
- Extension Bridge Client
- NPM Dependencies and Keywords
- Popup UI Logic
- Documentation and Guides
- Exposed MCP Tools
- TypeScript Configuration
- Tab Concurrency Locking
- Smart Element Selectors
- Development Dependencies
- Workspace Server Config
- CLI Setup Scripts
- Socket Driver
- Dependabot Configuration
- CI and Release Workflows
- CodeQL Analysis Workflow
- Security Scorecard Workflow

## God Nodes (most connected - your core abstractions)
1. `dispatch()` - 24 edges
2. `ToolDefinition` - 24 edges
3. `textResult()` - 23 edges
4. `resolveTab()` - 21 edges
5. `requireTabId()` - 21 edges
6. `keywords` - 20 edges
7. `real-browser-mcp` - 20 edges
8. `ExtensionBridge` - 18 edges
9. `safeExec()` - 16 edges
10. `compilerOptions` - 15 edges

## Surprising Connections (you probably didn't know these)
- `Real Browser MCP` --references--> `Chrome Web Store Listing`  [EXTRACTED]
  README.md → CHROME_WEB_STORE.md
- `Real Browser MCP` --references--> `Code of Conduct`  [EXTRACTED]
  README.md → CODE_OF_CONDUCT.md
- `Real Browser MCP` --references--> `Contributing Guide`  [EXTRACTED]
  README.md → CONTRIBUTING.md
- `Real Browser MCP` --references--> `Privacy Policy`  [EXTRACTED]
  README.md → PRIVACY.md
- `Real Browser MCP` --references--> `Security Policy`  [EXTRACTED]
  README.md → SECURITY.md

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **real-browser-mcp 17 MCP Tools** — llms_browser_navigate, llms_browser_tabs, llms_browser_click, llms_browser_type, llms_browser_press_key, llms_browser_scroll, llms_browser_hover, llms_browser_select, llms_browser_wait, llms_browser_snapshot, llms_browser_screenshot, llms_browser_text, llms_browser_find, llms_browser_evaluate, llms_browser_handle_dialog, llms_browser_console, llms_browser_network [EXTRACTED 1.00]
- **real-browser-mcp Architecture** — llms_mcp_server, llms_chrome_extension, llms_real_browser_mcp [EXTRACTED 1.00]
- **Real Browser MCP Three-Piece Architecture** — mcp_server_daemon, chrome_extension, real_browser_mcp [EXTRACTED 0.95]
- **Tab-First Page Interaction Tools** — browser_snapshot_tool, browser_click_tool, browser_navigate_tool, browser_tabs_tool, browser_evaluate_tool [EXTRACTED 0.90]

## Communities (23 total, 4 thin omitted)

### Community 0 - "Browser Interaction Tools"
Cohesion: 0.10
Nodes (32): clickTool, clickTextTool, consoleTool, dialogTool, dragTool, evaluateTool, fillFormTool, findTool (+24 more)

### Community 1 - "Background Script Utilities"
Cohesion: 0.11
Nodes (48): autoPairToken(), autoReSnapshot(), broadcastStatus(), buildStatusPayload(), connect(), consoleByTab, dispatch(), extractTabId() (+40 more)

### Community 2 - "Daemon IPC Configuration"
Cohesion: 0.08
Nodes (21): DAEMON_INFO_FILE, DEFAULT_WS_PORT, ExtensionRequest, IpcClientMessage, IpcDaemonMessage, loadOrCreateToken(), NOTE: `browser_evaluate` runs ARBITRARY user JS (can submit forms, click,, readToken() (+13 more)

### Community 3 - "Package Manifest Metadata"
Cohesion: 0.05
Nodes (37): author, bin, browser-controller, bugs, url, description, engines, node (+29 more)

### Community 4 - "Extension Manifest Config"
Cohesion: 0.06
Nodes (31): action, default_icon, default_popup, default_title, background, service_worker, type, content_scripts (+23 more)

### Community 5 - "Extension Bridge Client"
Cohesion: 0.12
Nodes (10): BridgeOptions, CORS, ExtensionBridge, findListenersOnPort(), HttpRequestHandler, isPortInUse(), PendingRequest, TOOL_TIMEOUTS (+2 more)

### Community 6 - "NPM Dependencies and Keywords"
Cohesion: 0.08
Nodes (26): @modelcontextprotocol/sdk, dependencies, @modelcontextprotocol/sdk, ws, zod, keywords, ai-agent, ai-coding (+18 more)

### Community 7 - "Popup UI Logic"
Cohesion: 0.11
Nodes (21): agentsEl, agentsTimer, applySize(), autoPairToken(), daemonHttpBase(), detailEl, dot, endDrag() (+13 more)

### Community 8 - "Documentation and Guides"
Cohesion: 0.11
Nodes (22): AGENTS.md (Claude Code Config), Browser Automation Skill, browser_click Tool, browser_evaluate Tool, browser_navigate Tool, browser_snapshot Tool, browser_tabs Tool, Chrome Extension (Manifest V3) (+14 more)

### Community 9 - "Exposed MCP Tools"
Cohesion: 0.10
Nodes (22): ofershap (funding recipient), browser_click tool, browser_console tool, browser_evaluate tool, browser_find tool, browser_handle_dialog tool, browser_hover tool, browser_navigate tool (+14 more)

### Community 10 - "TypeScript Configuration"
Cohesion: 0.09
Nodes (21): compilerOptions, declaration, declarationMap, esModuleInterop, forceConsistentCasingInFileNames, lib, module, moduleResolution (+13 more)

### Community 11 - "Tab Concurrency Locking"
Cohesion: 0.15
Nodes (5): handleTabs(), tabLocksToJSON(), runOnTab(), TabLockMap, TabMutexMap

### Community 12 - "Smart Element Selectors"
Cohesion: 0.27
Nodes (10): buildRobustSelectorFromPath(), cssEscape(), isGeneratedClass(), isStableId(), PAGE_FALLBACK_FN(), PAGE_RESOLVE_FALLBACK_FN(), STABLE_ATTRS, FakeEl (+2 more)

### Community 13 - "Development Dependencies"
Cohesion: 0.18
Nodes (11): ai-context-kit, devDependencies, ai-context-kit, @types/node, @types/ws, typescript, vitest, @types/node (+3 more)

### Community 14 - "Workspace Server Config"
Cohesion: 0.22
Nodes (8): description, name, packages, repository, source, url, $schema, version

### Community 15 - "CLI Setup Scripts"
Cohesion: 0.47
Nodes (4): copyIfNeeded(), __dirname, ensureDir(), installCursor()

### Community 16 - "Socket Driver"
Cohesion: 0.40
Nodes (4): params, sock, sockPath, STATE

## Knowledge Gaps
- **175 isolated node(s):** `consoleByTab`, `networkByTab`, `fallbackByTab`, `tabMutex`, `tabLocks` (+170 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **4 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `DaemonClient` connect `Daemon IPC Configuration` to `Tab Concurrency Locking`?**
  _High betweenness centrality (0.117) - this node is a cross-community bridge._
- **Why does `TabLockMap` connect `Tab Concurrency Locking` to `Background Script Utilities`?**
  _High betweenness centrality (0.065) - this node is a cross-community bridge._
- **Why does `tabLocksToJSON()` connect `Tab Concurrency Locking` to `Background Script Utilities`?**
  _High betweenness centrality (0.046) - this node is a cross-community bridge._
- **Are the 22 inferred relationships involving `dispatch()` (e.g. with `handleClick()` and `handleClickByText()`) actually correct?**
  _`dispatch()` has 22 INFERRED edges - model-reasoned connections that need verification._
- **What connects `consoleByTab`, `networkByTab`, `fallbackByTab` to the rest of the system?**
  _175 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Browser Interaction Tools` be split into smaller, more focused modules?**
  _Cohesion score 0.09994155464640561 - nodes in this community are weakly interconnected._
- **Should `Background Script Utilities` be split into smaller, more focused modules?**
  _Cohesion score 0.10530612244897959 - nodes in this community are weakly interconnected._