<p align="center">
  <img src="assets/logo.png" alt="Browser Controller" width="100" height="100" />
</p>

<h1 align="center">Browser Controller</h1>

<p align="center">
  <strong>The missing piece in AI coding: your agent can now see your REAL browser.</strong>
</p>

<p align="center">
  <a href="https://chromewebstore.google.com/detail/real-browser-mcp/fkkimpklpgedomcheiojngaaaicmaidi"><img src="https://img.shields.io/badge/Chrome_Extension-4285F4?style=for-the-badge&logo=googlechrome&logoColor=white" alt="Chrome Extension" /></a>
  &nbsp;
  <a href="https://www.npmjs.com/package/browser-controller"><img src="https://img.shields.io/badge/MCP_Server-CB3837?style=for-the-badge&logo=npm&logoColor=white" alt="MCP Server" /></a>
  &nbsp;
  <a href="cursor://anysphere.cursor-deeplink/mcp/install?name=browser-controller&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsImJyb3dzZXItY29udHJvbGxlciJdfQ=="><img src="https://img.shields.io/badge/Add_to_Cursor-6366f1?style=for-the-badge&logo=data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IDAgMCAyNCAyNCI+PHBhdGggZD0iTTEyIDJMMiA3bDEwIDUgMTAtNS0xMC01ek0yIDE3bDEwIDUgMTAtNS0xMC01LTEwIDV6TTIgMTJsMTAgNSAxMC01LTEwLTUtMTAgNXoiIGZpbGw9IndoaXRlIi8+PC9zdmc+" alt="Add to Cursor" /></a>
  &nbsp;
  <a href="#-teach-your-agent"><img src="https://img.shields.io/badge/🧠_Agent_Rules-22c55e?style=for-the-badge" alt="Agent Rules" /></a>
</p>

<p align="center">
  <a href="https://opensource.org/licenses/MIT"><img src="https://img.shields.io/badge/License-MIT-yellow.svg" alt="License: MIT" /></a>
  <a href="https://www.typescriptlang.org/"><img src="https://img.shields.io/badge/TypeScript-strict-blue" alt="TypeScript" /></a>
  <img src="https://img.shields.io/badge/tests-vitest%20covered-22c55e" alt="Vitest test suite" />
</p>

<p align="center">
  <img src="assets/demo.gif" alt="Demo" />
</p>

---

## What this project solves

You ship a fix. Your agent says "done, please verify."
You alt-tab to Chrome, navigate to the page, log in, click around, find the bug.

Your agent just wrote the code. It could also verify it.
It already has your browser open right there. It just can't see it.

**Now it can.** Browser Controller gives any MCP-compatible AI agent (Cursor, Claude Desktop, Windsurf, …) direct control of the **browser you already have open** — your real sessions, your logins, your cookies. No headless browser, no fresh profile, no re-authentication.

### What's new in v2 (multi-client)

v1 was a single-client server: one agent, one active tab. If you switched tabs or ran two agents, they stepped on each other. **v2 is a multi-client daemon with explicit tab targeting:**

- **Multiple agents at once.** Cursor can drive tab 10 while Claude drives tab 11 — both through one shared daemon, neither blocking the other.
- **Tab targeting, not "the active tab."** Every action names a `tabId`. Move your mouse, switch tabs, watch YouTube — the agent keeps working on the tab you told it to. It never hijacks the page you're reading.
- **Per-tab isolation.** Element refs, console logs, and network buffers are scoped per tab. A ref from tab 10 can never click something in tab 20.
- **Per-tab concurrency.** Two actions on the *same* tab serialize (no races); actions on *different* tabs run in parallel.
- **Tab locking.** An agent can claim a tab so others queue behind it instead of racing (`browser_tabs { action: "lock" }`).
- **Authenticated WebSocket.** The extension↔daemon connection requires a token, so no other local process can silently drive your browser.
- **No debugger banner.** `browser_evaluate` runs in the page's MAIN world via `chrome.scripting` — no yellow "this tab is being debugged" banner. (The result is JSON-serialized inside the page and parsed back in the background to survive the MV3 structured-clone boundary — earlier versions returned `null` for every expression.)
- **Agent-control shield.** While an agent works on a tab you see a blue inner frame and your input on that tab is blocked (mouse, keyboard, wheel) — the frame shows the running tool's name and disappears when the action finishes. Locking a tab keeps a plain frame for the lock's lifetime.
- **Honest errors.** Every tool failure reaches your agent as a real `isError` result with the full payload — no more "success" responses hiding failures mid-workflow.
- **Recycle-proof locks.** Tab locks and smart-selector fallbacks survive Chrome's service-worker recycling (`chrome.storage.session`).

<p align="center">
  <img src="assets/preview.png" alt="Browser Controller" width="100%" />
</p>

---

## How it works

Three pieces, all on your machine. Nothing leaves localhost.

```
  Agent (Cursor / Claude / Windsurf)        ── other agents connect too ──┐
                  │ stdio (MCP protocol)                                   │
                  ▼                                                        ▼
  ┌─────────────────────────────┐   ┌─────────────────────────────────────────┐
  │  thin MCP client            │   │  thin MCP client                        │
  │  (npx browser-controller)   │   │  (npx browser-controller)               │
  │  - speaks MCP over stdio    │   │  - spawns daemon if not running         │
  │  - forwards calls to daemon │   │  - gets its own sessionId               │
  └──────────────┬──────────────┘   └────────────────────┬───────────────────┘
                 │ local IPC socket (AF_UNIX / named pipe, token-auth)     │
                 ▼                                                          ▼
  ┌──────────────────────────────────────────────────────────────────────────┐
  │  DAEMON (single long-running process, owns port 7225)                     │
  │  - multiplexes N clients → 1 extension                                    │
  │  - tags every call with the client's sessionId                            │
  │  - enforces per-tab mutex + tab-lock coordination                         │
  └──────────────────────────────┬───────────────────────────────────────────┘
                                 │ WebSocket ws://127.0.0.1:7225?token=…
                                 ▼
  ┌──────────────────────────────────────────────────────────────────────────┐
  │  Chrome Extension (Manifest V3 service worker)                            │
  │  - resolves the target tabId (never "the active tab" implicitly)          │
  │  - serializes same-tab actions, parallelizes cross-tab actions            │
  │  - executes click/type/snapshot/evaluate against the named tab            │
  └──────────────────────────────────────────────────────────────────────────┘
```

**Key idea:** the first time any agent runs, `npx browser-controller` spawns a background **daemon** that owns port 7225 and the extension connection. Every subsequent agent (even from a different MCP client) connects to that same daemon over a local IPC socket and gets its own `sessionId`. The extension sees one stable connection and routes each call to the exact tab the caller specified.

---

## Quick Start

Two parts: the **MCP server** (runs on your machine, talks to your AI agent) and the **Chrome extension** (sits in your browser, executes commands).

### 1. Add the MCP server

**Cursor (one click):**

[<img src="https://cursor.com/deeplink/mcp-install-dark.svg" alt="Install in Cursor" height="32" />](cursor://anysphere.cursor-deeplink/mcp/install?name=real-browser&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsImJyb3dzZXItY29udHJvbGxlciJdfQ==)

Or add manually in Cursor Settings > MCP > "Add new MCP server":

```json
{
  "mcpServers": {
    "real-browser": {
      "command": "npx",
      "args": ["-y", "browser-controller"]
    }
  }
}
```

<details>
<summary><b>Name your agent (shows in the popup)</b></summary>

By default the daemon names each connection after its parent IDE ("Cursor",
"Claude", …). To override — e.g. when several agents share one IDE, or to label
them by project — pass `--agent <name>` in the args. It takes priority over
every auto-detection:

```json
{
  "mcpServers": {
    "real-browser": {
      "command": "npx",
      "args": ["-y", "browser-controller", "--agent", "My Project Agent"]
    }
  }
}
```

The name appears in the popup's **Connected Agents** list. (You can also set the
`MCP_AGENT_NAME` env var — equivalent.) Reconnecting with the same name replaces
the old entry, so IDE restarts don't pile up duplicates.

</details>

<details>
<summary>Claude Desktop, Windsurf, or other MCP clients</summary>

**Claude Desktop:** Edit `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows). Add the same JSON block.

**Windsurf:** Settings > MCP. Same config.

**Multiple agents at once (v2):** just add the server in each client. They all share the one daemon automatically — no extra config.

```json
{
  "mcpServers": {
    "real-browser": { "command": "npx", "args": ["-y", "browser-controller"] }
  }
}
```

Any MCP-compatible client works.

</details>

### 2. Install the Chrome extension

[<img src="https://developer.chrome.com/static/docs/webstore/branding/image/iNEddTyWiMfLSwFD6qGq.png" alt="Available in the Chrome Web Store" height="58" />](https://chromewebstore.google.com/detail/real-browser-mcp/fkkimpklpgedomcheiojngaaaicmaidi)

**Or load from source:**

```bash
git clone https://github.com/compnew2006/browser-controller.git
```

1. Open `chrome://extensions` and enable **Developer mode** (toggle in the top right)
2. Click **Load unpacked** and select the `extension/` folder from the cloned repo

Click the Browser Controller icon in your toolbar.

Green dot = connected. Gray = waiting for the daemon.

### 3. Pair the extension with the daemon's auth token

The daemon generates a secret token on first run. The extension must present it to connect.

1. Run any browser command once (e.g. ask your agent to "list my browser tabs") — this starts the daemon and creates the token at `~/.browser-controller/token.json`.
2. Read it: `cat ~/.browser-controller/token.json` (on Windows: `%USERPROFILE%\.browser-controller\token.json`)
3. Click the extension icon → paste the token into the **Auth Token** field.

Green dot = you're connected. Your agent can now see your browser.

> The token prevents any other local process from opening a WebSocket and driving your authenticated browser sessions. It's optional in the sense that the daemon will still start without it being set in the extension, but the extension **won't connect** until it matches.

---

## How to use it (steps)

The v2 model is **tab-first**: the agent always says *which* tab to act on. It never assumes "the active tab."

### Basic workflow

1. **List tabs** to get a `tabId`:
   ```
   browser_tabs { action: "list" }
   → [{ id: 15, url: "...", title: "...", active: true, lockedBy: null }, ...]
   ```
2. **Snapshot that tab** to see its structure and get element refs:
   ```
   browser_snapshot { tabId: 15 }
   → { tree: [ { ref: "e3", role: "button", name: "Sign in" }, ... ] }
   ```
   Refs are valid **only for this tabId**. If you navigate or the DOM changes, re-snapshot. New elements since the last snapshot are tagged **`isNew: true`** — after an action opens an overlay/dropdown, the agent can focus on just those instead of re-reading the whole tree.
3. **Interact** using the ref and the same tabId:
   ```
   browser_click { tabId: 15, ref: "e3" }
   browser_type  { tabId: 15, ref: "e5", text: "hello@example.com" }
   browser_press_key { tabId: 15, key: "Enter" }
   ```
   If a ref is stale but the element still exists, it's found automatically via a robust selector + text/role scan (response carries `via: "fallback"`). If the element was scrolled away entirely (virtualized feeds), the response carries **`freshRefs: [...]`** with a fresh snapshot inline — retry with one of those new refs in the same step, no separate snapshot needed.
4. **Verify** — snapshot or read text again after the action.

### Multi-agent coordination (two agents, two tabs)

1. Agent A lists tabs, picks tab 10, optionally locks it: `browser_tabs { action: "lock", tabId: 10 }`
2. Agent B lists tabs, picks tab 11, locks it: `browser_tabs { action: "lock", tabId: 11 }`
3. Both work in parallel. Each agent's calls serialize against its own tab; the two tabs never interfere.
4. When done: `browser_tabs { action: "unlock", tabId: 10 }`.

The popup is your control panel for all of this:
- **Open Tabs** — every open tab with a per-tab dropdown to pin it to a specific agent, or unpin it.
- **Connected Agents** — each connected agent with its name, session id, uptime, and a ✕ to disconnect it immediately (clears a zombie that the heartbeat hasn't reaped yet).
- **Tab Locks** + **Unlock All** — the current lock map, with a one-click release if an agent crashed mid-lock.

### Things to know

- **Forgot `tabId`?** You'll get a clear error: `tabId is required. Call browser_tabs list first.`
- **Protected pages** (`chrome://`, the Web Store, devtools) can't be scripted — you'll get `Cannot access protected page (chrome://...)` instead of a silent hang.
- **`browser_navigate`** is the one tool where `tabId` is optional (defaults to the active tab) — but for multi-agent safety, pass it explicitly. **Hash-only changes** (e.g. `/page` → `/page#section`) resolve as soon as the URL is set, without waiting for a `complete` event (SPAs don't reload on hash change, so that event never fires).
- **`browser_evaluate`** runs in the page's MAIN world (no debugger banner, CSP-safe) and returns real values (JSON-serialized across the world boundary). It's powerful but **non-idempotent** — it won't be auto-retried on timeout.
- **Scrolling virtualized feeds** (Facebook/Instagram/Twitter): `browser_scroll` returns `refsMayBeStale: true` because those sites recycle DOM nodes. Re-snapshot before your next interaction.
- **Duplicate elements**: when several elements share text+role (e.g. 3 "Like" buttons), the fallback resolver picks the correct one by ordinal (`nth`), not just the first match.

---

## 🧠 Teach Your Agent

The agent can use all 22 tools out of the box, but it works better when it knows the **tab-first** workflow. Run one command to install the rules:

```bash
npx browser-controller --setup cursor
```

This installs:
- `~/.cursor/rules/browser-controller.mdc` — the tab-targeting workflow, dropdown handling, when to lock tabs
- `~/.cursor/commands/check-browser.md` — adds `/check-browser` to your Cursor chat

After that, type `/check-browser` in any chat. Or just say "check the result in my browser" and the agent knows what to do.

<details>
<summary>Claude Code setup</summary>

```bash
npx browser-controller --setup claude
```

Adds an `AGENTS.md` to your project root. Claude Code auto-discovers it.

</details>

See [`agent-config/`](agent-config/) for manual installation or to customize the rules.

---

## What It Can Do

22 tools. Every page-interaction tool takes a **`tabId`** (the one exception is `browser_navigate`, where it's optional).

**See**

| Tool | What it does |
|------|-------------|
| `browser_snapshot` | Accessibility tree with element refs. Compact mode (default) returns only interactive elements. Traverses shadow DOM + iframes. |
| `browser_screenshot` | Capture a tab as an image (activates the tab first to capture) |
| `browser_text` | Extract raw text from page or element |
| `browser_find` | Query elements by natural language |

**Interact**

| Tool | What it does |
|------|-------------|
| `browser_click` | Click by ref or CSS selector |
| `browser_click_text` | Click by visible text. Works through React portals and overlays |
| `browser_type` | Type into inputs and contenteditable fields |
| `browser_press_key` | Key combos (Enter, Escape, Ctrl+A) |
| `browser_scroll` | Scroll pages and virtual containers |
| `browser_hover` | Trigger tooltips and dropdowns |
| `browser_select` | Pick from native `<select>` dropdowns |
| `browser_wait` | Wait for elements to appear or disappear |
| `browser_fill_form` | Fill multiple form fields in one call |
| `browser_drag` | Drag element-to-element (uses CDP for reliability) |
| `browser_upload_file` | Upload files through `<input type="file">` (uses CDP) |

**Navigate**

| Tool | What it does |
|------|-------------|
| `browser_navigate` | Go to a URL in a tab (`tabId` optional, defaults to active) |
| `browser_tabs` | List / create / close / focus / **lock** / **unlock** tabs |

**Debug & Advanced**

| Tool | What it does |
|------|-------------|
| `browser_console` | Console output (log, warn, error) — per-tab, capped at 200 entries |
| `browser_network` | XHR/fetch requests with status codes — per-tab |
| `browser_evaluate` | Run JavaScript in the page's MAIN world (no banner, CSP-safe) |
| `browser_handle_dialog` | Handle alert/confirm/prompt dialogs |
| `browser_run_action` | Run a self-contained JS action object via CDP |

---

## How Others Compare

| | Browser Controller | Playwright MCP | Chrome DevTools MCP |
|---|---|---|---|
| Uses your existing browser | Yes | No, launches new | Partial, needs debug port |
| Sessions and cookies | Already there | Fresh profile | Manual setup |
| Works behind corporate SSO | Yes | No | Depends |
| Multiple agents, multiple tabs | Yes (v2) | No | No |
| Tab-targeting (won't hijack active tab) | Yes (v2) | N/A | No |
| Authenticated local connection | Yes (v2) | N/A | No |
| Setup | Extension + MCP config | Headless browser | Chrome with `--remote-debugging-port` |

---

## Configuration

| Env var | Default | What it does |
|---------|---------|-------------|
| `WS_PORT` | `7225` | WebSocket port the daemon uses for the extension connection |
| `BROWSER_CONTROLLER_PROGRESSIVE` | (unset) | Set to `1` to enable progressive tool disclosure: only the `browser_tools` meta tool is visible at startup (~150 tokens instead of ~4200 for all 22 definitions). The agent discovers tools via `browser_tools {action:"list"/"search"}` and activates them with `{action:"details", tool:"…"}`. Default (unset) shows all tools upfront — safe for agents whose instructions call tools directly. |

### Daemon state files

The daemon keeps everything in `~/.browser-controller/` (Windows: `%USERPROFILE%\.browser-controller\`):

| File | Purpose |
|------|---------|
| `token.json` | Auth token the extension must present (mode `0600`) |
| `daemon.sock` | The IPC socket thin clients connect to (AF_UNIX on mac/linux; named pipe on Windows) |
| `daemon.json` | Daemon metadata (pid, port, start time) — used to detect a running daemon |
| `daemon.log` | Daemon stdout/stderr when spawned by a client |

To fully reset: stop your MCP clients, delete the folder, and the next run recreates it with a fresh token.

### Reliability

- The daemon is **auto-spawned** the first time any client runs and left running detached.
- Connection drops use exponential backoff (1s → 30s), ping/pong health checks every 10s.
- Per-tool timeouts (10s for clicks, 60s for navigation), co-located with each tool's definition so they can't drift from the registry.
- **Idempotent read tools** (snapshot, screenshot, text, find) are retried on timeout; **side-effecting tools** (click, type, navigate, evaluate) — and `console`/`network` (which mutate on `clear:true`) — are **never** retried, so a click can't fire twice.
- If another process already holds port 7225, the daemon refuses to start rather than killing a process it didn't spawn — it reports the conflict (and whether the owner is an authenticated daemon) so you can resolve it deliberately.

<details>
<summary>Multiple Chrome profiles</summary>

Run two daemons on different ports by setting `WS_PORT` per client:

```json
{
  "mcpServers": {
    "browser-work": {
      "command": "npx", "args": ["-y", "browser-controller"]
    },
    "browser-personal": {
      "command": "npx", "args": ["-y", "browser-controller"],
      "env": { "WS_PORT": "9333" }
    }
  }
}
```

Update the port in each extension popup to match.

</details>

---

<details>
<summary><strong>Architecture</strong></summary>

Everything stays on your machine. The extension connects to the daemon via an authenticated WebSocket on localhost; MCP clients connect to the daemon via a local IPC socket. No cloud, no proxy, nothing leaves your browser.

```
browser-controller/
├── mcp-server/          MCP server (npm package, TypeScript)
│   └── src/
│       ├── daemon.ts        Single multi-client daemon (owns WS :7225)
│       ├── daemon-config.ts IPC protocol, paths, auth/enrollment tokens
│       ├── index.ts         Thin stdio MCP client (spawns daemon, multiplexes)
│       ├── bridge.ts        Extension WS server + cross-platform port probe
│       └── tools/           One file per tool (22), registry pattern
├── extension/           Chrome extension (Manifest V3, plain JS, ES modules)
│   ├── background.js        Wiring only (~30 lines): inject router, register events, connect
│   ├── lib/                 state (buffers/locks/persistence), connection (WS lifecycle),
│   │                        router (dispatch + mutex/locks + control shield), page-exec,
│   │                        overlay, lock-ops, tab-concurrency (pure, unit-tested)
│   ├── handlers/            Tool implementations: navigation, interaction, inspection, tabs, cdp
│   ├── events.js            chrome.* listeners (console capture, popup, webRequest, lifecycle)
│   ├── content.js          Console capture
│   └── popup/              Fixed tabbed shell (Tabs · Agents · Settings) + collapsible activity bar
├── agent-config/        Pre-built configs for Cursor + Claude Code
│   ├── cursor/              Rules and commands
│   ├── skills/              Browser automation skill
│   └── setup.mjs            One-command installer
└── tests/               Bridge + registry + concurrency + daemon tests
```

**Stack:** TypeScript (strict) · MCP SDK · WebSocket · Chrome Extension Manifest V3 · Vitest

</details>

<details>
<summary><strong>Development</strong></summary>

```bash
git clone https://github.com/compnew2006/browser-controller.git
cd browser-controller
npm install
npm run build
npm test
```

| Command | What it does |
|---------|---------|
| `npm run build` | Compile TypeScript → `mcp-server/dist/` |
| `npm run dev` | Watch mode |
| `npm test` | Run the full test suite (bridge, registry, daemon lifecycle, concurrency) |
| `npm run typecheck` | Type check without emitting |
| `npm run setup:cursor` | Install Cursor rule + command |

The test suite covers the WebSocket bridge (including token-auth rejection), the tool registry, and the per-tab concurrency primitives (same-tab serialization + cross-tab parallelism). The daemon's IPC auth and the WS token enforcement are also smoke-tested via the build artifacts in `mcp-server/dist/`.

</details>

## FAQ

<details>
<summary>Does it work with my logged-in sessions?</summary>

That's the whole point. The extension runs inside your actual Chrome — same cookies, same sessions, same local storage. No re-authentication needed.

</details>

<details>
<summary>Does it send data anywhere?</summary>

No. The MCP clients, the daemon, and the extension all talk over localhost (IPC socket + WebSocket). Nothing leaves your machine. There's no analytics, no telemetry, no cloud component. See [SECURITY.md](SECURITY.md) for the threat model, auth design, and the first-contact TOFU window.

</details>

<details>
<summary>Which AI clients work?</summary>

Any MCP-compatible client. Cursor, Claude Desktop, Claude Code, Windsurf, Cline, and anything else that speaks the MCP protocol. v2 lets several of them run at once against the same daemon.

</details>

<details>
<summary>Can two agents really work at the same time without breaking each other?</summary>

Yes — that's the main v2 improvement. Each agent connects to the shared daemon, gets its own `sessionId`, and targets a specific `tabId`. Actions on the same tab serialize through a per-tab mutex; actions on different tabs run in parallel. Optionally an agent can `lock` a tab to claim exclusive access; other agents queue behind the lock rather than failing.

</details>

<details>
<summary>What if the agent acts on the wrong tab?</summary>

It can't — not silently. Every page-interaction tool requires a `tabId`, and if it's missing you get a clear `tabId is required` error. The agent can never accidentally act on the tab you happen to be looking at. (The one exception is `browser_navigate` without a `tabId`, which uses the active tab — but for multi-agent use you should always pass `tabId`.)

</details>

<details>
<summary>Why is there an auth token?</summary>

Without it, any local process on your machine could open a WebSocket to port 7225 and drive your authenticated browser sessions (your bank, your email, your company SSO). The daemon generates a secret token in `~/.browser-controller/token.json` and the extension must present it to connect.

</details>

<details>
<summary>How is this different from Playwright MCP or browser-use?</summary>

They launch a new browser instance from scratch — no state, no cookies, no sessions. You have to replay the full login flow every time. This connects to the browser you already have open with everything already loaded.

</details>

---

## Contributing

Bug reports, feature requests, and PRs welcome. Open an issue first for larger changes.

## Author

**noiemany** — [GitHub](https://github.com/noiemany)

## License

[MIT](LICENSE) &copy; noiemany
