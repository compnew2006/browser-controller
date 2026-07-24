# Graph Report - real-browser-mcp  (2026-07-24)

## Corpus Check
- 54 files · ~68,681 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 461 nodes · 725 edges · 32 communities (25 shown, 7 thin omitted)
- Extraction: 96% EXTRACTED · 4% INFERRED · 0% AMBIGUOUS · INFERRED: 32 edges (avg confidence: 0.56)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `1ec502e3`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- Browser Tool Definitions
- Extension Background Service
- IPC Daemon Config
- Package Metadata
- Extension Manifest
- Extension Bridge Logic
- Keywords and Dependencies
- Popup UI Logic
- Documentation
- MCP Server Tools
- TypeScript Config
- Tab Concurrency Lock
- Smart Selector Utils
- Dev Dependencies
- Monorepo Config
- README Documentation
- Install Scripts
- Extension Icons
- IPC Socket Utils
- Demo Media
- Dependabot Config
- CI/CD Workflows
- Logos
- CodeQL Workflow
- Security Scorecard
- Store Assets
- scripts
- dependencies
- files
- repository

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
- **App Icon Asset Family** — assets_icon, store_assets_icon, extension_icons_icon16, extension_icons_icon48, extension_icons_icon128, store_assets_icon_128 [EXTRACTED 0.90]
- **Brand Visual Assets** — assets_icon, assets_logo_png, assets_demo_gif, assets_preview_png [INFERRED 0.80]
- **Extension Icon Set** — extension_icons_icon16, extension_icons_icon48, extension_icons_icon128 [EXTRACTED 1.00]
- **real-browser-mcp 17 MCP Tools** — llms_browser_navigate, llms_browser_tabs, llms_browser_click, llms_browser_type, llms_browser_press_key, llms_browser_scroll, llms_browser_hover, llms_browser_select, llms_browser_wait, llms_browser_snapshot, llms_browser_screenshot, llms_browser_text, llms_browser_find, llms_browser_evaluate, llms_browser_handle_dialog, llms_browser_console, llms_browser_network [EXTRACTED 1.00]
- **real-browser-mcp Architecture** — llms_mcp_server, llms_chrome_extension, llms_real_browser_mcp [EXTRACTED 1.00]
- **Real Browser MCP Three-Piece Architecture** — mcp_server_daemon, chrome_extension, real_browser_mcp [EXTRACTED 0.95]
- **Tab-First Page Interaction Tools** — browser_snapshot_tool, browser_click_tool, browser_navigate_tool, browser_tabs_tool, browser_evaluate_tool [EXTRACTED 0.90]

## Communities (32 total, 7 thin omitted)

### Community 0 - "Browser Tool Definitions"
Cohesion: 0.10
Nodes (32): clickTool, clickTextTool, consoleTool, dialogTool, dragTool, evaluateTool, fillFormTool, findTool (+24 more)

### Community 1 - "Extension Background Service"
Cohesion: 0.10
Nodes (51): autoPairToken(), autoReSnapshot(), broadcastStatus(), buildStatusPayload(), connect(), consoleByTab, dispatch(), extractTabId() (+43 more)

### Community 2 - "IPC Daemon Config"
Cohesion: 0.08
Nodes (21): DAEMON_INFO_FILE, DEFAULT_WS_PORT, ExtensionRequest, IpcClientMessage, IpcDaemonMessage, loadOrCreateToken(), NOTE: `browser_evaluate` runs ARBITRARY user JS (can submit forms, click,, readToken() (+13 more)

### Community 3 - "Package Metadata"
Cohesion: 0.12
Nodes (15): author, bin, browser-controller, bugs, url, description, engines, node (+7 more)

### Community 4 - "Extension Manifest"
Cohesion: 0.06
Nodes (31): action, default_icon, default_popup, default_title, background, service_worker, type, content_scripts (+23 more)

### Community 5 - "Extension Bridge Logic"
Cohesion: 0.12
Nodes (10): BridgeOptions, CORS, ExtensionBridge, findListenersOnPort(), HttpRequestHandler, isPortInUse(), PendingRequest, TOOL_TIMEOUTS (+2 more)

### Community 6 - "Keywords and Dependencies"
Cohesion: 0.10
Nodes (20): keywords, ai-agent, ai-coding, browser, browser-automation, browser-control, browser-controller, browser-use (+12 more)

### Community 7 - "Popup UI Logic"
Cohesion: 0.11
Nodes (21): agentsEl, agentsTimer, applySize(), autoPairToken(), daemonHttpBase(), detailEl, dot, endDrag() (+13 more)

### Community 8 - "Documentation"
Cohesion: 0.11
Nodes (22): AGENTS.md (Claude Code Config), Browser Automation Skill, browser_click Tool, browser_evaluate Tool, browser_navigate Tool, browser_snapshot Tool, browser_tabs Tool, Chrome Extension (Manifest V3) (+14 more)

### Community 9 - "MCP Server Tools"
Cohesion: 0.10
Nodes (22): ofershap (funding recipient), browser_click tool, browser_console tool, browser_evaluate tool, browser_find tool, browser_handle_dialog tool, browser_hover tool, browser_navigate tool (+14 more)

### Community 10 - "TypeScript Config"
Cohesion: 0.09
Nodes (21): compilerOptions, declaration, declarationMap, esModuleInterop, forceConsistentCasingInFileNames, lib, module, moduleResolution (+13 more)

### Community 11 - "Tab Concurrency Lock"
Cohesion: 0.15
Nodes (3): runOnTab(), TabLockMap, TabMutexMap

### Community 12 - "Smart Selector Utils"
Cohesion: 0.23
Nodes (13): buildRobustSelectorFromPath(), computeNewFingerprints(), computeNth(), cssEscape(), isGeneratedClass(), isStableId(), PAGE_FALLBACK_FN(), PAGE_RESOLVE_FALLBACK_FN() (+5 more)

### Community 13 - "Dev Dependencies"
Cohesion: 0.18
Nodes (11): ai-context-kit, devDependencies, ai-context-kit, @types/node, @types/ws, typescript, vitest, @types/node (+3 more)

### Community 14 - "Monorepo Config"
Cohesion: 0.22
Nodes (8): description, name, packages, repository, source, url, $schema, version

### Community 15 - "README Documentation"
Cohesion: 0.25
Nodes (7): Agent Config, Claude Code, Cursor, Manual Install, Quick Setup, Skill, What Gets Installed

### Community 16 - "Install Scripts"
Cohesion: 0.47
Nodes (4): copyIfNeeded(), __dirname, ensureDir(), installCursor()

### Community 17 - "Extension Icons"
Cohesion: 0.33
Nodes (6): App Icon SVG, Extension Icon 128px, Extension Icon 16px, Extension Icon 48px, Store Icon SVG, Store Icon 128px PNG

### Community 18 - "IPC Socket Utils"
Cohesion: 0.40
Nodes (4): params, sock, sockPath, STATE

### Community 28 - "scripts"
Cohesion: 0.15
Nodes (13): scripts, build, context:lint, context:measure, dev, format, lint, setup:claude (+5 more)

### Community 29 - "dependencies"
Cohesion: 0.29
Nodes (7): @modelcontextprotocol/sdk, dependencies, @modelcontextprotocol/sdk, ws, zod, ws, zod

### Community 30 - "files"
Cohesion: 0.33
Nodes (6): files, agent-config/, extension/, LICENSE, mcp-server/dist/, README.md

### Community 31 - "repository"
Cohesion: 0.67
Nodes (3): repository, type, url

## Knowledge Gaps
- **191 isolated node(s):** `consoleByTab`, `networkByTab`, `fallbackByTab`, `lastSnapshotFingerprints`, `tabMutex` (+186 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **7 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `DaemonClient` connect `IPC Daemon Config` to `Tab Concurrency Lock`?**
  _High betweenness centrality (0.027) - this node is a cross-community bridge._
- **Why does `ExtensionBridge` connect `Extension Bridge Logic` to `IPC Daemon Config`?**
  _High betweenness centrality (0.017) - this node is a cross-community bridge._
- **Are the 22 inferred relationships involving `dispatch()` (e.g. with `handleClick()` and `handleClickByText()`) actually correct?**
  _`dispatch()` has 22 INFERRED edges - model-reasoned connections that need verification._
- **What connects `consoleByTab`, `networkByTab`, `fallbackByTab` to the rest of the system?**
  _191 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Browser Tool Definitions` be split into smaller, more focused modules?**
  _Cohesion score 0.09994155464640561 - nodes in this community are weakly interconnected._
- **Should `Extension Background Service` be split into smaller, more focused modules?**
  _Cohesion score 0.09796806966618288 - nodes in this community are weakly interconnected._
- **Should `IPC Daemon Config` be split into smaller, more focused modules?**
  _Cohesion score 0.08416389811738649 - nodes in this community are weakly interconnected._