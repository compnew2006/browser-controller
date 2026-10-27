# Research: Authenticate the Local Daemon

## Findings and decisions

### WebSocket peer identity

- **Finding**: `extension/lib/protocol.js` validates message type, version, and capabilities only. `connection.js` then adopts the daemon instance, sends `helloAck`, and marks the connection ready. The daemon checks the token during the WebSocket upgrade, but it does not prove its identity to the extension; the token is currently included in the offered subprotocol.
- **Decision**: Use a fresh extension-generated nonce and an HMAC proof under the existing enrollment secret in the daemon's greeting. Bind the proof to the daemon instance and protocol envelope. Use a separate HMAC proof under the existing auth token in the extension acknowledgement; the token itself is never sent in the handshake transport.
- **Rationale**: Server authentication must happen before the extension releases any credential or accepts a control frame. Mutual proof also prevents an unauthenticated peer from becoming a ready extension connection.
- **Alternatives considered**: Trusting origin, loopback address, port, protocol version, or a preflight HTTP response was rejected because each can be imitated by the process that owns the port. Sending the secret/token through a URL or subprotocol was rejected because the unverified listener receives it before identity is established.

### Local HTTP authentication

- **Finding**: `connection.js`, `popup.js`, `bridge.ts`, and `scripts/daemon.mjs` currently use the raw enrollment secret in `X-BC-Enrollment`. The bridge also sends that header from `isDaemonResponsiveOnPort` after `EADDRINUSE`. The daemon returns the token and management data over the same HTTP listener.
- **Decision**: Use a client nonce plus a daemon-signed challenge, then a single-use request proof bound to the exact method and path/query. Sign each authenticated response over the challenge, status, and exact response bytes. Verify the daemon proof before submitting the request proof; verify the response proof before parsing or acting on the result.
- **Rationale**: A challenge authenticates the peer before the caller releases a request proof; consuming the challenge once prevents captured proofs from being replayed to a later daemon instance. Response signing protects `/pair` from fake token injection and protects popup state/actions from forged responses.
- **Alternatives considered**: Merely removing the secret from the port-conflict probe was rejected because the extension's `/pair`, popup `/status`/`/kill`, and lifecycle `/status` calls still disclosed it. Stateless request HMAC alone was rejected because a listener could capture and replay a proof.

### Runtime and compatibility

- **Finding**: The project already has Node `crypto`, browser Web Crypto, protocol-version checks, local Vitest coverage, and no need for an external cryptography package. The pairing host supplies the existing enrollment secret out of band.
- **Decision**: Use HMAC-SHA-256 with separate domain strings for each proof type, cryptographically random nonces, constant-time verification on the daemon, and a bounded/expiring in-memory challenge registry. Bump the existing wire protocol and reject older peers.
- **Rationale**: This reuses installed platform primitives and the existing pairing boundary. Version rejection prevents a downgrade to the unauthenticated handshake.
- **Alternatives considered**: TLS certificate management would add a certificate bootstrap/distribution problem to this local pairing workflow and is unnecessary for authenticating the local peer with an already shared secret.

## Evidence reviewed

- `extension/lib/connection.js`, `extension/lib/protocol.js`, and `extension/popup/popup.js`
- `mcp-server/src/bridge.ts`, `mcp-server/src/bridge-security.ts`, `mcp-server/src/protocol.ts`, and `mcp-server/src/daemon.ts`
- `scripts/daemon.mjs`
- `tests/extension-connection-handshake.test.ts`, `tests/extension-native-pairing.test.ts`, `tests/bridge.test.ts`, and `tests/protocol-handshake.test.ts`

No external dependencies or live services are required for this design.
