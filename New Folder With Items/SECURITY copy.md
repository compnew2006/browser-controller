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
- **Co-installed extension hardening (after the pin is set)**: once the daemon has pinned the legitimate extension's Origin on first contact, a *later-arriving* co-installed extension is rejected at both the HTTP and WS layers (its Origin does not match the pin). This narrows — but does not eliminate — the co-installed-extension threat (see the first-contact race below).
- **First-contact race is NOT a safe state (see Known Limitations)**: the first-contact TOFU window is genuinely exploitable, not fail-closed. A hostile extension that reaches the daemon *before* the legitimate one gets pinned, obtains the real token via `/pair`, and can open a control WebSocket. This is documented below as a real limitation, not a benign failure.
- **Strict TypeScript**: compiled with strict mode to reduce runtime errors.

## Known Limitations

- **First-contact TOFU window — exploitable, not fail-closed**: the daemon learns the extension's Origin on first contact (Trust On First Use) and keeps it pinned for the daemon's lifetime. The daemon is a long-lived detached process (restarted only on machine reboot, `npm`/extension update, or a crash — not on every `npx` invocation), so this window opens ~once per boot session, not per use. **This is a real limitation, not a benign failure:** if a *hostile* extension reaches the daemon's localhost port before the legitimate extension does (after a daemon restart), the hostile extension's Origin gets pinned AND `/pair` hands it the real auth token, AND the WS upgrade then accepts that Origin with that token — so the hostile extension obtains **full MCP control of the browser** (click, navigate, evaluate, …) until the daemon is restarted and the legitimate extension reaches it first. The only visible symptom to the user is that the legitimate extension shows "disconnected" / fails with 403 — which looks like an ordinary malfunction, not evidence of a hostile extension. **If you see an unexpected 403 / persistent disconnection: restart the daemon AND review your installed extensions, because the 403 may indicate a co-installed hostile extension rather than a normal fault.** The window is gated on the attacker already having a malicious extension installed and being faster on first contact after a daemon restart — it is not remotely exploitable by a web page.
- **Mitigation status**: the exact-match pin (this change) hardens the *post-pin* state (a later-arriving extension cannot take over an already-pinned daemon). The *first-contact* race remains open by design until an HMAC proof-of-knowledge protocol is added (the token alone is sent in the clear via `/pair`, so proving the caller already knows the token would close the window — but `/pair` is itself how the token is first obtained, so this requires a separate enrollment secret beyond the token). Tracked as future work.
- **The `?token=` query fallback on the WebSocket upgrade** is retained for backward compatibility with installed extensions that have not yet shipped the subprotocol change. It does NOT weaken the Origin gate (which is independent of the token), and the WS upgrade still requires both a pinned-extension Origin AND the token.

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
