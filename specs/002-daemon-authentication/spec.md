# Feature Specification: Authenticate the Local Daemon

**Feature Branch**: `codex/002-daemon-authentication`  
**Created**: 2026-10-27  
**Status**: Draft  
**Input**: User request to fix daemon impersonation and prevent sending the enrollment secret to an unverified process that owns the local port.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Trust the daemon before browser control (Priority: P1)

When the extension reconnects to its local daemon, it must establish that the peer is the paired daemon before accepting its greeting or processing any control message. A process that happens to listen on the configured port must not be able to make Chrome execute browser actions.

**Why this priority**: A forged local daemon can otherwise turn the extension's privileged browser access into an unintended control channel.

**Independent Test**: Connect the extension to a local test server that sends a protocol-shaped but unauthenticated greeting, then verify the extension closes the connection without acknowledging it, changing connection ownership, or forwarding any message to browser handlers. Verify a correctly paired daemon completes the handshake.

**Acceptance Scenarios**:

1. **Given** an unverified listener on the configured port, **When** it sends a valid-looking greeting with a missing, incorrect, or replayed proof, **Then** the extension rejects it before any browser-control message is handled.
2. **Given** a paired daemon and extension, **When** they complete a fresh authentication exchange, **Then** the extension connects and browser tools continue to work.
3. **Given** an unsupported or stale protocol peer, **When** it cannot complete the authentication exchange, **Then** the connection fails closed with an actionable status and no state adoption.

### User Story 2 - Pair and manage the trusted daemon safely (Priority: P1)

When the extension or popup obtains a pairing token, reads daemon status, or disconnects an agent, it must verify the daemon's response and prove authorization without transmitting the enrollment secret to the process at the port.

**Why this priority**: Pairing, status, and disconnect operations share the same local HTTP trust boundary and can disclose credentials or trigger actions if their peer is spoofed.

**Independent Test**: Use a test listener that records requests and returns forged pairing/status responses. Verify no enrollment secret or raw auth token is sent and no response is accepted without a valid fresh proof. Verify the paired daemon still supports pairing and popup operations.

**Acceptance Scenarios**:

1. **Given** a fake listener answering `/pair`, **When** the extension or popup attempts pairing, **Then** it rejects the response and does not store or use the returned token.
2. **Given** a fake listener answering `/status` or `/kill`, **When** the popup requests status or disconnects an agent, **Then** it rejects the response and does not treat the operation as successful.
3. **Given** a paired daemon, **When** the extension performs pairing and the popup performs status or disconnect requests, **Then** each operation succeeds after the daemon is authenticated.

### User Story 3 - Diagnose port conflicts without trusting the port owner (Priority: P2)

When the daemon cannot bind its configured port, it must distinguish a verified Browser Controller daemon from an unknown process without disclosing the enrollment secret, and it must never terminate the other process automatically.

**Why this priority**: Port conflict recovery is a separate path that currently probes the port with the enrollment secret.

**Independent Test**: Start fake and genuine local HTTP listeners in isolated tests and verify only the genuine listener is identified as the daemon; neither the bridge nor the lifecycle script sends the secret to the fake listener or kills it.

**Acceptance Scenarios**:

1. **Given** an unknown listener, **When** startup checks the occupied port, **Then** it reports an unverified process and leaves it running without sending the enrollment secret.
2. **Given** the genuine daemon on the port, **When** startup checks the occupied port, **Then** it identifies the daemon only after validating its proof.

### Edge Cases

- The extension has no stored enrollment secret, has an outdated secret, or receives a rotated secret from the supported local pairing host.
- A daemon restarts during an authentication exchange, or a challenge is expired, reused, malformed, or bound to a different request.
- A listener returns a correct protocol shape with altered identity, capabilities, response body, or status code.
- Multiple extension profiles connect concurrently and each must receive an independent connection challenge.
- A legacy daemon or extension cannot authenticate using the new protocol.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The extension MUST authenticate the daemon's identity before accepting its greeting, acknowledging the peer, adopting daemon state, or processing control messages.
- **FR-002**: Authentication MUST use fresh, connection-bound proof so a proof from an earlier connection cannot authenticate a new connection.
- **FR-003**: The daemon MUST authenticate the extension before marking its connection ready or routing browser-control requests.
- **FR-004**: Missing, malformed, invalid, expired, or replayed authentication proofs MUST fail closed before browser state changes or tool dispatch.
- **FR-005**: Pairing, status, and agent-disconnect HTTP operations MUST authenticate both the request and the daemon response before using returned data or reporting success.
- **FR-006**: The enrollment secret and raw authentication token MUST NOT be sent to an unverified peer, placed in a URL, query string, WebSocket subprotocol, or diagnostic log.
- **FR-007**: Background startup, popup actions, port-conflict detection, and daemon lifecycle checks MUST use the same authenticated trust boundary; no path may send the raw enrollment secret to the port owner.
- **FR-008**: Port-conflict handling MUST identify an existing daemon only after proof verification and MUST NOT terminate an unknown process.
- **FR-009**: Supported manual and native pairing, reconnect, popup status, and agent-disconnect behavior MUST remain available with matching protocol versions.
- **FR-010**: Unsupported protocol versions MUST be rejected with a clear recovery message and without falling back to unauthenticated behavior.

### Key Entities

- **Daemon identity**: The paired local service instance whose identity is verified before the extension trusts it.
- **Connection challenge**: Fresh, single-use data that binds an authentication proof to one daemon connection or HTTP operation.
- **Authentication proof**: A value that demonstrates possession of the shared pairing material without transmitting that material.
- **Enrollment secret**: The local pairing material already stored by the supported pairing flow and used to establish trust.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: All simulated forged, missing, malformed, stale, and replayed daemon proofs are rejected before any browser handler, state-adoption path, or tool-dispatch path runs.
- **SC-002**: In regression tests for pairing, status, agent disconnect, port-conflict probes, and lifecycle checks, the enrollment secret and raw auth token appear in zero request URLs, headers, WebSocket subprotocols, or logs.
- **SC-003**: A correctly paired extension and daemon complete authentication and retain pairing, reconnect, popup status, and agent-disconnect behavior.
- **SC-004**: Port-conflict checks identify a daemon only when its proof validates, report other listeners as unverified, and never terminate them.
- **SC-005**: Targeted security regressions, the full test suite, lint, typecheck, and build pass without weakening existing checks.

## Assumptions

- The extension obtains the enrollment secret through the existing supported native messaging host or the user's popup settings; this feature does not introduce another secret-storage mechanism.
- The extension and daemon are updated together. A peer that does not support the authenticated protocol is rejected rather than silently downgraded.
- Tests use isolated local listeners and synthetic credentials; they do not inspect or use the user's real browser profile or credential files.
- Local implementation and checks do not constitute Owner or CI acceptance for merging a CRITICAL security change.
