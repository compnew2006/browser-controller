# Quickstart: Authenticate the Local Daemon

## Prerequisites

- Use the repository's existing installed dependencies and synthetic test credentials.
- Do not use a real Chrome profile or read local pairing/credential files.

## Validation

1. Run the focused protocol and bridge regressions:

   ```sh
   npx vitest run tests/extension-connection-handshake.test.ts tests/extension-native-pairing.test.ts tests/bridge.test.ts tests/protocol-handshake.test.ts
   ```

2. Confirm the tests cover valid authentication; absent, forged, altered, expired, and replayed proofs; no raw secret/token in requests or logs; no pre-auth tool/vault dispatch; and fake/genuine port-conflict listeners.
3. Run repository checks:

   ```sh
   npm test
   npm run lint
   npm run typecheck
   npm run build
   ```

## Expected results

- The paired test daemon and extension complete protocol version 2 authentication.
- A protocol-shaped fake listener cannot cause an extension acknowledgement, state adoption, or browser handler call.
- Pairing, popup status/disconnect, and lifecycle probes accept only correctly signed responses.
- The enrollment secret and raw auth token are absent from all test-observed request URLs, headers, WebSocket subprotocols, and logs.
- A fake port owner is reported as unverified and is never terminated.
