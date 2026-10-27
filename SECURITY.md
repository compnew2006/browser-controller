# Security Policy

## Reporting a Vulnerability

**Do not open public GitHub issues for security vulnerabilities.**

Report vulnerabilities through:

1. **GitHub Security Advisories (preferred):** [Create a private security advisory](https://github.com/compnew2006/browser-controller/security/advisories/new)

### What to Include

- Description of the vulnerability and potential impact
- Steps to reproduce or a minimal proof of concept
- The version(s) affected

### What to Expect

- **Acknowledgment** within 48 hours
- **Status update** within 7 days
- **Credit** in the release notes (unless you prefer to stay anonymous)

## Supported Versions

| Version | Supported |
|---------|-----------|
| Latest  | Yes |

## Security Model

### Optional browser action policy

`browser_safety` is off by default and stores its settings only for the current MCP server session. When enabled, the extension inspects the target before a click, type or fill action and labels recognized submits, file uploads and common delete/remove controls. The exact hostname rule overrides `defaultAction`. `block` refuses the dispatch; `ask` requests a user decision through MCP elicitation and refuses when the connected client cannot provide that UI. The target classification and element fingerprint are checked again after approval.

This policy is a guardrail, not a complete authorization boundary. Site-specific JavaScript controls can perform destructive work without a native submit control or a recognizable label, and the heuristic may miss them. Leave sensitive sites set to `block` when an incomplete page classifier is not acceptable. File paths and field values are not sent to the classifier.

- **Local-only communication**: the daemon's HTTP/WebSocket control plane is hard-bound to IPv4 loopback (`127.0.0.1`), not configurable through `WS_HOST`. WebSocket traffic between the extension and daemon remains local. MCP clients use stdio and then an authenticated local IPC socket; they do not get a TCP listener.
- **Remote callers and n8n**: Browser Controller has no supported remote or n8n ingress protocol. Do not publish port 7225 or change the listener to a wildcard address. A remote integration should run on the same host and reach the MCP client through its approved local process boundary, or be given a separately authenticated transport; browser-control credentials must not be reused as a network API key.
- **Origin validation (exact-match on a pinned extension ID)**: a request whose `Origin` is not `chrome-extension://…` is refused. The daemon pins the first extension origin that passes authenticated HTTP or WebSocket proof, then refuses every later request whose Origin is not an exact match. A web page and a co-installed hostile extension carry their own `Origin`; requests without an Origin are allowed through this gate for local clients but must still prove identity. Origin and loopback address are not treated as identity.
- **Mutual WebSocket authentication**: the extension sends a fresh random nonce in `authInit`. The daemon proves its identity with an HMAC under the enrollment secret, bound to the nonce, daemon instance, protocol version, and capabilities. The extension verifies it before adopting daemon state, enabling vault messages, or accepting control frames. The daemon's hello also carries a fresh nonce of its own for that socket. The extension then proves the auth token in `helloAck`, bound to both nonces, so a captured acknowledgement cannot authenticate another connection; the daemon marks it ready only after verifying the proof. Neither secret nor token appears in the URL, WebSocket upgrade, subprotocol, or handshake frame.
- **Authenticated HTTP operations**: `/pair`, `/status`, and `/kill` require a fresh challenge, client proof, and signed response. `/auth/challenge` returns only a daemon proof over a client nonce; callers verify it before sending a request proof. Challenges are single-use and expire. Port-conflict checks and lifecycle probes use the same verification, so an unrelated listener never receives the enrollment secret and cannot be mistaken for the daemon.
- **Versioned capability handshake (fail closed)**: transport authentication is necessary but not sufficient to mark a peer ready. Each side sends a `protocolVersion` and its capabilities. A peer must send an explicit protocol version and the `tools-v3` capability before any tool call is routed to it; otherwise it is refused. This holds for the extension WebSocket and for the MCP-client IPC socket. A different protocol major is refused. Application-version differences alone are diagnostic. A tool reply is accepted only from the connection the call was sent on.
- **No data exfiltration**: Nothing leaves your machine. No cloud, no telemetry, no analytics.
- **Broad-but-purpose-scoped permissions**: the extension requests `debugger`, `scripting`, `webRequest`, and `<all_urls>` — among the most powerful Chrome-extension permissions available. They are **required** for the tool's purpose: `debugger` runs DevTools Protocol operations for trusted input (clicks, typing, keys, wheel, drags, file inputs), screenshots of background tabs, `browser_evaluate`, console and network reads, per-tab response mocks, and element inspection; `scripting` runs page functions; `webRequest` records request metadata for `browser_logs`; and `<all_urls>` lets the selected tools operate on normal web tabs across origins. This is not "minimal" in the Chrome-Web-Store sense; it is the smallest practical set for "control your real browser." Chrome-protected pages remain outside the extension's reach. `nativeMessaging` is used only to ask the local pairing helper for the enrollment secret (see below).
- **Nothing runs in the pages you browse yourself**: the extension declares no content scripts. Code reaches a page only while a tool acts on that tab (page functions, the agent's frame and cursor). `browser_logs` reads what Chrome already keeps for the page through the debugger, so the page's `console` is never wrapped and a site's own errors are never reported as the extension's.
- **Trusted-agent boundary**: a successfully paired MCP client is authorized to act with those browser permissions. In particular, `browser_evaluate` can execute arbitrary page-context JavaScript, while CDP-backed tools may access data visible to DevTools. Authentication protects the control channel from unpaired callers; it does not sandbox or second-guess an authorized agent. Only connect clients and prompts you trust, especially while banking, email, admin, or company SSO tabs are open.
- **Per-tab request changes**: `browser_mock` answers or blocks the requests of one tab through the debugger's Fetch domain. It has no effect on other tabs, and it stops when the debugger detaches.
- **Sticky tab state ends with its owner**: `browser_mock` rules, `browser_emulate` overrides and `browser_logs` response-body capture stay on a tab until they are cleared. The session that set them clears them when that session disconnects, and a closed tab forgets them. A disconnect never clears another session's settings.
- **File uploads**: an authorized agent can upload any readable local file to a page with `browser_fill`, except the paths the server refuses before anything is sent (`FILE_NOT_ALLOWED`). Refused are hidden files (a last path segment that starts with `.`) and any path that contains one of these names: `.ssh`, `.aws`, `.gnupg`, `.kube`, `.docker`, `.azure`, `.config`, `.browser-controller`, `.password-store`, `.netrc`, `.git-credentials`, `Keychains`. A symlink is resolved before the check.
- **Co-installed extension hardening**: an untrusted extension cannot obtain the auth token from `/pair` without a fresh request proof under the out-of-band enrollment secret. It also cannot impersonate the daemon to the paired extension without signing its nonce-bound WebSocket hello. Origin pinning remains an additional post-authentication restriction.
- **Enrollment secret (pairing)**: the daemon generates a random secret at `~/.browser-controller/enrollment.json` (mode 0600) and prints it to stderr on first run of the MCP server. The extension receives it from the local pairing helper below or the user pastes it once into the popup's "Enrollment Secret" field; it is stored in `chrome.storage.local` and used locally to verify HMAC proofs. The extension never sends it to the HTTP listener. To rotate, run `npm run pairing:rotate`, then `npm run daemon:restart`. It atomically replaces `enrollment.json` and the daemon auth token `token.json` (both mode 0600), prints neither value, and does not touch any process, so the old values stay valid until the daemon restarts. With the helper installed the extension re-pairs by itself (its next authentication failure triggers a fresh request to the helper); otherwise re-paste the new secret in the popup. Results of `browser_evaluate` and daemon logs are not a secret-safe channel: do not use them to carry or inspect the enrollment secret or token.
- **Pairing helper (Chrome native messaging, `npm run setup:pairing`)**: a per-user native messaging host (`mcp-server/dist/native-host.js`) answers one request with the enrollment secret and daemon port, then exits; it opens no port and writes nothing. Chrome starts it only for extension IDs in its host manifest's `allowed_origins`. The secret moves over the helper's stdio, never over the daemon's HTTP channel. The helper reads a file the same user can already read, so it grants no new access.
- **Strict TypeScript**: compiled with strict mode to reduce runtime errors.

### Credential vault

`browser_vault` accepts opaque account handles; only the authenticated daemon resolves an encrypted local account. Password entry is confined to the extension-owned masked page. Fill is bound to the approved browser connection, live session, exact origin, current top document, same-origin target frame, and one-use inspection nonce. The extension uses a bounded isolated-world `chrome.scripting` call targeted by document ID, and never clicks Submit. A timeout after dispatch has an unknown outcome and is never retried automatically.

The vault directory is treated as credential material for local file uploads. `browser_fill` refuses files under the canonical `BC_STATE_DIR/vault` tree and symlink aliases before forwarding them. The key and store use owner-only permissions; the app's lock controls access within Browser Controller and is not a master-password or same-user process isolation guarantee. Recovery snapshots contain both the encrypted store and decryption key. A copied snapshot can recover the accounts.

After a fill, the daemon redacts registered literal/normalized values from public text and structured results. Any live protected or uncertain context blocks profile-wide evaluation, response mocks, raw logs and screenshots; ordinary text and interaction tools remain available with exact-value redaction. Exact-value filtering cannot guarantee detection of arbitrary page-side encoding or transformation. Unrelated cross-origin widgets do not prevent a same-origin login target from being inspected, but fields inside cross-origin frames cannot be inspected or filled. Protected-document state survives worker recycle; missing recovery state fails closed until the affected tab context is discarded.

## Known Limitations

- **First-contact impersonation**: a listener can return a challenge, but the extension verifies its HMAC before sending any request proof or accepting any WebSocket hello. A process that only owns the port therefore cannot obtain the token, read management data, or send browser-control frames. A local attacker who can read the user's state files or extension storage is outside this protection boundary.
- **What an unauthenticated peer cannot do**: obtain the token, read signed HTTP results, authenticate a WebSocket, or drive browser tools. Challenge responses intentionally expose only fresh public nonces and HMAC proofs.
- **What remains (residual, low-severity)**: a hostile extension that wins the pin *and* somehow learns the secret (e.g. the user pasted it into the wrong extension, or a separate compromise reads `chrome.storage.local`) could act. This requires the attacker to already have a foothold on the user's browser *and* the user to have mishandled the secret — it is not a network-reachable attack. If you suspect this, run `npm run pairing:rotate`.
- **The enrollment secret is printed to stderr** on the first run of the MCP server. Whatever captures that output sees it once.
- **The control shield is hidden while a screenshot is taken**, and shown again afterwards.
- **Emulation overrides on a shared tab**: when two sessions set emulation on the same tab, the last session that set an override wins.
- **Sensitive form values are masked by heuristic.** `browser_snapshot` masks password, one-time-code, and payment-card fields identified from their type, `autocomplete`, names, labels, or a Luhn-valid card number. `browser_text` and `browser_inspect` redact matching values when page text echoes them; input verification keeps only booleans for detected sensitive fields. Detection can miss custom labels, and short values may remain if echoed in page prose. `browser_evaluate` can return arbitrary page data, so callers can still explicitly retrieve such values. `browser_logs` redacts JSON bodies, text bodies and URL query values with secret-looking keys.
- **`browser_navigate` on a frozen tab replaces the tab**: the old tab is closed and the result names the new tab id.
- **A JavaScript dialog opened before the debugger attaches cannot be answered.** Chrome answers only the debugger session that saw the dialog open (`NO_DIALOG`).
- **Breaking change for existing installs**: the enrollment secret is now mandatory. Users who upgrade will see the popup show "disconnected" until they run `npm run setup:pairing` (the extension then pairs itself) or paste the secret (printed on first run of the MCP server) into the "Enrollment Secret" field. This is a deliberate one-time UX cost to close the first-contact race; see CHANGELOG.md.
- **Same-origin iframe boundary**: DOM snapshot, text, and target-based interaction paths can pierce same-origin iframes and open shadow roots. They cannot traverse a cross-origin iframe's DOM because the browser enforces the same-origin policy. The content may still be visible in a screenshot, but that does not make its elements safely addressable by a ref from the top document.
- **Top-frame control shield**: the visible shield and its input interception are installed in the top document. They are a user-safety affordance, not an authorization boundary, and are not guaranteed to suppress input already focused inside an independent or cross-origin child frame. Avoid manual input anywhere in a tab while an agent controls or locks it.
- **Evaluation and CSP**: `browser_evaluate` runs over CDP by default, so a page Content Security Policy does not block it, and Chrome shows its debugging banner while the debugger is attached. When the debugger cannot attach, it falls back to `chrome.scripting` in the page's MAIN world (reported as `via: scripting`), which a strict CSP can reject. Both paths exercise the broad `debugger` permission.
- **Upgrade compatibility (no legacy window)**: 3.0 refuses every pre-3.0 peer. Update the MCP server, the daemon and the extension together. After you pull the update, stop the old daemon, restart your MCP clients so the 3.0 daemon starts, then reload the extension at `chrome://extensions`. The refusal texts are:
  - A 3.0 MCP client meets a running 2.x daemon: `The running Browser Controller daemon is older than 3.0: stop it (npm run daemon:stop, or end the pid in its daemon.lock), then restart your MCP client so the 3.0 daemon starts.`
  - A 2.x MCP client meets a 3.0 daemon: `This MCP client is older than 3.0: restart your MCP client so it starts the 3.0 client.`
  - A 3.0 extension meets a 2.x daemon: `The Browser Controller daemon is older than 3.0: restart your MCP client so it starts the 3.0 daemon.`
  - A 2.x extension meets a 3.0 daemon: `The Browser Controller extension is older than 3.0: reload it at chrome://extensions.`

  A protocol-major mismatch is the actual compatibility failure. A build-version mismatch is diagnostic only.

## Dependency and Quality Gates

Before release, maintainers run the same local gates enforced by CI:

```bash
npm ci
npm audit --omit=dev
npm run lint
npm run typecheck
npm run build
npm run test:coverage
```

Production dependencies must have no known audit findings at release time, lint runs with zero warnings, and coverage is held to the configured 80% thresholds for the deterministic protocol, action, state, lock, and bridge-security core. Chrome lifecycle entry points, popup rendering, and native debugger plumbing need a real extension runtime and remain integration/E2E concerns rather than inflating this unit-coverage number. Audit data changes as advisories are published, so a previously clean lockfile must be checked again rather than assumed safe.

## Scope

In-scope:
- WebSocket security issues (authentication bypass, injection)
- Chrome extension permission escalation
- Data leakage through the MCP protocol
- Dependency vulnerabilities with a realistic exploit path

Out of scope:
- Issues in Chrome itself or the MCP SDK
- Denial of service via local WebSocket flooding
- Social engineering attacks
