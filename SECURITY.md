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

- **Local-only communication**: WebSocket between extension and server runs on localhost only.
- **Origin validation (exact-match on a pinned extension ID)**: the daemon pins the extension's `chrome-extension://<id>` Origin on first contact, then rejects every later request whose Origin is not an exact match. This applies to BOTH the WebSocket upgrade and the HTTP endpoints (`/pair`, `/status`, `/kill`) through one shared gate — a web page and a co-installed hostile extension (which carries its own Origin and cannot forge ours) are both rejected. The browser sets the `Origin` header; it cannot be forged from page JS.
- **Token auth on the control plane**: the WebSocket upgrade additionally requires the daemon's auth token (sent out-of-band via `Sec-WebSocket-Protocol` subprotocol, with a `?token=` legacy fallback). The HTTP endpoints do not require the token — they rely on the Origin gate instead, because `/pair` is itself how the token is first obtained (a chicken-and-egg a token gate would break).
- **No data exfiltration**: Nothing leaves your machine. No cloud, no telemetry, no analytics.
- **Broad-but-purpose-scoped permissions**: the extension requests `debugger`, `webRequest`, and `<all_urls>` — the most powerful Chrome-extension permissions available. These are **required** for the tool's purpose (the `debugger` permission grants full DevTools Protocol access: cookies, all traffic, JS injection; `<all_urls>` is needed because the agent can drive any tab the user has open). This is not "minimal" in the Chrome-Web-Store sense; it is the smallest set that can fulfill "control your real browser."
- **Co-installed extension hardening (exact-match Origin pin + enrollment secret)**: two layers defend against a hostile extension co-installed on the same machine. (1) The daemon pins the legitimate extension's `chrome-extension://<id>` Origin on first contact and rejects every later request whose Origin is not an exact match — at BOTH the HTTP and WS layers. (2) **Every HTTP endpoint requires an enrollment secret** (`X-BC-Enrollment` header), which is the layer that closes the *first-contact* race (see below): even a hostile extension that reaches the daemon first cannot obtain the token, because `/pair` rejects it without the secret.
- **Enrollment secret (one-time manual pairing)**: the daemon generates a random secret at `~/.browser-controller/enrollment.json` (mode 0600) and prints it to stderr on startup (`npx browser-controller`). The user pastes it **once** into the popup's "Enrollment Secret" field; it is stored in `chrome.storage.local` and sent on every daemon HTTP call. The secret is **out-of-band** relative to the daemon's HTTP channel (it does not travel via `/pair`), which is exactly why it can authenticate `/pair` itself. To rotate: delete `enrollment.json` and re-run `npx browser-controller`, then re-paste in the popup.
- **Strict TypeScript**: compiled with strict mode to reduce runtime errors.

## Known Limitations

- **First-contact TOFU race — CLOSED by the enrollment secret**: an earlier revision documented this as an exploitable window (a hostile extension reaching the daemon first would get pinned, obtain the token via `/pair`, and gain full MCP control). The **enrollment secret now closes it**: `/pair` (and `/status`, `/kill`) return 403 without the correct `X-BC-Enrollment` header, so a hostile extension that wins the Origin-pin race still leaves empty-handed — it cannot learn the secret, because the secret is delivered out-of-band (terminal output → manual popup entry), never over the daemon's HTTP channel. The exact-match Origin pin remains as a second layer (post-pin protection); the enrollment secret is the primary gate.
- **What an attacker CANNOT do** (closed): obtain the token, open the WS, drive MCP tools — none of these, even by winning the first-contact race, without the enrollment secret.
- **What remains (residual, low-severity)**: a hostile extension that wins the pin *and* somehow learns the secret (e.g. the user pasted it into the wrong extension, or a separate compromise reads `chrome.storage.local`) could act. This requires the attacker to already have a foothold on the user's browser *and* the user to have mishandled the secret — it is not a network-reachable attack. If you suspect this, rotate `enrollment.json`.
- **The `?token=` query fallback on the WebSocket upgrade** is retained for backward compatibility with installed extensions that have not yet shipped the subprotocol change. It does NOT weaken the Origin gate or the enrollment gate (both are independent of the token), and the WS upgrade still requires a pinned-extension Origin AND the token.
- **Breaking change for existing installs**: the enrollment secret is now mandatory. Users who upgrade will see the popup show "disconnected" until they paste the secret (printed by `npx browser-controller`) into the new "Enrollment Secret" field. This is a deliberate one-time UX cost to close the first-contact race; see CHANGELOG.md.

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
