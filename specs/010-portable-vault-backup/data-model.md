# Data Model: Portable Credential Vault Backup

## Portable archive v1

The archive is a strict, bounded JSON envelope. Its serialized UTF-8 byte length is at most 10 MiB.

```text
PortableArchiveV1 {
  format: "browser-controller-vault-portable"
  version: 1
  kdf: { name: "scrypt", N: 32768, r: 8, p: 1, salt: canonical-base64-16-bytes }
  cipher: {
    name: "aes-256-gcm",
    nonce: canonical-base64-12-bytes,
    tag: canonical-base64-16-bytes,
    ciphertext: canonical-base64
  }
}
```

The KDF profile is fixed and must match exactly before derivation. `format` and `version` are authenticated as AES-GCM additional authenticated data. The envelope contains no source browser namespace, local key, account IDs, audit events, or temporary grants.

## Decrypted payload v1

```text
PortableVaultDataV1 {
  version: 1
  entries: PortableCredential[]      // 0..1000
  allowlist: PortableAllowlistEntry[] // 0..200
}

PortableCredential {
  kind: "login"
  label: string                       // 1..120 characters
  identifier: string                  // 1..320 characters
  password: string                    // 1..4096 characters
  origin: canonical HTTPS or supported loopback HTTP origin
  createdAt: nonnegative integer
  updatedAt: nonnegative integer
}

PortableAllowlistEntry {
  origin: canonical HTTPS or supported loopback HTTP origin
  addedAt: nonnegative integer
}
```

Portable credential IDs are omitted; import creates fresh destination IDs. Reject unknown fields, malformed/canonicalization-invalid origins, invalid field lengths, out-of-range counts, duplicate accounts keyed by canonical `(origin, identifier)`, and duplicate allowlist origins. Do not silently drop or merge input rows. Preserve source timestamps for valid entries.

## Private transfer session

```text
TransferSession {
  transferId: random unguessable identifier
  connectionId: initiating extension connection
  direction: "export" | "import"
  encryptedArchive: in-memory bytes (0..10 MiB)
  receivedOrSentOffset: integer
  createdAt: timestamp
  lastActivityAt: timestamp
  hardExpiresAt: timestamp
  state: "receiving" | "ready" | "previewed" | "sending"
}
```

Constraints: one active session per connection; at most two sessions and 20 MiB aggregate encrypted archive bytes across the daemon. Chunks are no larger than 256 KiB raw, offsets are contiguous, IDs are connection-bound, and sessions expire after two minutes idle or five minutes absolute. Buffers are cleared on every terminal path.

## Import preview token

```text
ImportPreview {
  token: random unguessable identifier
  transferId: reference to retained encrypted import archive
  connectionId: initiating extension connection
  entryCount: integer
  allowlistCount: integer
  expiresAt: timestamp (no more than five minutes after preview)
}
```

Only the counts and opaque token are returned to the page. The decrypted payload and derived key are not retained for preview. Commit requires the passphrase again and repeats decryption and validation.

## Destination vault state

The existing `VaultData` remains version 1. A successful import builds new `entries` from the portable payload with fresh IDs, replaces `allowlist`, preserves destination `audit` up to the existing 500-event retention cap, and appends a local `restore` event. The complete candidate envelope is checked against the existing 8 MiB store-file cap before a snapshot is created. A recovery snapshot of the pre-import destination is created before commit; an empty destination receives a recoverable encrypted empty-state snapshot under a fresh key after confirmation. The existing destination key and namespace remain authoritative for a ready destination. An incomplete destination cannot enter preview commit.

## State transitions

```text
Export: unlocked -> archive generated -> chunks sent -> download created -> buffers cleared
Import: file selected -> encrypted chunks staged -> passphrase validated -> counts previewed
        -> owner confirms -> passphrase re-entered -> archive revalidated -> snapshot -> atomic replace
Cancel/expiry/disconnect before replace: staged ciphertext cleared; destination unchanged
Failure after journaled replacement begins: existing vault recovery flow remains authoritative
```
