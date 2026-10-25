# Inventory — Scripts and agent configuration

Operator scripts (daemon lifecycle, pairing, smoke harnesses) and the MCP client config installers.

Symbols: **73** across **6** files.

Evidence column: `D` = purpose taken from the doc comment in the source; `R` = purpose written after reading the body; `B` = no doc comment, the quoted line is the whole body; `N` = no doc comment and a multi-statement body, so the purpose is derived from the identifier only (shown with `~`) — treat those as a label, not a verified description.

## agent-config/setup.mjs

84 lines · 4 symbols · 0 exported · fan-in 0 · fan-out 0

| line | kind | symbol | purpose | ev |
|---:|---|---|---|---|
| 21 | function | ensureDir | ~ ensures dir | N |
| 28 | function | copyIfNeeded | ~ copy if needed | N |
| 36 | function | installCursor | ~ install cursor | N |
| 59 | function | installClaude | ~ install claude | N |

## scripts/daemon.mjs

133 lines · 12 symbols · 0 exported · fan-in 0 · fan-out 0

| line | kind | symbol | purpose | ev |
|---:|---|---|---|---|
| 20 | const-function | sleep | ~ sleep | N |
| 22 | function | readInfo | `try { return JSON.parse(fs.readFileSync(infoFile, 'utf8')); } catch { return nu...` | B |
| 25 | function | pidAlive | `if (!pid) return false;` | B |
| 29 | function | enrollmentSecret | `try { return JSON.parse(fs.readFileSync(path.join(stateDir, 'enrollment.json'),...` | B |
| 33 | function | daemonStatus | GET /status from the daemon's HTTP port (enrollment-gated); null when nothing answers. | D |
| 47 | function | ipcAnswers | Does a Browser Controller daemon answer on the IPC socket? (Any protocol frame back proves it.) | D |
| 51 | const-function | finish | ~ finish | N |
| 73 | function | live (async) | Is the pid in daemon.JSON really the daemon? A live pid alone is not proof (pids are reused; the file … | D |
| 79 | function | waitForStart (async) | ~ waits for for start | N |
| 88 | function | staleNote | `return info?.pid && pidAlive(info.pid)` | B |
| 93 | function | start (async) | ~ start | N |
| 110 | function | stop (async) | ~ stop | N |

## scripts/pairing.mjs

296 lines · 12 symbols · 7 exported · fan-in 2 · fan-out 0

| line | kind | symbol | purpose | ev |
|---:|---|---|---|---|
| 62 | function | unpackedExtensionId (exp) | Chrome's ID for an extension loaded unpacked from `dir` (pass the real path): the first 128 bits of SHA-256 over … | D |
| 75 | function | browserTargets (exp) | Where each installed browser looks for user-level native messaging hosts. | D |
| 91 | const-function | shellQuote | ~ shell quote | N |
| 98 | function | wrapperScript (exp) | The executable Chrome starts. It pins the absolute node path: a browser started from the Dock/Start menu does not see … | D |
| 117 | function | hostManifest (exp) | ~ host manifest | N |
| 127 | function | paths | ~ paths | N |
| 137 | const-function | runReg | ~ runs reg | N |
| 139 | function | install (exp) | ~ install | N |
| 181 | function | uninstall (exp) | ~ uninstall | N |
| 202 | function | status (exp) | What is registered where. Never reads out the secret itself. | D |
| 229 | function | parseArgs | ~ parses args | N |
| 244 | function | main | ~ main | N |

## scripts/smoke-real-chrome.mjs

234 lines · 19 symbols · 0 exported · fan-in 0 · fan-out 0

| line | kind | symbol | purpose | ev |
|---:|---|---|---|---|
| 28 | const-function | sleep | ~ sleep | N |
| 38 | const-function | log | ~ log | N |
| 42 | function | textOf | 3.0 results: the extension's `text` is the agent-facing text (plain lines, not JSON). | D |
| 47 | function | refsIn | Refs of the snapshot lines with this role, e.g. `button "Click me" [e3]`. | D |
| 53 | function | assert | ~ assert | N |
| 54 | function | daemonAlive | ~ daemon alive | N |
| 61 | function | startDaemon | ~ starts daemon | N |
| 69 | function | waitForDaemon (async) | `for (let i = 0; i < 300; i++) { if (await daemonAlive()) return; await sleep(10...` | B |
| 73 | function | stopDaemon (async) | ~ stops daemon | N |
| 77 | object-function | kill | ~ kill | N |
| 77 | object-function | once | ~ once | N |
| 86 | function | call (async) | ~ call | N |
| 88 | function | hasManagedDaemon (async) | ~ tests whether there is managed daemon | N |
| 97 | function | restartManagedDaemon (async) | `await execFileAsync('systemctl', ['--user', 'restart', SYSTEMD_SERVICE], { env:...` | B |
| 102 | function | startManagedDaemon (async) | `await execFileAsync('systemctl', ['--user', 'start', SYSTEMD_SERVICE], { env: u...` | B |
| 115 | function | connect (async) | ~ connect | N |
| 141 | object-function | call | ~ call | N |
| 149 | object-function | close | ~ close | N |
| 153 | function | main (async) | ~ main | N |

## scripts/smoke-vault-isolated.mjs

568 lines · 21 symbols · 0 exported · fan-in 0 · fan-out 0

| line | kind | symbol | purpose | ev |
|---:|---|---|---|---|
| 20 | const-function | sleep | ~ sleep | N |
| 21 | const-function | ensure | ~ ensure | N |
| 24 | function | scrubDiagnostic | `let text = String(value);` | B |
| 30 | function | playwrightApi (async) | ~ playwright API | N |
| 38 | function | freePort (async) | ~ free port | N |
| 46 | function | waitForDaemon (async) | ~ waits for for daemon | N |
| 62 | function | waitForEnrollment (async) | ~ waits for for enrollment | N |
| 73 | function | startFixture (async) | ~ starts fixture | N |
| 87 | function | resultText | `return (result?.content \|\| []).filter((item) => item.type === 'text').map((item...` | B |
| 91 | function | parseSuccess | ~ parses success | N |
| 101 | function | scanFilesFor (async) | ~ scan files for | N |
| 119 | function | locatePrivateVaultPage (async) | ~ locate private vault page | N |
| 130 | function | privateRpc (async) | `return page.evaluate((request) => new Promise((resolve) => {` | B |
| 136 | function | focusByKeyboard (async) | ~ focus by keyboard | N |
| 137 | const-function | matches | ~ matches | N |
| 154 | function | activateButtonByKeyboard (async) | `await focusByKeyboard(page, { buttonText, ...options });` | B |
| 159 | function | latencySummary | ~ latency summary | N |
| 169 | function | main (async, cx45) | ~ main | N |
| 264 | const-function | call (async) | `const result = await client.callTool({ name, arguments: args });` | B |
| 358 | const-function | callSecond (async) | `const result = await secondClient.callTool({ name, arguments: args });` | B |
| 459 | const-function | walk (async) | ~ walk | N |

## scripts/test-google-search.mjs

144 lines · 5 symbols · 0 exported · fan-in 0 · fan-out 0

| line | kind | symbol | purpose | ev |
|---:|---|---|---|---|
| 19 | const-function | log | ~ log | N |
| 55 | const-function | call | ~ call | N |
| 61 | const-function | sleep | ~ sleep | N |
| 62 | const-function | est | ~ est | N |
| 66 | function | step (async) | ~ step | N |
