# Quickstart: Portable Credential Vault Backup

## Build and automated verification

Use the locked dependencies already present in the repository; no install or upgrade is part of this feature.

```sh
npm run build
npm run typecheck
npm run lint
npm test -- tests/vault-portable-format.test.ts tests/vault-portable-page.test.ts tests/vault-store.test.ts tests/vault-service.test.ts tests/bridge-vault.test.ts tests/register-tools.test.ts
```

Then run the repository's required full checks before completion:

```sh
npm run test:coverage
npm run security:audit
npm run context:lint
npm run context:measure
npm run arch:check
```

## Synthetic export/import scenario

1. In an isolated test state directory, initialize and unlock a vault with a synthetic account and a synthetic always-allowed origin.
2. Export from the private vault page using a matching passphrase of at least 12 characters. Click **Save portable copy** after the archive is ready; verify the file follows the browser's configured save flow and does not contain the synthetic username/password or local key as plaintext.
3. Import that file into a second isolated browser identity. Enter the passphrase for preview; verify only counts are shown and no destination data changes.
4. Cancel and verify the second vault is unchanged. Repeat, confirm replacement, re-enter the passphrase, and verify the synthetic account and allowlist are present with destination-local account IDs and key material.
5. Verify the second vault's pre-import local recovery snapshot restores its previous contents and that destination audit history remains local.

## Rejection and interruption scenarios

With isolated synthetic fixtures only, try wrong passphrase, modified ciphertext, truncated JSON, unsupported format/KDF version, duplicate records, invalid origins, a destination result above the 8 MiB store cap, and a file larger than 10 MiB. Each must fail before mutation. Exercise missing/out-of-order/oversized chunks, cancel, idle expiry, UI close, and connection drop; verify transfer buffers are discarded and the destination stays unchanged. Inject a replacement write failure and confirm the vault is either the complete previous or complete imported state and the recovery path remains available.

## Local UI review

Use the existing private vault page in an isolated test profile and synthetic vault state. Review the export/import controls at narrow and wide viewport sizes, keyboard/focus flow, loading/disabled states, empty destination, invalid-file/passphrase errors, cancellation, and completion. Confirm the current English UI direction and style remain consistent. Do not use the owner's normal Chrome profile or real saved credentials for these scenarios.

## Validation record (2026-11-12)

- `npm run build`: passed.
- `npm run typecheck`: passed.
- `npm run lint`: passed.
- `npm run arch:check`: passed (9 tests), including the 600-line module boundary.
- `npm run context:lint`: passed, score 100/100.
- `npm run context:measure`: passed, 2,698 rule tokens measured.
- Focused vault/protocol tests: `npm test -- tests/vault-portable-format.test.ts tests/vault-portable-page.test.ts tests/vault-store.test.ts tests/vault-service.test.ts tests/bridge-vault.test.ts tests/register-tools.test.ts` — 6 files and 130 tests passed.
- `npm run test:coverage`: coverage floors passed, but the command exited 1 because 8 unrelated existing registry tests still expect 22 tools or lack the `browser_fetch_many` extension handler. Results: 192 files passed, 5 failed; 2,937 tests passed, 8 failed. The failures are in `tests/extension-router.test.ts` (2), `tests/v3-server.test.ts` (2), `tests/vault-redaction.test.ts` (1), `tests/protocol-contracts/protocol.contract.test.ts` (1), and `tests/tools/registry.test.ts` (2).
- `npm run security:audit`: not run because it contacts the external npm registry and this task did not authorize external service calls.
- `node scripts/smoke-vault-isolated.mjs --portable-roundtrip-only`: passed in two temporary disposable Chromium profiles. It verified encrypted export, separate owner save action, wrong-passphrase preservation, counts-only preview, explicit replacement and passphrase re-entry, destination-local IDs, and a local recovery snapshot. No normal browser profile or real vault data was used.
- Playwright UI review on the isolated private vault page with synthetic/mock RPC: export/import success, wrong-passphrase retry, empty/locked states, disabled confirmation, cancel/error paths, visible keyboard focus, English LTR, and 375px width without horizontal overflow passed; the final console check showed no errors.

T019 remains incomplete: full coverage execution has the eight listed baseline failures, and the external audit gate was not run. The feature is locally implemented and verified but is not formally accepted by the full repository gates.
