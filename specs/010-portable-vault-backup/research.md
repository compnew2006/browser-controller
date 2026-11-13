# Research: Encrypted Portable Credential Vault Backup

## Decision: Keep the feature on the existing private vault path

The extension vault page already sends owner-only operations through `vaultUiRequest`; the daemon validates them in `VaultServicePrivate`, while `VaultBridgeTransport` binds each request to the live extension connection. Add portable operations there. Do not add a `browser_vault` action, public MCP schema, or a route that makes credentials available to agent sessions.

**Rationale:** Existing private UI traffic is isolated from normal agent-facing tool results, and the bridge logs the operation/outcome without logging request payloads. The same path already verifies vault capability and current browser connection identity.

**Alternatives considered:** A public MCP export/import tool was rejected because it would expose a credential export surface to agent callers. A direct extension-to-file implementation was rejected because the extension should not own vault decryption or destination mutation.

## Decision: Use a separate, versioned portable envelope

Create a strict format independent of `BackupPackage`. The current local recovery package embeds the device-local key and a browser namespace and is intentionally recoverable by anyone who gets that local file; it is not portable. The new archive uses a user passphrase, contains no device key or source namespace, and authenticates a versioned envelope with AES-256-GCM.

Use Node's built-in asynchronous `scrypt` with fixed parameters (`N=32768`, `r=8`, `p=1`, 64 MiB maximum memory) and a random 16-byte salt. Derive a 32-byte key and encrypt with AES-256-GCM using a random 12-byte nonce and a 16-byte authentication tag. Authenticate the archive format/version as AAD. Require at least 12 Unicode code points for the passphrase, cap its UTF-8 representation at 1,024 bytes, and confirm it on export. The parser accepts only the exact supported KDF/cipher profile; it never uses parameters selected by an untrusted file.

**Rationale:** This uses the repository's existing runtime and crypto primitives, avoids dependency or install changes, and lets the file be decrypted on another supported device. Fixed KDF parameters prevent attacker-controlled work factors from turning a small archive into an unbounded CPU/memory request.

**Alternatives considered:** Reusing the local AES key was rejected because it ties the copy to one profile. Storing the passphrase or a derived key was rejected because it would make the file recoverable without the owner's secret. Adding a cryptography package was rejected because Node already provides the required primitives and new dependencies are unnecessary.

## Decision: Transfer archive data in bounded private UI chunks

The WebSocket bridge has a 1,000,000-byte soft inbound-frame cap while portable archives may be 10 MiB. Transfer at most 256 KiB of raw bytes per request, base64 encoded, with strict transfer IDs, canonical encoding, exact sequential offsets, byte totals, and connection ownership. Keep at most one active transfer per extension connection and two transfers / 20 MiB total in daemon memory. Use a five-minute hard lifetime and two-minute idle timeout. Clear data on completion, cancel, expiry, UI close, or connection drop.

**Rationale:** 256 KiB expands to roughly 350 KiB of base64 plus protocol overhead, comfortably below the current frame cap without changing shared WebSocket policy. Small chunks also keep progress and disconnect handling simple.

**Alternatives considered:** Increasing the shared frame limit was rejected because it changes all browser traffic and buffering risk. Persisting upload chunks was rejected because archive content should not create a new durable sensitive store. One giant RPC was rejected because it exceeds the existing frame limit.

## Decision: Preview using encrypted bytes, then re-enter the passphrase at commit

Import upload stores only the encrypted archive in a short-lived, connection-bound memory buffer. Preview decrypts and validates it, returns account/site counts and an opaque token, then clears derived key and plaintext buffers. The UI clears its passphrase input. After explicit replacement confirmation, the UI asks for the passphrase again; commit decrypts and validates again before any vault mutation.

**Rationale:** The owner gets a useful summary before destructive replacement while decrypted credentials and the passphrase do not remain staged during the decision pause. Revalidation closes the gap between preview and commit.

**Alternatives considered:** Retaining decrypted records or the passphrase until confirmation was rejected because it unnecessarily extends secret lifetime. Returning full account metadata in preview was rejected because counts are enough for the approved scope and avoid an additional credential display surface.

## Decision: Reuse store validation, local snapshots, and atomic writes

Validate decrypted account/site data with the existing vault constraints, including the existing account and allowlist caps and canonical-origin rules. Reject duplicates instead of silently merging or dropping records. Build the complete destination `VaultData`, including retained destination audit history and the local `restore` event, and preflight its encrypted envelope against the existing 8 MiB store-file cap before snapshotting. Before replacing a valid unlocked destination, create the existing protected local recovery snapshot under the destination namespace. For an empty destination, create a protected empty-state snapshot with a fresh local key after confirmation and before replacement. Apply imported accounts and allowlist under the destination key and namespace; assign new credential IDs. Keep audit history within its existing 500-event retention limit. The archive never transports audit history or temporary grants. Refuse incomplete or pending recovery state; revoke current runtime grants after a successful replacement.

**Rationale:** Local recovery format and write protections already have tested behavior. Reusing those limits and atomic file replacement avoids format migration and prevents cross-profile key reuse. Preserving local audit makes the archive's exclusion of history independent from a destructive import, and imported account IDs need not reveal source-profile identifiers.

**Alternatives considered:** Replacing all `VaultData`, including destination audit history, was rejected because audit is not portable data and erasing the destination's local history is unnecessary. Merging accounts was rejected by FR-012. Changing the vault schema/version was rejected because the archive is a separate format and the local vault format does not need a migration.

## Decision: Use a user-triggered browser download without extra permissions

The private page assembles verified export chunks into a Blob, then presents a separate **Save portable copy** button so the actual download follows a fresh user click; it releases its object URL after the save or cancel. The browser's configured download flow determines the save location. Import reads the user-selected file locally and sends only encrypted bytes through the existing private UI channel. Do not add Chrome's `downloads` permission or write the file to a daemon-selected path.

**Rationale:** A Blob URL supports an explicit save action within the existing extension page and avoids broadening extension permissions or choosing a path on the owner's behalf.

**Alternatives considered:** Adding `downloads` permission was rejected because it is not needed for a user-initiated page download. A daemon-side path picker was rejected because it expands platform-specific behavior and stores a copy outside the owner's chosen browser flow.

## Current code evidence

- `mcp-server/src/vault/store.ts`: profile-scoped namespace, `VaultDataSchema`-validated encrypted store, 8 MiB live store cap, 10 MiB local backup cap, local snapshot creation, staged restore writes, and a recovery journal.
- `mcp-server/src/vault/store-format.ts`: AES-256-GCM local envelope bound to the browser namespace; local `BackupPackage` contains a base64 local key and is namespace-bound.
- `mcp-server/src/vault/types.ts`: account, canonical origin, audit, allowlist, and vault-entry limits; existing audit action `restore` can record successful replacement without schema migration.
- `mcp-server/src/vault/service-private.ts`: owner-only operation dispatch, vault lock checks, private backup/restore behavior, and strict request-key validation.
- `mcp-server/src/vault/bridge-transport.ts`: capability and connection checks, private request dispatch, payload-free operation/outcome logs, and connection-drop handling.
- `mcp-server/src/bridge-frames.ts`: 1,000,000-byte soft inbound limit and 16 MiB hard limit; the global frame limits remain unchanged.
- `extension/vault/vault-page.js` and `vault.html`: existing settings controls and private `rpc()` helper.
- `extension/manifest.json`: no `downloads` permission; user-triggered Blob save does not require a permission change.
- `tests/vault-store.test.ts`, `tests/vault-service.test.ts`, `tests/bridge-vault.test.ts`, and `tests/extension-vault.test.ts`: existing vault/store, private dispatch, bridge, and extension regression suites.

## Remaining uncertainty

No unresolved product-scope question remains. The file format is versioned so future cipher/KDF changes require an explicit new supported version/profile rather than silently accepting parameters from an archive.
