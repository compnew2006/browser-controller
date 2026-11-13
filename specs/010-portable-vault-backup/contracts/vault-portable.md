# Private Vault Portable Backup Contract

This is an internal private UI protocol carried by the existing authenticated `vaultUiRequest` / `vaultUiResponse` messages. It is not an MCP tool contract. All operations require a live vault-capable extension connection and are bound to that connection's browser identity. Unknown fields are rejected.

## Common rules

- Every request includes `operation`; each operation accepts only the fields listed below.
- All transfer IDs and preview tokens are random and scoped to the initiating `connectionId`.
- `MAX_ARCHIVE_BYTES = 10 * 1024 * 1024`; `MAX_CHUNK_BYTES = 256 * 1024` raw bytes.
- Chunk payloads use canonical standard base64. Offsets are byte offsets and must equal the next expected offset. No sparse, repeated, overlapping, or out-of-order chunks are accepted.
- At most one transfer per connection and two transfers / 20 MiB total are active. A transfer expires after two minutes idle or five minutes absolute. An import preview token expires within five minutes.
- Responses never include plaintext account rows, passwords, local keys, passphrases, raw stack traces, or file contents except the requested encrypted export chunk.
- Safe error responses use existing public error formatting; no secret value appears in the bridge log. Failure before commit leaves the destination unchanged.

## Export

1. `portableExportStart`

   Request: `{ operation, passphrase }`

   Requires an unlocked, complete vault and a passphrase of 12–1024 UTF-8 bytes / at least 12 Unicode code points. The UI confirms matching passphrase fields before sending. The daemon projects only accounts and always-allowed sites, creates the fixed-profile AES-256-GCM archive, and retains the encrypted archive in the bounded transfer session.

   Response: `{ success: true, transferId, byteLength, chunkBytes: 262144 }`

2. `portableExportChunk`

   Request: `{ operation, transferId, offset }`

   Response: `{ success: true, offset, chunkBase64, done }`

   Each response is at most 256 KiB raw before base64 expansion. Chunks are served sequentially. The last chunk completes and clears the transfer session. The UI creates a Blob only after the expected total length is received, then presents a separate **Save portable copy** button. That button creates the user-triggered download and revokes the object URL after save or cancel.

3. `portableTransferCancel`

   Request: `{ operation, transferId }`

   Response: `{ success: true, status: "cancelled" }`

   Cancellation is idempotent for a session owned by the current connection and clears its in-memory archive.

## Import

1. `portableImportStart`

   Request: `{ operation, byteLength }`

   Rejects zero, unsafe integer, over-limit, or unavailable transfer requests before accepting file data.

   Response: `{ success: true, transferId, chunkBytes: 262144 }`

2. `portableImportChunk`

   Request: `{ operation, transferId, offset, chunkBase64 }`

   Response: `{ success: true, nextOffset, complete }`

   Rejects noncanonical base64, chunks over the cap, incorrect offsets, bytes beyond the declared length, or incomplete final length. Stores encrypted archive bytes only.

3. `portableImportPreview`

   Request: `{ operation, transferId, passphrase }`

   Fully parses, decrypts, and validates the archive, then clears temporary plaintext and key buffers. A wrong passphrase and authentication failure return the same safe invalid-archive response.

   Response: `{ success: true, importToken, entryCount, allowlistCount, expiresAt }`

   No destination files are changed. The encrypted archive stays staged in memory, and the passphrase input is cleared by the UI.

4. `portableImportCommit`

   Request: `{ operation, importToken, passphrase }`

   Called only after the page presents counts, explicitly says the destination accounts and always-allowed sites will be replaced, and the owner confirms. The owner re-enters the passphrase. The daemon re-decrypts and validates the archive, refuses incomplete or pending-recovery state, and verifies an existing destination is unlocked. It builds the full destination data with retained local audit history and a local restore event, and rejects a resulting envelope above the existing 8 MiB store-file cap before taking a snapshot. For an empty destination it creates a fresh local key and protected empty-state snapshot after confirmation. It then atomically applies the data under the destination key/namespace. Audit follows its existing 500-event retention cap. It revokes runtime grants after a successful replacement and clears staged archive bytes.

   Response: `{ success: true, status: "imported", entryCount, allowlistCount }`

5. `portableTransferCancel`

   Cancels an upload or preview and clears its encrypted archive. Closing the vault page, connection loss, expiry, or daemon shutdown also clears session buffers. A cancel, wrong passphrase, unsupported/corrupt file, or incomplete destination does not mutate the vault.

## UI requirements

- State which data is exported and excluded; warn that forgetting the passphrase makes that file unrecoverable.
- Require export passphrase confirmation and a visible strength/length hint without imposing character-class rules.
- Show import account/site counts and replacement consequences before confirmation.
- Provide progress, cancellation, disabled states while an operation is active, and a clear completion/error message.
- Never write archive data or passphrases to extension storage, the clipboard, or logs. Clear password controls on success, error, and cancellation.
