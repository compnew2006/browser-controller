import { describe, expect, it } from 'vitest';
import {
  decryptPortableArchive,
  encryptPortableArchive,
  MAX_PORTABLE_ARCHIVE_BYTES,
  validatePortableVaultData,
} from '../mcp-server/src/vault/portable-format.js';
import type { VaultData } from '../mcp-server/src/vault/types.js';

const passphrase = 'synthetic portable passphrase';

function fixture(): VaultData {
  return {
    version: 1,
    entries: [{
      id: 'cred_0123456789abcdef0123456789abcdef',
      kind: 'login',
      label: 'Fixture account',
      identifier: 'synthetic-user',
      password: 'synthetic-password-only',
      origin: 'https://fixture.test',
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_001,
    }],
    audit: [{
      id: 'audit_0123456789abcdef0123456789abcdef',
      action: 'backup',
      browserScope: 'a'.repeat(64),
      at: 1_700_000_000_002,
      result: 'success',
    }],
    allowlist: [{ origin: 'https://fixture.test', addedAt: 1_700_000_000_003 }],
  };
}

describe('portable vault archive format', () => {
  it('round-trips only portable account fields and allowed sites in a protected envelope', async () => {
    const source = fixture();
    const archive = await encryptPortableArchive({
      ...source,
      namespace: 'source-namespace',
      localKey: 'source-local-key',
      grants: [{ password: 'runtime-only-secret' }],
    } as unknown as VaultData, passphrase);
    const envelope = JSON.parse(archive.toString('utf8')) as Record<string, unknown>;

    expect(envelope).toMatchObject({ format: 'browser-controller-vault-portable', version: 1 });
    expect(Object.keys(envelope).sort()).toEqual(['cipher', 'format', 'kdf', 'version']);
    expect(archive.toString('utf8')).not.toContain('synthetic-password-only');
    expect(archive.toString('utf8')).not.toContain('source-local-key');

    const imported = await decryptPortableArchive(archive, passphrase);
    expect(imported).toEqual({
      version: 1,
      entries: [{
        kind: 'login',
        label: 'Fixture account',
        identifier: 'synthetic-user',
        password: 'synthetic-password-only',
        origin: 'https://fixture.test',
        createdAt: 1_700_000_000_000,
        updatedAt: 1_700_000_000_001,
      }],
      allowlist: [{ origin: 'https://fixture.test', addedAt: 1_700_000_000_003 }],
    });
    expect(imported.entries[0]).not.toHaveProperty('id');
    expect(imported).not.toHaveProperty('audit');
  });

  it('rejects a modified archive and a wrong passphrase without returning decrypted data', async () => {
    const archive = await encryptPortableArchive(fixture(), passphrase);
    const envelope = JSON.parse(archive.toString('utf8')) as { cipher: { ciphertext: string } };
    const ciphertext = Buffer.from(envelope.cipher.ciphertext, 'base64');
    ciphertext[0] = (ciphertext[0]! ^ 1);
    envelope.cipher.ciphertext = ciphertext.toString('base64');

    await expect(decryptPortableArchive(Buffer.from(JSON.stringify(envelope)), passphrase)).rejects.toThrow();
    await expect(decryptPortableArchive(archive, 'synthetic wrong passphrase')).rejects.toThrow();
  });

  it('uses a fresh random salt and nonce for each export', async () => {
    const source = fixture();
    const [first, second] = await Promise.all([
      encryptPortableArchive(source, passphrase),
      encryptPortableArchive(source, passphrase),
    ]);
    const firstEnvelope = JSON.parse(first.toString('utf8')) as { kdf: { salt: string }; cipher: { nonce: string } };
    const secondEnvelope = JSON.parse(second.toString('utf8')) as { kdf: { salt: string }; cipher: { nonce: string } };

    expect(firstEnvelope.kdf.salt).not.toBe(secondEnvelope.kdf.salt);
    expect(firstEnvelope.cipher.nonce).not.toBe(secondEnvelope.cipher.nonce);
  });

  it('rejects truncation, oversized input, unsupported profiles, and out-of-range passphrases', async () => {
    const archive = await encryptPortableArchive(fixture(), passphrase);
    const envelope = JSON.parse(archive.toString('utf8')) as {
      version: number;
      kdf: { N: number };
    };
    const unsupportedVersion = { ...envelope, version: 99 };
    const unsupportedKdf = { ...envelope, kdf: { ...envelope.kdf, N: 65_536 } };

    await expect(decryptPortableArchive(archive.subarray(0, archive.length - 2), passphrase))
      .rejects.toMatchObject({ code: 'VAULT_STORAGE_INVALID' });
    await expect(decryptPortableArchive(Buffer.alloc(MAX_PORTABLE_ARCHIVE_BYTES + 1), passphrase))
      .rejects.toMatchObject({ code: 'VAULT_STORAGE_INVALID' });
    await expect(decryptPortableArchive(Buffer.from(JSON.stringify(unsupportedVersion)), passphrase))
      .rejects.toMatchObject({ code: 'VAULT_STORAGE_INVALID' });
    await expect(decryptPortableArchive(Buffer.from(JSON.stringify(unsupportedKdf)), passphrase))
      .rejects.toMatchObject({ code: 'VAULT_STORAGE_INVALID' });
    await expect(encryptPortableArchive(fixture(), 'too short'))
      .rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(encryptPortableArchive(fixture(), 'é'.repeat(513)))
      .rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
  });

  it('rejects duplicate records and non-origin values before encryption', () => {
    const account = {
      kind: 'login', label: 'Fixture account', identifier: 'synthetic-user', password: 'synthetic-password-only',
      origin: 'https://fixture.test', createdAt: 1, updatedAt: 2,
    };
    expect(() => validatePortableVaultData({ version: 1, entries: [account, account], allowlist: [] })).toThrow();
    expect(() => validatePortableVaultData({
      version: 1, entries: [], allowlist: [
        { origin: 'https://fixture.test', addedAt: 1 }, { origin: 'https://fixture.test', addedAt: 2 },
      ],
    })).toThrow();
    expect(() => validatePortableVaultData({
      version: 1, entries: [{ ...account, origin: 'javascript:alert(1)' }], allowlist: [],
    })).toThrow();
  });
});
