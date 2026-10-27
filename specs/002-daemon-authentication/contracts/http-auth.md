# Contract: Authenticated Local HTTP

All paths remain on the existing loopback HTTP listener. The enrollment secret is never sent. Proofs use HMAC-SHA-256 and base64url encoding with distinct `bc-http-server-v1`, `bc-http-client-v1`, and `bc-http-response-v1` domain prefixes. Transcript fields are UTF-8, separated by a single newline, with the request target preserved exactly as sent.

## 1. Obtain a daemon challenge

`GET /auth/challenge?clientNonce=<random-base64url>` returns JSON containing `protocolVersion`, `instanceId`, `serverNonce`, and `serverProof`.

`serverProof` authenticates `protocolVersion`, `clientNonce`, `serverNonce`, and `instanceId` with the enrollment secret. The client MUST validate it before sending any request proof. The endpoint returns no token or protected daemon data and does not pin an extension origin.

## 2. Request a protected operation

For `/pair`, `/status`, or `/kill?... `, the client sends `GET` with:

- `X-BC-Client-Nonce`
- `X-BC-Server-Nonce`
- `X-BC-Client-Proof`

`clientProof` authenticates protocol version, both nonces, the method, and the exact path/query. The daemon accepts each challenge once, rejects expired/unknown/reused challenges, then runs the existing handler.

## 3. Verify the response

The daemon returns `X-BC-Response-Proof`, authenticating protocol version, both nonces, HTTP status, and the SHA-256 digest of the exact response body bytes. The caller MUST verify this proof before parsing or using the body. Invalid proofs fail closed and must not update saved tokens, popup status, or operation results.

Preflight requests carry no secret and are not authentication. CORS allows only the existing extension-origin policy and exposes the response-proof header. Authentication failures do not disclose which proof field was incorrect.

## Port conflict and lifecycle probes

The bridge and `scripts/daemon.mjs` use the same challenge and response validation. An invalid or absent proof means only “unverified listener”. No probe may send `X-BC-Enrollment` or terminate a process.
