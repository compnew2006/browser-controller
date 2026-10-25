# Implementation Plan: خزنة تسجيل الدخول بطريقة Hermes

**Branch**: `codex/001-credential-vault` | **Date**: 2026-10-25 | **Spec**: [spec.md](spec.md)  
**Execution model**: GPT-6 Luna, reasoning effort `xhigh`; parent coordinates and reviews.  
**Status**: Ready for implementation; none of the runtime acceptance criteria are claimed passed.

## Summary

Implement a local encrypted login vault, opaque-handle browsing operations, private extension-owned credential entry, exact-origin fill, session/profile grants, and disclosure controls. Preserve Hermes's interaction pattern while using the existing TypeScript daemon and Chrome extension. The daemon owns plaintext resolution; the MCP process only sends handles and receives sanitized results. V1 excludes TOTP, external managers, payment data, OS-key storage, and Hermes file interoperability.

## Technical Context

- **Language/Version**: Node >=20, strict TypeScript MCP/daemon; plain JavaScript MV3 extension.
- **Primary Dependencies**: existing MCP SDK, zod, ws; Node `crypto` and `fs` for authenticated encryption and protected storage. No new runtime dependency is needed for the proposed AES-256-GCM envelope.
- **Storage**: existing `STATE_DIR` from `mcp-server/src/daemon-config.ts`, with a protected `vault/` subtree; browser namespace derived from a digest of the verified connection identity, never an unchecked path component.
- **Testing**: existing Vitest; lint/typecheck/build; temporary directories and synthetic credentials; actual MCP calls and a disposable Chrome/localhost fixture for integration.
- **Target Platform**: current macOS + local Chrome. POSIX permission checks apply here; unsupported permission enforcement on another OS must be documented and fail clearly rather than claimed secure.
- **Project Type**: existing stdio MCP client -> local IPC daemon -> authenticated loopback WebSocket -> extension; vault inspection/fill use bounded isolated-world `chrome.scripting` calls targeted to verified document IDs.
- **Performance Goals**: local fixture p95 <=2s for ready list/fill; private user input is asynchronous and excluded from that latency.
- **Constraints**: no project secrets/.env edits, no real credential extraction, no restart of the user's live daemon or real-account testing, no commits/pushes unless separately authorized.
- **Scale/Scope**: local login entries per connected browser identity; several MCP sessions and Chrome profiles; conservative bounded payloads and no automatic replay of writes.

## Constitution Check

No repository `.specify/memory/constitution.md` exists. Applicable gates are the user's standing instructions, `SECURITY.md`, existing transport contracts and this spec. Installed Spec Kit templates are used without installing an unrelated CLI or rewriting instruction files.

| Gate | Decision |
| --- | --- |
| Preserve work | Existing `.codebase-memory` changes remain untouched; feature is on `codex/001-credential-vault`. |
| Architecture | Extend current daemon/extension paths; keep secret handling out of public tool parameters. |
| Security | Private user entry, explicit grants, exact-origin checks, no retries, output protection and recovery are release gates. |
| UI | Implementer must read Impeccable and preserve the extension's design; keyboard/accessibility/private-field states are required. |
| Verification | Use synthetic data and isolated local fixture/browser; report blockers and unmet SCs accurately. |
| Scope | Local logins only; future integrations are not implemented speculatively. |

## Phase 0: Research decisions

Detailed decisions and primary sources: [research.md](research.md). Key choices are a versioned native AES-GCM envelope, daemon-owned vault service, extension-owned secret UI, one-shot internal fill, a shared per-browser result redactor and fail-closed protected-document state. The Hermes behavior is copied; its Python/Fernet file format is not an interoperability requirement.

## Phase 1: Design and contracts

Entities and transitions: [data-model.md](data-model.md). Public/internal contracts: [contracts/vault.md](contracts/vault.md). Runtime verification: [quickstart.md](quickstart.md). Dependency-ordered work: [tasks.md](tasks.md).

### Data and ownership

The daemon is the single normal owner of vault writes and grants. Store credentials under a versioned AES-256-GCM envelope with fresh 12-byte nonce per write, 32-byte random key, 16-byte authentication tag, and authenticated version/namespace metadata. Use built-in crypto primitives; do not build an ad-hoc cipher or claim Fernet compatibility. Directory mode `0700`, files `0600`, no-follow/exclusive creation and ownership/type checks are required. Keep all fields, including identifiers, inside the encrypted envelope at rest.

Use exclusive bounded locking and atomic same-directory writes/rename with durability appropriate to the filesystem. Check key existence separately from empty initialization: existing ciphertext + absent/invalid key must never initialize a new vault. Bound file/envelope size and validate decrypted schema. Concurrent writes must not lose completed changes. Backups are explicit user operations containing ciphertext and the required key material in a protected directory; treat that entire directory as a credential. Restore validates a complete snapshot before replacing the live state, preserves the previous complete state, and rejects concurrent active mutations. No plaintext export.

### End-to-end flow

1. MCP `browser_vault` accepts only operation, tab ID, opaque handle/request ID and an optional non-secret label. The daemon derives session and chosen extension from existing routing; it never trusts a browser/session identifier supplied as a tool parameter.
2. Metadata inspection runs in the selected extension against a live tab/document/frame, returning the verified origin and a short-lived target nonce without values. V1 accepts HTTPS and loopback-only HTTP fixtures; it inspects same-origin frames and open shadow roots. Unrelated cross-origin widgets are ignored, while a target inside a cross-origin frame cannot be selected or filled. Ambiguous and new-password controls are refused.
3. Missing grant/account creates an asynchronous private request. The extension opens a non-web-accessible `vault/vault.html` page. It displays verified site/profile/session context. Only messages from this exact extension page can submit management operations; content scripts, web pages and public MCP tools cannot.
4. A private reverse request on the already-authenticated extension connection addresses the daemon's vault service. Pending request IDs are one-use, expire after five minutes, and bind to the live initiating session, browser, tab and document. No human wait occupies a tab mutex. UI cancel/close/expiry is terminal for that request.
5. The user grants account/site access for this session or chooses Save & fill. Revalidate the live context after user input. Resolve the secret only after grant, origin and target preflight succeed. Register literal and normalized values for output redaction before injection; mark the extension document protected before writing.
6. Send a dedicated non-public, non-retryable fill message to the extension. Existing tab mutex/ownership and AbortSignal semantics remain effective. Do not retain secret payloads in retry maps or generic call history. A bounded isolated-world page function targets the verified `documentId`, rechecks the expected origin and nonce-stamped connected visible enabled current-password control immediately before one write, and never rebinds a stale target. A cancellation after dispatch releases the mutex and returns an unknown outcome; the page-side deadline prevents a queued script from writing after expiry.
7. Return safe metadata only. Username/identifier is model-visible metadata, as in Hermes; it can be entered using ordinary input tools. Password fill itself never clicks submit, but input events/site auto-submit are documented.
8. Scrub all public daemon replies and errors before IPC, including nested and batch results. The MCP process must never receive resolved secret bytes. UI RPC and internal fill frames are separate from public result serialization.

### Protected-document policy

- Register protections before fill; store only non-secret taint metadata in extension session storage so worker recycle does not silently reset them.
- While any protected or uncertain context exists in a browser profile, refuse `browser_evaluate`, screenshots, response mocks, and raw log/network disclosures before execution. This profile-wide restriction accounts for page references between same-origin tabs and active-window screenshots. The vault's internal inspected fill is separately allowed. Normal snapshot/text/interactions can continue through existing field masking plus daemon-level exact-value redaction.
- Guard nested batch calls using the same path, not a top-level name check alone. The extension vault UI is always protected from page tools/screenshots.
- Hash/history SPA changes never clear taint. BFCache/document restoration and tab-ID reuse must not inherit the wrong state. A full new document can be used only after its identity is established; restored sensitive documents remain protected.
- Vault lock/delete revoke access without clearing live-document protection. After daemon restart or lost protection registry, persistently marked documents fail closed for content-producing tools until protection is safely reconstructed or the old context is discarded. Do not persist a plaintext redaction registry.
- Exact-value redaction is defense in depth, not proof against arbitrary encodings or a compromised destination page. Other clients' filesystem/shell access remains outside this MCP server's enforcement.

### UI and private operations

Use a dedicated extension-owned page for add/update/remove, pending grants, lock/unlock, backup/restore. Password fields stay masked; existing secrets are never sent back to prefill an edit form. Users replace a password rather than reveal it. No secret in `chrome.storage`, page URLs, clipboard, generic form elicitation or console. Permission confirmation may reuse existing non-sensitive approval patterns; the secret entry itself must remain outside the MCP client's form channel. Local lock is an application access state, not a passphrase-derived disk-encryption guarantee.

### Project Structure and impact

| Area | Planned files | Dependencies and safeguards |
| --- | --- | --- |
| Vault store/service/redaction | New `mcp-server/src/vault/{store,store-format,store-errors,service,service-common,service-core,service-private,service-protection,redaction,types}.ts` | Inject temp roots/clocks for tests; use existing `STATE_DIR`; keep encryption/backup formats and service authorization transitions in focused modules. |
| Public tool/registry | New `mcp-server/src/tools/vault.ts`; existing `tools/index.ts` | Strict schemas; safe operations only; registry manifest/timeout/drift tests updated together. |
| Daemon and bridge | `daemon.ts`, `vault/daemon-routing.ts`, `bridge.ts`, `vault/bridge-transport.ts`, `bridge-connections.ts`, protocol/type modules discovered from their imports | Route vault before generic forwarding, derive connection/session, sanitize every public result/error, handle private UI RPC separately, no automatic retry. |
| Private fill/protection | `extension/lib/vault.js`, `extension/lib/router.js`, `extension/events.js` | Uses `chrome.scripting` isolated-world calls with verified `documentIds` because the fill must retain exact target frame identity; same-origin frames/open shadow roots, per-tab ownership/mutex, cancellation and page-side deadline. Internal wire actions are excluded from public registry manifest. |
| Extension routing/lifecycle | `extension/lib/router.js`, `extension/lib/connection.js`, `extension/lib/vault-connection.js`, `extension/lib/connection-policy.js`, `extension/events.js`, `extension/background.js` | Same guards for normal/batch calls; exact sender allowlist for private UI messages; session/document lifecycle hooks. |
| Vault path upload protection | `mcp-server/src/tools/fill.ts`, `mcp-server/src/vault/protected-paths.ts`, daemon boundary | Reject canonical vault files, snapshots and symlink aliases before forwarding local file-upload requests. |
| UI | New `extension/vault/{vault.html,vault.js,vault.css}`; `extension/popup/popup-vault.js` and popup entry | Read Impeccable before edits; preserve design and masked entry, no new broad permissions. |
| Verification | `tests/vault-*.test.ts`, targeted existing registry/router/daemon/transport tests, `scripts/smoke-vault-isolated.mjs` | Synthetic credentials only; no live account logins or existing secret reads. |
| Documentation | `README.md`, `SECURITY.md`, this feature's spec/tasks/verification record | Accurate limits, local-key backup risk, private UI workflow, future features clearly deferred. |

Existing semantic graph located the authoritative symbols `ExtensionConnections.forSession`, `ExtensionBridge.sendToolCall`, `wrapHandler`, and `handleScreenshot`. Direct source verified string-based routing, `allTools`, `HANDLERS`, and result serialization. Additional confirmed impact includes `extension/lib/vault.js`, `extension/lib/connection.js`, `extension/events.js`, `mcp-server/src/tools/fill.ts`, and the isolated browser fixtures; those files are now listed in the plan/tasks. No whole-repository graph rebuild is required for this documentation phase.

## Phase 2: Implementation and verification gates

Execute [tasks.md](tasks.md) with GPT-6 Luna xhigh. Keep requirements-quality checkmarks separate from implementation tasks. Each runtime SC needs evidence in a verification record; do not mark a task complete from source inspection alone when it requires execution.

| Criteria | Required evidence |
| --- | --- |
| SC-001/008 | Real MCP localhost fixture, 20 fills, per-call timings and p50/p95; exclude readiness/user waits. |
| SC-002/005 | Wrong-origin/frame/nonce, revoked grant, two sessions and browser identities; assert no writes. |
| SC-003/004 | Sentinel search over public replies/errors/logs/persisted test files; normal/nested calls, reveal-password screenshot denial, evaluate denied before side effects, restart/SPA/BFCache coverage. |
| SC-006 | Rendered private UI keyboard/focus/masked fields/RTL-LTR/error states; report actual browser MCP and disposable profile identity. |
| SC-007 | Fault-injected atomic write, concurrent saves, corrupt key/ciphertext, backup restore, timeout/cancel with no automatic replay. |
| Regression gates | Targeted meaningful tests, then `npm test`, `npm run typecheck`, `npm run build`, `npm run lint`; inspect failures before retrying. |

Repository-wide tests are not a security proof. Complete a diff review for authorization bypasses, reflected errors, secret-bearing buffers and unprotected output paths. Refresh code knowledge through its supported mechanism after source relationships change; preserve pre-existing graph artifact changes.

## Complexity Tracking

Private UI RPC and protected-document state add complexity because public MCP parameters and arbitrary browser output cannot carry secrets safely. The existing authenticated connection is reused; no new service/port/framework is introduced. No root constitution or client instruction file is generated because this repository has no local Spec Kit bootstrap and the user's standing instructions already provide the governing rules.
