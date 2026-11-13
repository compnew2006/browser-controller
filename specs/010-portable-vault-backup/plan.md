# Implementation Plan: Encrypted Portable Credential Vault Backup

**Branch**: `010-portable-vault-backup` | **Date**: 2026-11-12 | **Spec**: [spec.md](spec.md)

**Input**: Approved feature specification for passphrase-protected export/import across browser profiles and devices.

## Summary

Add portable export/import to the existing private Credential Vault page. The daemon creates a versioned archive from accounts and always-allowed sites, encrypts it with a user passphrase using Node's built-in `scrypt` and AES-256-GCM, then transfers it over the authenticated private vault UI channel in bounded chunks. Import validates and previews the encrypted file before confirmation, revalidates it at commit, preserves the destination's local audit history, creates a local recovery snapshot, and replaces only the portable data under the destination's own local vault key. The public MCP surface and local recovery backup format do not change.

## Technical Context

**Language/Version**: TypeScript/JavaScript ESM; Node.js `^22.18.0 || ^24.11.0 || >=26.0.0`.

**Primary Dependencies**: Existing `zod`, `ws`, and Node built-in `node:crypto`, `node:fs`; no dependency changes.

**Storage**: Existing browser-scoped encrypted vault files and local recovery snapshots under the daemon state directory. Portable archive bytes and transfer state are transient memory only.

**Testing**: Vitest (`npm test`), TypeScript (`npm run typecheck`), lint/build, and the required repository CI-equivalent checks from `AGENTS.md`.

**Target Platform**: Chrome MV3 extension paired with the local Node.js MCP daemon on supported desktop platforms.

**Project Type**: Browser extension + local TypeScript MCP daemon.

**Performance Goals**: Support archives up to 10 MiB without exceeding the existing 1,000,000-byte soft WebSocket frame limit; encrypt/decrypt asynchronously so the daemon event loop remains responsive.

**Constraints**: Private UI channel only; no public MCP tool or schema receives passphrases or archive contents. Use bounded 256 KiB raw chunks, strict offsets and connection ownership, and expiring in-memory transfers. No permission or dependency additions. Passphrases, plaintext credentials, and local vault keys must not enter logs or persistent browser storage.

**Scale/Scope**: One active portable transfer per extension connection and at most two active transfers / 20 MiB total across the daemon; 10 MiB maximum archive; existing vault limits of 1,000 accounts and 200 allowlisted sites remain authoritative.

## Acceptance Criteria

- **AC-1**: An unlocked vault exports a passphrase-protected archive containing all accounts and always-allowed sites, but no plaintext credentials, source account IDs, local key, namespace, audit history, or temporary grants.
- **AC-2**: A valid archive previews account/site counts without changing destination data; only an explicit confirmation followed by passphrase re-entry commits the replacement.
- **AC-3**: Successful import assigns fresh destination IDs, preserves destination-local audit history, revokes runtime grants, and leaves a local recovery snapshot before replacement.
- **AC-4**: Wrong passphrase, malformed/tampered/truncated/unsupported/oversized files, duplicate records, destination recovery/size-limit failures, cancellation, timeout, and incomplete chunks fail without partial mutation.
- **AC-5**: 10 MiB archives use bounded private chunks below the existing WebSocket frame cap; transfers are connection-bound, expire, and clear encrypted/plaintext/key buffers on terminal paths; no secret enters the public MCP surface, persistent extension storage, or logs.

## Constitution Check

The root `constitution.md` and `.specify/memory/constitution.md` declare the constitution **proposed / pending** rather than adopted. The mirror's recorded source fingerprint matches the root file's SHA-256 (`2b2d4700e6364c1e898c90ddaff5923393bc977d605353286624c1d7b7f40b17`). No proposed constitution gate is treated as adopted policy.

Applicable checks from the user instructions and `AGENTS.md`:

- Keep archive encryption and file parsing inside the daemon; private UI is the only entry point.
- Validate all untrusted file data and transport chunks; fail before mutating the destination.
- Preserve current files and keys, use existing vault validation, snapshots, and transactional write patterns, and add regression tests.
- Do not add a public credential-reading/export tool, log secrets, persist passphrases, or add dependencies/permissions.
- Run affected tests, lint, typecheck, build, and the repository's required CI-equivalent checks before calling implementation complete.

**Pre-design gate**: Passed. The owner approved the spec scope. **Post-design gate**: No adopted-constitution violations identified. **Workflow gate**: The owner invoked `$speckit.tasks` after reviewing the plan; this is treated as plan approval. Task generation is authorized; implementation code remains for the following `$speckit.implement` stage.

## Design Decisions

1. **Portable archive**: A strict version-1 JSON envelope contains a fixed KDF profile, random salt, AES-GCM nonce/tag, and ciphertext. The encrypted plaintext contains only portable account fields and always-allowed sites. It contains no source namespace, local key, audit entries, grants, or source account IDs; import assigns fresh destination account IDs.
2. **Cryptography**: Use asynchronous `scrypt` with `N=32768`, `r=8`, `p=1`, a 16-byte random salt, 64 MiB `maxmem`, and a 32-byte derived key. Encrypt with AES-256-GCM, a 12-byte nonce, and a 16-byte tag. Validate the exact supported KDF/cipher profile before deriving a key; do not allow archive-supplied work factors. Bind the format/version as authenticated additional data. Require a confirmed passphrase of at least 12 Unicode code points and cap its UTF-8 encoding at 1,024 bytes.
3. **Transport**: Add private UI operations for export start/read, import start/chunk/preview/commit, and cancel. Chunk at no more than 256 KiB raw bytes, validate canonical base64 and exact monotonic offsets, bind transfers to the initiating connection, allow one active transfer per connection, expire idle transfers, and erase buffers on completion, cancellation, timeout, UI close, or disconnect. The extension never sends the complete archive in one WebSocket frame.
4. **Import preview/commit**: Preview decrypts and fully validates the archive, returns only counts and an opaque short-lived import token, and retains only encrypted archive bytes in daemon memory. Clear the passphrase input after preview. After the owner confirms replacement, ask for the passphrase again; commit decrypts and validates again so neither credentials nor the passphrase remain pending during the confirmation pause.
5. **Destination replacement**: Reject `incomplete` or pending-recovery vault state. Require a valid, unlocked destination; for an empty vault, initialize its local key/store only after explicit commit and capture a protected empty-state recovery snapshot before replacement. Build and validate the complete destination `VaultData` first, then preflight the serialized encrypted envelope against the existing 8 MiB store cap before creating the snapshot. Under the store mutation lock, take the existing protected local recovery snapshot before replacing. Reuse the store's staged key/store writes and recovery journal. Replace accounts and allowlist; retain destination-local audit entries and append the existing local `restore` audit action subject to the existing 500-event retention cap. Temporary session grants remain runtime state and are revoked on successful replacement.
6. **UI**: Extend the existing private vault settings section with export/import controls, passphrase confirmation, an import count preview, explicit destructive confirmation, progress and safe error states. After archive assembly, present a separate **Save portable copy** button so the final Blob download occurs directly under a fresh user action; the browser's configured download flow determines the save location. Release the object URL after use. Do not add the Chrome `downloads` permission. Follow the existing English vault UI and visual system.

## Project Structure

### Documentation

```text
specs/010-portable-vault-backup/
├── spec.md
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
└── contracts/vault-portable.md
```

### Source and tests

```text
mcp-server/src/vault/
├── portable-format.ts       # strict archive schema, scrypt/AES-GCM, portable data projection
├── portable-transfers.ts    # bounded, connection-bound encrypted archive transfer sessions
├── store.ts                 # snapshot-backed transactional destination replacement
├── service-private.ts       # private-only export/import operations and validation gates
└── bridge-transport.ts      # routes private transfer messages and clears sessions on lifecycle events

extension/vault/
├── vault.html               # private settings controls and accessible import preview
├── vault-page.js            # vault-state integration for portable controls
├── portable-vault-page.js   # passphrase handling, chunk loop, download, confirm and progress
└── vault.css                # settings layout and status/progress states

tests/
├── vault-portable-format.test.ts
├── vault-store.test.ts
├── vault-service.test.ts
├── bridge-vault.test.ts
```

**Structure Decision**: Keep the feature on the existing private vault connection and private extension page. Use focused archive-format and transfer-session modules, while reusing the existing vault store journal and recovery snapshot format. The bridge routes chunks and owns connection lifecycle cleanup; it does not parse or log archive contents. No new MCP tool, manifest permission, persistent storage subsystem, or dependency is added. Add/update tests alongside the existing vault and bridge suites, and review the page in an isolated Playwright profile.

## Complexity Tracking

| Design pressure | Why needed | Simpler alternative rejected because |
|---|---|---|
| Bounded chunk protocol | Existing soft frame limit is 1,000,000 bytes while archives may be 10 MiB. | Raising the shared limit expands exposure for every browser frame and queues; single-frame transfer cannot satisfy the feature cap. |
| Preview token plus passphrase re-entry | User needs a meaningful preview before confirming replacement; plaintext import data should not remain staged while they decide. | Retaining decrypted credentials or the passphrase across the confirmation pause increases sensitive in-memory lifetime. |
| Store-level transactional replacement | Import must create a destination snapshot and survive interrupted writes without resetting state. | Calling initialize/write helpers independently can leave mismatched key/store files and would duplicate existing recovery behavior. |
