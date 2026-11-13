# Feature Specification: Encrypted Portable Credential Vault Backup

**Feature Branch**: `010-portable-vault-backup`
**Created**: 2026-11-12
**Status**: Approved
**Input**: User request: “Add the ability to export and import a copy of Credential Vault data.” The user approved beginning from the feasibility recommendation: portable across browser profiles/devices, protected by a user passphrase, and replace-only for the first release.

## User Scenarios & Testing

### User Story 1 - Export a portable vault copy (Priority: P1)

As a vault owner, I can create a password-protected file from the private vault page so I can move my saved sign-ins to another browser profile or device.

**Why this priority**: A portable export is useful only if the owner can create a protected artifact that can be carried away from the original daemon without carrying the local device key.

**Independent Test**: Create a vault with synthetic accounts and always-allowed sites, export it with a passphrase, and verify the file is accepted by a second isolated browser identity while revealing no account password in the exported file.

**Acceptance Scenarios**:

1. **Given** the vault is unlocked, **When** the owner exports a copy and confirms a passphrase, **Then** a protected file is produced for the owner's chosen save location.
2. **Given** the vault is locked or unavailable, **When** the owner attempts an export, **Then** no file is produced and the page explains the required safe action.
3. **Given** an export is requested, **When** the owner reviews its contents summary, **Then** it covers saved accounts and always-allowed sites, and clearly states that audit history and temporary session grants are not included.

---

### User Story 2 - Import into another profile (Priority: P1)

As a vault owner, I can import a protected file into another browser profile and replace that profile's vault after reviewing the impact.

**Why this priority**: The main portability outcome is moving saved sign-ins between separately identified browser profiles without copying the old profile's local key.

**Independent Test**: Import a valid exported fixture into a second isolated profile, confirm replacement, and verify that saved accounts and always-allowed sites are available under the destination profile's local vault identity.

**Acceptance Scenarios**:

1. **Given** a supported file and its passphrase, **When** the owner selects the file, **Then** the page validates it and shows the number of accounts and allowed sites before any destination data changes.
2. **Given** the destination has a valid, unlocked vault, **When** the owner confirms replacement, **Then** the current vault is preserved as a local recovery snapshot before the imported data becomes active.
3. **Given** the destination has no vault, **When** the owner confirms import, **Then** the imported data becomes the destination's locally protected vault.
4. **Given** the owner has not confirmed replacement, **When** the import flow is cancelled, **Then** the destination vault remains unchanged.
5. **Given** the destination vault is incomplete or has pending recovery, **When** the owner attempts import, **Then** import is refused until the existing recovery state is resolved.

---

### User Story 3 - Recover safely from invalid or interrupted imports (Priority: P1)

As a vault owner, I can tell when a file cannot be imported and rely on the current vault remaining recoverable.

**Why this priority**: A failed import must never destroy the owner's only usable copy of their credentials.

**Independent Test**: Try a wrong passphrase, modified file, unsupported version, oversized file, and interrupted replacement against a populated temporary vault; verify the vault either remains unchanged or reports a recoverable pending state.

**Acceptance Scenarios**:

1. **Given** a wrong passphrase or altered file, **When** the owner attempts import, **Then** the import is rejected without changing the current vault.
2. **Given** an unsupported or oversized file, **When** the owner selects it, **Then** it is rejected before any vault mutation and the page gives a safe explanation.
3. **Given** the process stops during replacement, **When** the vault is opened again, **Then** the existing recovery process can restore a complete prior or imported state without silently resetting data.

---

### Edge Cases

- The owner forgets the archive passphrase; the archive cannot be imported and no recovery key is stored by the product.
- The destination vault is empty, locked, incomplete, or already has a pending recovery operation; incomplete or pending states require recovery first.
- The file is truncated, modified, malformed, from a newer unsupported version, or larger than the supported limit.
- The file was created by a different browser profile or device.
- The owner cancels after reviewing the import summary.
- The private UI or local daemon disconnects before an export or import finishes.
- Replacement is interrupted at any write stage.
- Repeated account/site entries are present in a syntactically valid archive; import must reject invalid data rather than silently merge or drop records.

## Requirements

### Functional Requirements

- **FR-001**: The owner MUST be able to export and import vault copies only through the private Credential Vault page.
- **FR-002**: An export MUST require the unlocked vault and an owner-provided passphrase confirmed before export, and MUST produce a protected file that does not contain a plaintext credential or the device's local vault key.
- **FR-003**: The portable copy MUST include saved sign-in records and always-allowed site settings. It MUST exclude temporary session grants and audit history in this release, and the UI MUST state these exclusions.
- **FR-004**: A valid portable copy MUST be importable into a different browser profile or device; imported data MUST become part of the destination profile's local vault rather than depend on the source profile identity or local key.
- **FR-005**: Before changing a destination vault, the page MUST show the account and allowed-site counts and require explicit confirmation that import replaces the destination contents.
- **FR-006**: Before replacing a valid, unlocked destination vault, the system MUST create a local recovery snapshot. An import into an empty vault MUST initialize it safely. An incomplete vault or pending recovery state MUST be resolved before import is allowed.
- **FR-007**: The system MUST validate file size, format version, structure, authentication, and data constraints before changing vault state. A rejected import MUST leave the current vault unchanged.
- **FR-008**: The system MUST reject unsupported versions, incorrect passphrases, altered/truncated files, invalid records, and files above the published size limit with safe user-facing errors.
- **FR-009**: The system MUST NOT expose credentials, archive passphrases, or local key material through agent-facing interfaces, logs, the clipboard, or persistent browser storage.
- **FR-010**: The supported portable file size MUST be bounded at 10 MiB; larger files MUST be rejected without changing vault state.
- **FR-011**: The owner MUST be told that losing the archive passphrase makes that portable copy unrecoverable.
- **FR-012**: Import in this release MUST replace the destination vault; account merging and conflict resolution are out of scope.

### Key Entities

- **Portable vault copy**: A versioned, passphrase-protected file representing saved sign-ins and always-allowed sites for transfer between profiles/devices.
- **Import preview**: A temporary summary of file validity and record counts shown before the owner confirms replacement.
- **Local recovery snapshot**: A protected recovery point of the destination vault created before a confirmed replacement.

## Success Criteria

### Measurable Outcomes

- **SC-001**: An owner can export a synthetic vault and import it into a different browser identity, preserving all exported accounts and always-allowed sites.
- **SC-002**: A supported file up to 10 MiB can be transferred through the private UI without exposing plaintext credentials to agent-facing interfaces or logs.
- **SC-003**: Wrong-passphrase, modified, truncated, unsupported-version, invalid-record, and oversized-file attempts leave the destination vault unchanged.
- **SC-004**: A confirmed replacement of a valid, unlocked non-empty vault leaves a usable local recovery snapshot of the previous vault.
- **SC-005**: An interrupted replacement recovers to a complete prior or imported state and never silently initializes an empty vault.

## Assumptions

- The requested export/import is for portability between browser profiles or devices, not merely downloading the existing same-profile recovery file.
- The owner chooses and enters a separate passphrase for each export/import; the product does not retain it. If it is lost, the portable file is unrecoverable.
- The first release replaces a destination vault after explicit confirmation; merge is deferred.
- A destination with an incomplete vault or pending recovery must complete its existing recovery flow before accepting a portable import.
- Saved account entries and always-allowed sites are durable user data. Temporary grants are session state, and audit history is excluded to limit site-history disclosure.
- The destination continues using its own local vault protection after import.
