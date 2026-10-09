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

- **Local-only communication**: the daemon's HTTP/WebSocket control plane is hard-bound to IPv4 loopback (`127.0.0.1`), not configurable through `WS_HOST`. WebSocket traffic between the extension and daemon remains local. MCP clients use stdio and then an authenticated local IPC socket; they do not get a TCP listener.
- **Remote callers and n8n**: Browser Controller has no supported remote or n8n ingress protocol. Do not publish port 7225 or change the listener to a wildcard address. A remote integration should run on the same host and reach the MCP client through its approved local process boundary, or be given a separately authenticated transport; browser-control credentials must not be reused as a network API key.
- **Origin validation (exact-match on a pinned extension ID)**: the daemon pins the extension's `chrome-extension://<id>` Origin on first contact, then rejects every later request whose Origin is not an exact match. This applies to BOTH the WebSocket upgrade and the HTTP endpoints (`/pair`, `/status`, `/kill`) through one shared gate — a web page and a co-installed hostile extension (which carries its own Origin and cannot forge ours) are both rejected. The browser sets the `Origin` header; it cannot be forged from page JS.
- **Token auth on the control plane**: the WebSocket upgrade additionally requires the daemon's auth token (sent out-of-band via `Sec-WebSocket-Protocol` subprotocol, with a `?token=` legacy fallback). HTTP endpoints cannot require that token because `/pair` is how it is obtained; they instead require the browser-asserted pinned Origin plus the separate `X-BC-Enrollment` secret.
- **Versioned capability handshake**: transport authentication is necessary but not sufficient to mark the extension ready. The daemon and extension advertise a protocol major, application version, and capabilities before tool traffic is routed. An explicitly incompatible protocol major is rejected; application-version differences alone are diagnostic because compatible patch releases can share the same wire contract. Peers that omit the protocol field are identified as legacy during the migration window rather than being silently mistaken for a current peer.
- **No data exfiltration**: Nothing leaves your machine. No cloud, no telemetry, no analytics.
- **Broad-but-purpose-scoped permissions**: the extension requests `debugger`, `scripting`, `webRequest`, and `<all_urls>` — among the most powerful Chrome-extension permissions available. They are **required** for the tool's purpose: `debugger` grants DevTools Protocol operations used for CSP-bypassing actions, dialog handling, drag, and file upload; `scripting` runs page functions; `webRequest` observes request metadata; and `<all_urls>` lets the selected tools operate on normal web tabs across origins. This is not "minimal" in the Chrome-Web-Store sense; it is the smallest practical set for "control your real browser." Chrome-protected pages remain outside the extension's reach. `nativeMessaging` is used only to ask the local pairing helper for the enrollment secret (see below).
- **Trusted-agent boundary**: a successfully paired MCP client is authorized to act with those browser permissions. In particular, `browser_evaluate` and `browser_run_action` can execute arbitrary page-context JavaScript, while CDP-backed tools may access data visible to DevTools. Authentication protects the control channel from unpaired callers; it does not sandbox or second-guess an authorized agent. Only connect clients and prompts you trust, especially while banking, email, admin, or company SSO tabs are open.
- **Co-installed extension hardening (exact-match Origin pin + enrollment secret)**: two layers defend against a hostile extension co-installed on the same machine. (1) The daemon pins the legitimate extension's `chrome-extension://<id>` Origin on first contact and rejects every later request whose Origin is not an exact match — at BOTH the HTTP and WS layers. (2) **Every HTTP endpoint requires an enrollment secret** (`X-BC-Enrollment` header), which is the layer that closes the *first-contact* race (see below): even a hostile extension that reaches the daemon first cannot obtain the token, because `/pair` rejects it without the secret.
- **Enrollment secret (pairing)**: the daemon generates a random secret at `~/.browser-controller/enrollment.json` (mode 0600) and prints it to stderr on first run of the MCP server. The extension receives it from the local pairing helper (below) or the user pastes it once into the popup's "Enrollment Secret" field; it is stored in `chrome.storage.local` and sent on every daemon HTTP call. The secret is **out-of-band** relative to the daemon's HTTP channel (it does not travel via `/pair`), which is exactly why it can authenticate `/pair` itself. To rotate: delete `enrollment.json` and restart the daemon; with the helper installed the extension picks up the new secret by itself, otherwise re-paste it in the popup.
- **Pairing helper (Chrome native messaging, `npm run setup:pairing`)**: a per-user native messaging host (`mcp-server/dist/native-host.js`) answers one request with the enrollment secret and the daemon port, then exits; it opens no port and writes nothing. Chrome starts it only for the extension IDs in its host manifest's `allowed_origins` — web pages and other extensions are refused by Chrome itself — and the extension asks it only when the daemon refuses its current secret. This keeps the secret out-of-band: it moves over the helper's stdio, never over the daemon's HTTP channel, so the first-contact protection below still holds. The helper reads a file every process of the same user can already read, so it grants no new access. The allowed ID is the unpacked extension's ID, which Chrome derives from the extension's folder path; another extension can only carry that ID by being loaded from the same folder, which already requires write access to the checkout. The same holds for the generated launcher in `.native-host/`: whoever can change it can already change the code the MCP client runs.
- **Strict TypeScript**: compiled with strict mode to reduce runtime errors.

## Known Limitations

- **First-contact TOFU race — CLOSED by the enrollment secret**: an earlier revision documented this as an exploitable window (a hostile extension reaching the daemon first would get pinned, obtain the token via `/pair`, and gain full MCP control). The **enrollment secret now closes it**: `/pair` (and `/status`, `/kill`) return 403 without the correct `X-BC-Enrollment` header, so a hostile extension that wins the Origin-pin race still leaves empty-handed — it cannot learn the secret, because the secret is delivered out-of-band (the Chrome-gated pairing helper, or terminal output → manual popup entry), never over the daemon's HTTP channel. The exact-match Origin pin remains as a second layer (post-pin protection); the enrollment secret is the primary gate.
- **What an attacker CANNOT do** (closed): obtain the token, open the WS, drive MCP tools — none of these, even by winning the first-contact race, without the enrollment secret.
- **What remains (residual, low-severity)**: a hostile extension that wins the pin *and* somehow learns the secret (e.g. the user pasted it into the wrong extension, or a separate compromise reads `chrome.storage.local`) could act. This requires the attacker to already have a foothold on the user's browser *and* the user to have mishandled the secret — it is not a network-reachable attack. If you suspect this, rotate `enrollment.json`.
- **The `?token=` query fallback on the WebSocket upgrade** is retained for backward compatibility with installed extensions that have not yet shipped the subprotocol change. It does NOT weaken the Origin gate or the enrollment gate (both are independent of the token), and the WS upgrade still requires a pinned-extension Origin AND the token.
- **Breaking change for existing installs**: the enrollment secret is now mandatory. Users who upgrade will see the popup show "disconnected" until they run `npm run setup:pairing` (the extension then pairs itself) or paste the secret (printed on first run of the MCP server) into the "Enrollment Secret" field. This is a deliberate one-time UX cost to close the first-contact race; see CHANGELOG.md.
- **Same-origin iframe boundary**: DOM snapshot, discovery, and interaction paths can pierce same-origin iframes and open shadow roots. They cannot traverse a cross-origin iframe's DOM because the browser enforces the same-origin policy. The content may still be visible in a screenshot, but that does not make its elements safely addressable by a ref from the top document.
- **Top-frame control shield**: the visible shield and its input interception are installed in the top document. They are a user-safety affordance, not an authorization boundary, and are not guaranteed to suppress input already focused inside an independent or cross-origin child frame. Avoid manual input anywhere in a tab while an agent controls or locks it.
- **Evaluation and CSP**: `browser_evaluate` runs over CDP by default, so a page Content Security Policy does not block it, and Chrome shows its debugging banner while the debugger is attached. Its `mode: "scripting"` avoids the banner by evaluating in the page's MAIN world with page-side `eval`, which a strict CSP can reject; the same path is the fallback when the debugger cannot attach. `browser_run_action` always uses CDP. Both CDP paths exercise the broad `debugger` permission.
- **Upgrade compatibility**: a missing protocol version is temporarily treated as a legacy peer so existing installations can migrate, while an explicitly different protocol major is refused. After pulling a protocol-changing update, both the long-lived daemon and Chrome's MV3 service worker must be replaced: rebuild and restart the daemon, then reload the extension from `chrome://extensions`. A build-version mismatch is diagnostic; a protocol-major mismatch is the actual compatibility failure.

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
