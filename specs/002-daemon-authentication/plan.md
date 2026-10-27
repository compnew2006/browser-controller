# Implementation Plan: Authenticate the Local Daemon

**Branch**: `codex/002-daemon-authentication` | **Date**: 2026-10-27 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `/specs/002-daemon-authentication/spec.md`

## Summary

Add mutual, fresh proof to the extension-to-daemon WebSocket handshake and to the local HTTP operations used for pairing and popup management. The extension must verify the daemon before it acknowledges the peer or changes browser state. The daemon must verify the extension before marking a socket ready. HTTP requests use a single-use daemon challenge plus request and response proofs. Neither the enrollment secret nor the raw auth token is transmitted in HTTP headers, URLs, WebSocket subprotocols, or logs. The same authenticated HTTP contract is used by the bridge port-conflict probe and lifecycle script.

## Technical Context

**Language/Version**: Node.js 22; TypeScript MCP daemon; JavaScript Manifest V3 extension  
**Primary Dependencies**: Existing Node `crypto`, browser Web Crypto, `ws`, Chrome extension APIs; no new dependencies  
**Storage**: Existing local `enrollment.json`, `token.json`, and `chrome.storage.local`; no secret-file format changes  
**Testing**: Vitest, ESLint, TypeScript typecheck/build  
**Target Platform**: Local Node daemon and Chromium-based browser extension on macOS, Windows, and Linux  
**Project Type**: Local MCP service with a paired browser extension  
**Performance Goals**: Authentication is paid at connection establishment and existing low-frequency HTTP operations only; no cryptographic work is added to individual browser tool calls  
**Constraints**: Fail closed; bind HTTP to the existing loopback listener; preserve origin checks and pairing recovery; do not reveal secret material in requests or logs; reject old protocol peers without downgrade  
**Scale/Scope**: One daemon, several browser profiles, a small bounded set of short-lived HTTP challenges, and the current popup/status/pairing flows

## Constitution Check

- **Applicable guidance**: `AGENTS.md` requires focused changes, regression coverage for security behavior, preserving secrets, and verifying affected flows. The repository's root `constitution.md` is marked proposed and `.specify/memory/constitution.md` is a template, so neither is represented as ratified policy.
- **Mode/risk**: EVOLVE / CRITICAL. This changes the trust boundary for Chrome control and daemon credentials.
- **Gate before implementation**: No design violation identified. Existing protocol versioning will be used to reject incompatible peers, and the listener remains loopback-only.
- **Post-design gate**: Tests must demonstrate that invalid/replayed proofs cannot reach browser handlers and no secret/token is sent to an unverified peer. The final local review does not constitute Owner or CI approval for merge.

## Design

### Protocol decisions

1. **WebSocket server proof**: The extension creates a cryptographically random client nonce per socket and sends only that nonce in an `authInit` frame. The daemon's `hello` carries a domain-separated HMAC-SHA-256 proof under the enrollment secret, bound to the nonce, daemon instance ID, protocol version, and capabilities. The extension checks the proof and protocol before any acknowledgement, state adoption, or message dispatch.
2. **WebSocket client proof**: The extension's `helloAck` carries a proof under the auth token, bound to the same nonce, daemon instance ID, protocol version, browser identity, and capabilities. The token itself is never sent in a WebSocket header/subprotocol or frame. The daemon marks the connection ready only after validating protocol and proof.
3. **Authenticated HTTP**: `/auth/challenge` returns a server nonce and daemon proof bound to a client-generated nonce. The caller verifies the proof before sending a request proof bound to the one-time challenge, HTTP method, and exact path/query. The daemon consumes each challenge once, applies a short expiry and bounded storage, and signs the status/body in its response. Callers verify the response proof before parsing or using it. `/pair`, `/status`, and `/kill` remain behind this contract.
4. **Port conflict and lifecycle checks**: These use the same authenticated HTTP exchange. A response without a valid daemon proof means only “unverified listener”; the process is never terminated automatically. The probe never sends raw enrollment material.
5. **Compatibility**: Bump the shared WebSocket protocol version. Old peers fail closed with a recovery hint; there is no unauthenticated compatibility path.

### Architecture impact assessment

- **Extension trust boundary**: `extension/lib/connection.js` owns nonce creation, proof verification, and the point at which `adoptDaemonInstance`, `helloAck`, and message routing may proceed. A small `extension/lib/daemon-auth.js` helper centralizes browser-side HMAC and authenticated-fetch formatting for background and popup code.
- **Daemon trust boundary**: `mcp-server/src/bridge.ts` owns socket state transitions and HTTP challenge consumption. A small `mcp-server/src/bridge-auth.ts` helper owns canonical transcript encoding, constant-time HMAC checks, challenge expiry/replay protection, and signed HTTP responses.
- **Existing consumers**: `extension/popup/popup.js`, `mcp-server/src/daemon.ts`, `mcp-server/src/bridge-security.ts`, and `scripts/daemon.mjs` must use the new contract. Do not alter secret-file handling or MCP IPC authentication.
- **Blast radius**: Extension pairing, reconnection, popup status/disconnect, WebSocket readiness, daemon conflict diagnostics, and daemon lifecycle status checks. Browser tool payloads and tool routing schemas remain unchanged.

### Skeptical review / risks

- A valid-looking greeting is not proof of server identity; all state-changing work must remain behind proof verification, including daemon instance adoption and vault support changes.
- A client proof must be bound to fresh server context; a captured proof must not be replayable on a later connection. HTTP challenges must be single-use, expire, and have bounded in-memory storage.
- A fake listener can return a fake pairing token or status. The client must verify the response MAC before storing a token, rendering status, or claiming a disconnect succeeded.
- HTTP caller implementations must share exactly the same canonical transcript and response-body encoding; tests must cover altered status/body and path/query.
- Matching extension and daemon versions are required. The popup must explain pairing/protocol failures without displaying any secret or proof.
- A compromised process with read access to the user's local pairing files is outside this channel-authentication boundary; this change must not widen that access.

## Project Structure

### Documentation (this feature)

```text
specs/002-daemon-authentication/
├── spec.md
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/http-auth.md
├── contracts/websocket-auth.md
└── tasks.md
```

### Source Code

```text
extension/lib/connection.js           # extension connection state and handshake
extension/lib/protocol.js             # shared protocol version and message checks
extension/lib/daemon-auth.js          # browser-side proof and HTTP client helper
extension/popup/popup.js              # authenticated popup requests
mcp-server/src/bridge.ts              # socket and HTTP gates
mcp-server/src/bridge-auth.ts         # daemon proof and challenge lifecycle
mcp-server/src/bridge-security.ts     # authenticated port-conflict probe
mcp-server/src/protocol.ts            # daemon handshake messages
mcp-server/src/daemon.ts              # /pair, /status, and /kill responses
scripts/daemon.mjs                    # lifecycle status verification
tests/                                # protocol, bridge, pairing, and lifecycle regressions
```

**Structure Decision**: Keep the implementation in existing daemon/extension layers and add one narrowly scoped authentication helper per runtime. Do not create a new service, dependency, persistence layer, or change browser tool contracts.

## Verification Strategy

Run targeted tests for protocol proofs, WebSocket rejection-before-dispatch, pairing and popup HTTP response verification, challenge replay/expiry/capacity, and port-conflict/lifecycle probes. Then run `npm test`, `npm run lint`, `npm run typecheck`, and `npm run build`. Inspect the final diff and conduct an independent read-only security review. No real Chrome profile or external service is needed.

## Complexity Tracking

No constitution exception requested. Two small runtime-local helpers are justified to keep canonical proof formats centralized without adding dependencies or crossing the existing extension/daemon boundary.
