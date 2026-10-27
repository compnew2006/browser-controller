# Research: shared website memory

**Feature**: [spec.md](spec.md) · **Plan**: [plan.md](plan.md) · **Date**: 2026-10-27

Sources are this repository at `8777e78` (plus the uncommitted Spec Kit files), read through codebase-memory, graphify and the source itself. No external service was contacted: the Mnemon facts below come from [implementation-outline.md](implementation-outline.md) and remain unverified until an authorized prototype checks them against a pinned version.

Baseline facts used by the decisions:

- `mcp-server/src/daemon.ts` `routeCall` sends every IPC tool call through `routeVaultAwareCall` (`mcp-server/src/vault/daemon-routing.ts`). That function pins the profile (`pinBrowserId`), checks vault permissions, calls the bridge and sanitizes the result. Graphify: its only caller is `Daemon.routeCall`.
- `browser_batch` runs in the MCP process (`mcp-server/src/tools/batch.ts`); each step is a separate IPC call. The batch answers with its last step and carries earlier steps' notes.
- `outcomeOf` (`mcp-server/src/tools/types.ts`) shows `text` to the agent and keeps other fields as machine data (`rawResultOf`). It is shared by all forwarded tools (graphify `affected outcomeOf`: 17 tool modules).
- Profile identity: the extension creates `bcBrowserId` once in `chrome.storage.local` (`extension/lib/connection.js`), and the daemon-authenticated helloAck carries it (`extension/lib/daemon-auth.js`, `identityOf` in `mcp-server/src/bridge-connections.ts`). An extension that sends none is `default`. Incognito tabs of a spanning extension share the same id, so incognito state must be read per tab.
- `browser_navigate` returns the final URL after redirects and `incognito: true` only for private tabs (`extension/handlers/navigation.js`). `snapshot: true` inlines a snapshot. Snapshot lines carry role and accessible name; links carry no `href`.
- Network capture's `onSendHeaders` does not use `extraHeaders`, so it never sees `Cookie` or `Authorization` (`extension/events.js`, `extension/lib/network-capture.js`).
- The manifest has `tabs, scripting, debugger, webRequest, webNavigation, storage, alarms, nativeMessaging` and `<all_urls>`. It does not have `cookies`.
- Vault protection is per profile scope: protected documents per tab, plus an "unknown" state after recovery problems (`mcp-server/src/vault/service-protection.ts`).
- `CredentialVaultStore` writes atomically (temp + fsync + rename + directory fsync). Its owner-mode check (`(mode & 0o077) !== 0`, `mcp-server/src/vault/store.ts:49`) is what breaks the vault on Windows, an open issue.

## R-01 Storage engine

- **Decision**: A dependency-free JSON record store owned by the daemon: `policy.json` plus one file per origin, atomically replaced. It sits behind a `MemoryStore` interface.
- **Rationale**: Every read is keyed by `(origin, profile)` and returns a bounded list. Every write touches one origin. No requirement needs full-text or semantic search, because values come from fixed lexicons (R-08). The store adds no install, no native build for Node 20/22 or Windows, and no supply-chain review. Startup stays lazy, because only the policy is read at start.
- **Alternatives considered**:
  - **Mnemon** as a daemon-owned child process over stdio: its entry point starts an MCP server and opens its database, and its SQLite driver is native and synchronous (per the outline, unverified). That means a second process lifecycle, a native module on every supported platform, and a free-text memory model that does not fit allowlisted structured facts. The outline also forbids importing its entry point. Per the 2026-10-27 clarification (FR-013), Mnemon is kept in scope as an optional experiment, not deferred indefinitely: a `mcp-server/src/memory/mnemon-store.ts` adapter implements the same `MemoryStore` interface and is selected only via `BC_MEMORY_STORE=mnemon`, gated on separate owner authorization (tasks.md Phase 7). It must pass every existing suite before the owner compares it against the default store on the R-18 workload; the feature works without it either way.
  - `node:sqlite`: not available on Node 20, which CI supports.
  - `better-sqlite3` directly: a new native dependency that needs installation and an ADR. It is not needed at this scale.
  - A single JSON file for everything: every write would rewrite all origins, and one corrupt file would lose all memory.

## R-02 Process boundary

- **Decision**: An in-process module in the daemon (`mcp-server/src/memory/`) with one writer.
- **Rationale**: The daemon is already the single authority, guarded by the daemon lock, for sessions, profiles and vault state. One writer removes cross-process locking. Memory work is a small amount of JSON I/O off the call path.
- **Alternatives considered**: A child process adds IPC, crash and restart handling, and a new failure mode for no isolation benefit, since it reads the same trusted data. An MCP-process store runs once per agent, so it cannot share across agents without a second coordinator.

## R-03 Write model and durability

- **Decision**: Captures go into a bounded in-memory queue (256 operations) drained by one writer. Each commit re-reads the policy, applies exclusion and deletion tombstones, reconciles the origin record, and replaces the file atomically (temp → fsync → rename → directory fsync). A commit counts only after the rename. Reads see only committed state; the cache is updated after the rename.
- **Rationale**: Browser results never wait on disk (AC-16). The queue is not durable, and the docs say so: an operation lost to a crash was never committed and is never reported as committed (AC-18, outline step 6). The commit-time policy check satisfies "including queued work" (AC-11).
- **Overload**: When the queue is full the new operation is dropped (`MEMORY_QUEUE_FULL` counter). A commit over 2 s is abandoned and its temp file removed (`MEMORY_UNAVAILABLE`). Neither affects the browser call.
- **Windows**: The win32 path skips the POSIX mode-bit assertion; that is the vault's `store.ts:49` lesson. It retries `rename` up to 3 times on `EPERM`/`EBUSY`/`EACCES` with 50 ms back-off, for antivirus and indexer locks. POSIX files are created `0o600` in a `0o700` directory.
- **Alternatives considered**: Awaiting the write before returning the result breaks AC-16 under slow disks. An append-only journal is more durable but needs compaction and recovery for little gain; it can be revisited if baselines show write amplification.

## R-04 Profile identity

- **Decision**: The profile is the `browserId` of the authenticated extension connection that served the call. Capture and retrieval need all of the following:
  - the id is not `default`;
  - exactly one live connection carries that id, matching vault's `hasUniqueIdentity`;
  - the `connectionId` is the same before and after the call (`VaultBridgeTransport.getBrowserContext`);
  - the extension advertises capability `site-context`.

  Otherwise the call is `MEMORY_SCOPE_UNKNOWN`: no capture, and no reminder.
- **Rationale**: The id is set by the extension, carried in the signed helloAck, and never taken from agent parameters or labels (FR-005, AC-08). The before/after check covers a profile switch or reconnect during the call (edge case: profile selection changes).
- **Alternatives considered**: The browser label is user-editable and shown to agents, so it is not an identity. A hash of the Chrome profile path is not available to MV3 extensions.

## R-05 Origin and privacy state

- **Decision**: Origin, incognito state and top-level document come from `siteContext`. The extension computes it ([contracts/site-context.schema.json](contracts/site-context.schema.json)) when the daemon sets `observe: true` on the request, for `browser_navigate` and `browser_snapshot` only. The origin is scheme, host and effective port (`URL.origin`), for `http:`/`https:` only. The extension takes the tab URL before and after the handler; if they differ (redirect after the read, SPA route change, tab closed), it reports `anonymous: null`, and for navigate the daemon also needs `siteContext.url` to equal the result's `url`. The daemon removes `siteContext` from the result before sanitizing and returning it.
- **Rationale**: Caller parameters can name any URL; only the browser knows where the tab landed and whether it is private (AC-07, AC-09). The pre/post check stops a fact being attributed to the wrong document.
- **Alternatives considered**: Parsing the `url:` line of the result text cannot show incognito state on old extensions. A separate context call costs a round trip and can race a navigation.

## R-06 Vault and protected contexts

- **Decision**: A new read-only `memoryEligibility(browserId, tabId)` on vault protection returns `clear`, `protected` or `unknown`. There is no capture and no reminder when the profile scope is in `protectionUnknownScopes` or has any protected document. The daemon also skips capture when sanitizing changed the result: it compares a digest taken before and after sanitizing.
- **Rationale**: Fail closed on any vault doubt (AC-09). Profile-wide suppression is coarse but simple and safe, because protected documents are short-lived.

## R-07 Public-status verification (no extra visits)

- **Decision**: A page counts as *verified public* only when the extension reports `anonymous: true` for the read. That needs all of the following at read time:
  1. A normal (non-incognito) tab with a top-level `http(s)` document whose URL has no userinfo, query or fragment.
  2. Every cookie that applies to the URL in the tab's cookie store (`chrome.cookies.getAll({url, storeId})`, HttpOnly included) has a name on the reviewed consent/analytics allowlist.
  3. Every `localStorage` and `sessionStorage` key name is on the same allowlist.
  4. `indexedDB.databases()` resolves to an empty list.
  5. The pre/post URL check passed (R-05).

  Only names are compared, and values are never read into the result. The verdict is a boolean plus a reason code. Any failed or unavailable step gives `false` or `null`, which means *unverified*. This needs the `cookies` permission (owner gate 2). Without it, `anonymous` is always `null` and only visit observations are recorded.
- **Rationale**: Personalized content needs a credential. With no auth-bearing cookie, no web storage token and no IndexedDB store, the standard credential channels are absent, so the rendered page is what an anonymous visitor sees. Each step is checked locally without loading anything (FR-006). The rule is conservative: many sites fail it, and that is the specified behavior (AC-22).
- **Residual risk** (for the owner and SECURITY.md): HTTP authentication, client certificates, IP- or network-based personalization, and tokens carried in a URL path are not detected. Together with R-08, any fact stored from such a page can still only hold lexicon values.
- **Alternatives considered**:
  - CDP `Network.getCookies`: it needs a debugger attach, and a banner, on every read.
  - webRequest with `extraHeaders`: it slows every request and still misses JS-held tokens.
  - Fetching the page again without credentials: an unrequested visit, which is forbidden.
  - An owner per-site "public" flag: it contradicts the clarified one-time global enable.
  - Response `Cache-Control: public`: it covers the document only, not data the page fetched after load.

## R-08 Fact safety

- **Decision**: A fact value can only come from fixed data in [contracts/fact-allowlist.json](contracts/fact-allowlist.json): ARIA roles, an English and Arabic phrase lexicon matched exactly after normalization (NFKC, lower case, whitespace collapsed, trailing punctuation trimmed), path segments, and BCP 47 primary language tags. Free text is never stored.
- **Rationale**: Deterministic code cannot verify that arbitrary page text is non-personal and safe. Under the spec's own rule ("do not save a fact when its … safety cannot be verified"), such text is never saved. Lexicon-only values cannot carry personal data or injected instructions (AC-10, AC-14).
- **Fact kinds** (v1):
  - `site.language`: language and direction.
  - `ui.search`: a search field with a lexicon name.
  - `ui.login`: a password field is present, with the page path if every segment is in the path lexicon, else `null`. Snapshots do not mark password inputs, so `siteContext.passwordField` provides the structural flag (no value, name or label).
  - `ui.control`: role plus lexicon name, for example `button "Accept all"` or `link "Sign in"`.
- **Alternatives considered**:
  - Page titles and meta descriptions: these can contain names or account details.
  - schema.org JSON-LD: not part of what the snapshot read returns, and its text fields are free-form.

## R-09 Reading of AC-22 and AC-30

- **Decision**: No page-derived detail is persisted from a page that is not verified public, not even in the observing profile. Only the visit observation is kept.
- **Rationale**: AC-22 forbids persisting page-content facts when public status is unverified. Navigation and interface details from a snapshot are page content. AC-30 then holds by construction. This is the more conservative reading; owner gate 1 confirms it.

## R-10 Fact identity and reconciliation

- **Decision**: Identity keys are `site.language`, `ui.search`, `ui.login` and `ui.control:<role>:<normalized name>`.
  - Same identity, same value: refresh `lastObserved` and the observing profile's verification.
  - Same identity, new value: the new value becomes current with fresh provenance; the old value is dropped, with no history in v1.
  - Facts never expire by time (AC-23).
  - Equal-time ties between concurrent writers resolve by commit order, the order of the single writer.
- **Rationale**: These rules cover AC-03, AC-17, AC-19, AC-23 and AC-24 with the least data kept. Keeping no history also means fewer records to delete.

## R-11 Cross-profile output and provenance

- **Decision**:
  - Within the observing profile: `verified <UTC minute>`, the source tool and the page path.
  - Other profiles: origin and `observed <YYYY-MM>` only, marked `not verified in this profile`, until that profile verifies the fact itself.
  - Visit observations are never shown to another profile.
- **Rationale**: AC-31 forbids the other profile's identity, visit history, page path and exact time. Month granularity keeps freshness useful.

## R-12 Retrieval surfaces

- **Decision**:
  - **Reminder**: after a successful `browser_navigate` in scope, with memory enabled, the origin not excluded and the vault clear, the daemon appends a labeled block of at most 8 lines and 600 characters to `text`. It also adds the lines as a `memory` array field. `browser_batch` copies the `memory` lines of every step but the last into its notes, as `step i/n browser_navigate: memory: …`; the last step's text already shows them (AC-27).
  - **Tool**: the daemon-owned tool `browser_memory {tabId, kind?, cursor?}` resolves the origin from the tab through the internal action `browser_memory_internal_context`. That action is routed to the extension, so tab locks apply (AC-12). The tool returns up to 50 items and 4,000 characters per page.
- **Rationale**: Binding the tool to the tab means an agent can only ask about the site it works on (AC-26). Putting the reminder in `text` needs no change to each tool formatter (graphify: `outcomeOf` is shared).
- **Wording rule**: Text for the agent never tells it how to enable memory or change policy, and never urges it to do so. For example `MEMORY_DISABLED` says "the owner controls it", so a page cannot steer an agent into changing policy. Per the 2026-10-27 clarification (FR-004, AC-32), agent-facing text MAY name the dedicated tool `browser_memory_policy` as the mechanism for requesting a change, but it never suggests making or repeating a request, and it never claims a request will take effect without the owner's confirmation.

## R-13 Owner controls

- **Decision**: Two channels change policy, both ending in the same `MemoryService.admin` call so there is one code path:
  - **Owner CLI**: `npm run memory -- <command>` (`scripts/memory.mjs`), talks to the running daemon with a new IPC message kind `memory-admin` after the usual token hello ([contracts/memory-admin-ipc.schema.json](contracts/memory-admin-ipc.schema.json)). The commands are `status`, `enable`, `disable`, `exclude <origin>`, `include <origin>`, `inspect <origin>`, `export`, `delete <origin>` and `delete --all`. If the daemon is not running, the CLI says so and changes nothing.
  - **Agent-requested, owner-confirmed**: per the 2026-10-27 clarification (FR-004, AC-32), the MCP tool `browser_memory_policy` lets an agent request `enable`, `disable`, `exclude`, `include`, `inspect`, `export` or `delete`. The MCP server process asks the owner through MCP form elicitation (the `registerTools` confirmation path in `mcp-server/src/register-tools.ts`), built only from the action and the canonical origin — never agent or page text. Only a confirmation the owner gave sets an internal `ownerConfirmed` field before the daemon call; a value supplied by the agent is dropped (mirrors `expectFingerprints` in `tools/action-support.ts`). When the client cannot elicit, or the owner declines or does not answer, the request fails (`CLIENT_CONFIRMATION_UNAVAILABLE` or `ACTION_NOT_CONFIRMED`) and nothing changes.
- **Rationale**: One writer, so no file races. The owner is always the one who makes a policy change effective, whether they type the CLI command themselves or confirm an agent's request in their own client. A popup UI would need an Impeccable design pass and more surface; it can come later.
- **Residual risk**: An agent with shell access can run the CLI or edit files as the same OS user. An agent can also now ask the owner to change policy on every call, which risks approval fatigue; this is tracked as analyze finding A1 and is not yet rate-limited beyond the daemon's existing per-session call limit. Both risks go into SECURITY.md.

## R-14 Retries and operation identity

- **Decision**: The operation id is `daemonCallId`, unique per daemon call. The bridge's own read retries happen inside one daemon call, so they produce one capture. A bounded LRU of 1,024 committed operation ids drops duplicates. Identity reconciliation (R-10) makes any repeat a freshness update. Click, type and other non-idempotent retries are unchanged (AC-19).

## R-15 Failure isolation

- **Decision**:
  - All memory work runs after the browser outcome is final, inside `try/catch`.
  - The reminder lookup reads the in-memory cache, or loads one origin file within a 50 ms budget.
  - On failure, navigate keeps its result and gets `memory: unavailable (<CODE>)` without page detail (AC-16).
  - A corrupt origin file is renamed `<name>.corrupt-<ts>` and reported in `status`; that origin starts empty.
  - Old extensions, without `site-context`, give no capture and no reminder, and the result is unchanged.

## R-16 Local only

- **Decision**: The memory module imports no network API. AC-20 is tested with a network sink that wraps `net.connect`, `http(s).request`, `fetch` and `dns.lookup` in the test process and fails on any non-loopback target during capture, search, export and recovery.

## R-17 Deletion and backups

- **Decision**: `delete <origin>` removes the origin file and records a tombstone `{origin: deletedAt}` in `policy.json`. Operations queued before the tombstone are dropped at commit. `delete --all` sets one global tombstone time. Tombstones are pruned when no operation older than them can still be queued, after one queue drain. The store keeps no backups. No secure-erasure claim is made (AC-11).

## R-18 Measurements and proposed thresholds (SC-005)

- **Workload**: synthetic pages in `scripts/pages/memory/`, served on loopback.
  - 200 iterations each of: navigate, `navigate {snapshot:true}`, snapshot, `browser_memory`, and a 5-step batch.
  - 4 concurrent IPC clients.
  - 1,000 pre-seeded origins.
  - Runs with memory off (baseline), on with an empty store, and on with the seeded store.
  - Node 20 and 22; macOS and Windows.
  - Record the hardware and the failures.
- **Metrics**:
  - p50, p95 and p99 per tool;
  - daemon start time;
  - idle and peak RSS;
  - queue depth, drops and timeouts;
  - store bytes;
  - recovery time after a killed daemon;
  - reminder and tool output size in characters.
- **Model tokens**: marked `UNAVAILABLE`, because no model runs in the daemon.
- **Proposed thresholds** (owner gate 4):

  | Measure | Proposed limit |
  |---|---|
  | navigate p95 overhead | ≤ 25 ms |
  | snapshot p95 overhead | ≤ 30 ms |
  | commit p95 | ≤ 50 ms |
  | start overhead | ≤ 50 ms |
  | idle RSS growth | ≤ 10 MiB |
  | queue drops at 4 clients | 0 |

  A result that fails privacy or compatibility is rejected whatever its speed.

## R-19 Governance and authorizations

- **Decision**: `EVOLVE / CRITICAL` is proposed, and the owner confirms it. Implementation waits for owner gates 1–5. Each of the following needs its own explicit authorization:
  - commits and pushes;
  - the Mnemon prototype and any dependency;
  - `npm run security:audit`, which contacts the registry;
  - real-Chrome runs.

  Local checks are reported apart from CI and owner approval. The constitution is proposed, so its checks are tracked but not claimed as gates passed.

## R-20 Documentation and compatibility

- **Decision**:
  - README: memory section, CLI and the `cookies` permission.
  - SECURITY.md: threat model and residual risks (R-07, R-13).
  - CHANGELOG under Unreleased, with notes to reload the extension and restart the daemon.
- **Compatibility**:
  - An old extension never gets the `cookies` permission and never reports `siteContext`, so memory stays inert.
  - Old MCP clients still work; they do not list `browser_memory` until restarted.
  - Old daemons reject a `memory-admin` message; the CLI checks the welcome capability `memory-admin` first.
