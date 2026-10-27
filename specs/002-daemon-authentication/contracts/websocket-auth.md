# Contract: Authenticated Extension WebSocket

The handshake uses the existing WebSocket transport with protocol version `2`. Neither the enrollment secret nor the raw auth token is sent in the URL, WebSocket subprotocol, or any frame.

1. The extension opens the socket without a credential-bearing subprotocol and sends `{ "type": "authInit", "clientNonce": "<fresh random base64url>" }` as its first frame.
2. The daemon sends the existing `hello` fields plus a fresh random `serverNonce` chosen for this socket and `authProof`. `authProof` is a domain-separated HMAC-SHA-256 under the enrollment secret, bound to both nonces, daemon instance ID, protocol version, and normalized capability set.
3. The extension verifies `authProof`, the nonce, the protocol version, and required capabilities before changing state or responding. A failure closes the socket; no other inbound frame is processed while authentication is pending.
4. The extension sends `helloAck` with its existing version/capabilities/browser identity and `authProof`. This proof is a domain-separated HMAC-SHA-256 under the auth token, bound to the same two nonces, daemon instance ID, protocol version, normalized capabilities, and browser identity. The daemon verifies it against the `serverNonce` it chose for this socket, so an acknowledgement captured from another connection never verifies, even when that connection reuses the client nonce.
5. The daemon validates the proof and existing version/capability checks before marking the socket ready. Only a ready socket can exchange tool, vault, ping, or result messages.

Both sides use canonical field ordering and base64url HMAC output. Missing, malformed, mismatched, or replayed proofs fail closed with no downgrade to protocol version `1`.
