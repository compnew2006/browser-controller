# Verification: Authenticate the Local Daemon

Date: 2026-10-27. Branch `codex/002-daemon-authentication`, checked at HEAD `181ce7e`.

## Scope and status

This is local verification only. It is not CI and it is not Owner acceptance. CI and Owner approval of the pull request remain the formal gates.

## Commits

| Commit | Content |
|---|---|
| `6c9922d` | The 002 implementation and its review fixes: `mcp-server/src/bridge-auth.ts`, `bridge-http.ts`, `bridge-security.ts`, `extension/lib/daemon-auth.js`, `connection.js`, `protocol.js`, popup changes. Includes F2-2, F2-3 and F2-8 (per-socket server nonce; contract amended). |
| `137740a` | F2-9, F3-9, F3-10: an unproven socket no longer fails agents' calls; frames from a dropped socket are ignored; `/pair` and the native pairing host time out after 5 s. |

## Checks run by the orchestrator

| Check | Result | At |
|---|---|---|
| `npm test` | 102 files, 1386 tests passed | `181ce7e` |
| `npm run typecheck` | exit 0 | `181ce7e` |
| `npm run lint` | exit 0 | `181ce7e` |
| emit (build to a scratch directory) | exit 0 | `181ce7e` |

The test names below were checked with grep against the test files. Passing status comes from the full run above, not from a per-test run.

## Requirement to test map

| FR | Covered by (file: test) |
|---|---|
| FR-001 | `tests/extension-connection-handshake.test.ts`: "refuses a forged daemon hello before acknowledging or adopting it", "does not report connected when the socket closes while the daemon proof is checked". `tests/extension-daemon-auth.test.ts`: "does not send a request proof when the challenge responder is forged". |
| FR-002 | `tests/protocol-handshake.test.ts`: "refuses a helloAck replayed on a new connection that reuses the earlier nonce", "sends an authenticated daemon hello after authInit and accepts a proven helloAck". `tests/bridge-auth.test.ts`: "issues a server-verifiable challenge tied to the caller nonce and daemon instance". |
| FR-003 | `tests/protocol-handshake.test.ts`: "rejects a browser control frame before the peer proves the extension token", "closes a socket whose first frame is not authInit, before sending any hello", "closes a socket that sends any frame other than helloAck after the daemon hello", "holds a tool call until the helloAck arrives, then routes it". Fixtures: `tests/bridge-multibrowser.test.ts`, `tests/bridge-vault.test.ts`, `tests/wp6-browser-default.test.ts` (through `tests/helpers/bridge-auth.ts`). |
| FR-004 | `tests/bridge-auth.test.ts`: "consumes a valid challenge once and binds authorization to method and exact target", "expires challenges", "keeps a hard capacity by evicting the oldest outstanding challenge, never by refusing a new one". `tests/extension-daemon-auth.test.ts`: "does not send a request proof when a challenge echoes the nonce but was signed without the secret", "rejects a response whose body was changed after the daemon signed it". Plus the FR-003 tests. |
| FR-005 | `tests/extension-daemon-auth.test.ts`: "verifies the daemon before sending a proof and verifies the response before parsing it". `tests/bridge-auth.test.ts`: "authenticates the exact response status and body". `tests/extension-native-pairing.test.ts`: "pairs itself when no secret is stored: native host → authenticated /pair → token". |
| FR-006 | `tests/extension-connection-handshake.test.ts`: "keeps credentials out of the WebSocket URL and subprotocols". `tests/bridge.test.ts`: "does not accept a token from a URL query as extension authentication", "rejects a subprotocol-bearing upgrade without echoing its offered credential". `tests/daemon-lifecycle-identity.test.ts`: "rejects an impostor HTTP challenge without sending the enrollment secret". `tests/extension-native-pairing.test.ts`: "keeps a user-selected port and does not send a rejected secret to that port". |
| FR-007 | `tests/extension-native-pairing.test.ts` (background pairing), `tests/bridge.test.ts` `isDaemonResponsiveOnPort` (port conflict), `tests/daemon-lifecycle-identity.test.ts` (lifecycle probes). Popup actions: no popup-specific test found; the popup uses the same `authenticatedDaemonFetch`. |
| FR-008 | `tests/bridge.test.ts`: "returns true only when a daemon proves its identity on the occupied port", "returns false when a non-daemon server holds the port (wrong body shape)". `tests/daemon-lifecycle-identity.test.ts`: "stop never signals a process that is not the daemon", "status does not report an unrelated live pid as a running daemon". |
| FR-009 | `tests/extension-connection-handshake.test.ts`: "acknowledges a current daemon hello and reports connected", "re-pairs before reconnecting when the daemon refuses the acknowledgement proof". `tests/extension-native-pairing.test.ts`: "replaces a rotated secret when the existing secret cannot verify the daemon challenge". `tests/protocol-handshake.test.ts`: "accepts a current extension helloAck". Popup status and agent-disconnect: see open items. |
| FR-010 | `tests/protocol-handshake.test.ts`: "rejects a 2.x extension whose helloAck lacks tools-v3 and tells the user to reload it", "names an unsupported numeric version and never echoes other peer-chosen text", "extension side: a daemon hello without tools-v3 is an older daemon, with the restart hint". `tests/extension-connection-handshake.test.ts`: "refuses a daemon hello without a protocol version, with the restart hint". |

## Open items

- Real-Chrome smoke (`npm run smoke:real-chrome`) was not run. Nothing here was exercised against a real browser or a real native messaging host.
- The constitution gates A–D have not passed. `constitution.md` is proposed, not adopted.
- Owner review and CI have not happened.
- No test was found for the popup's `/status` and `/kill` actions, nor for "no secret or token in logs" (FR-006). Both rest on code reading only.
- The test-to-requirement map was made by name. Whether each test would fail without the behaviour it covers was not checked.
- T020 in `tasks.md` stays open: the final diff review is not recorded here.
