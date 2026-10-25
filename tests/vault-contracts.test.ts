import { describe, expect, it } from 'vitest';
import { VaultAuditEventSchema, VaultCredentialSchema, VaultDataSchema, VaultEnvelopeSchema, canonicalizeOrigin, metadataOf } from '../mcp-server/src/vault/types.js';

const credential = {
  id: 'cred_0123456789abcdef0123456789abcdef',
  kind: 'login' as const,
  label: 'Fixture account',
  identifier: 'fixture-user',
  password: 'synthetic-passphrase',
  origin: 'https://example.test',
  createdAt: 1,
  updatedAt: 1,
};

describe('credential vault contracts', () => {
  it('accepts strict login records and keeps passwords out of metadata', () => {
    const parsed = VaultCredentialSchema.parse(credential);
    const metadata = metadataOf(parsed);
    expect(metadata).toMatchObject({ id: credential.id, label: credential.label, identifier: credential.identifier, origin: credential.origin });
    expect('password' in metadata).toBe(false);
    expect(VaultDataSchema.safeParse({ version: 1, entries: [parsed], audit: [] }).success).toBe(true);
  });

  it('rejects unknown fields, unsupported kinds, unbounded values, and non-canonical origins', () => {
    expect(VaultCredentialSchema.safeParse({ ...credential, raw: 'unexpected' }).success).toBe(false);
    expect(VaultCredentialSchema.safeParse({ ...credential, kind: 'totp' }).success).toBe(false);
    expect(VaultCredentialSchema.safeParse({ ...credential, password: 'x'.repeat(4_097) }).success).toBe(false);
    expect(VaultCredentialSchema.safeParse({ ...credential, origin: 'https://example.test/path' }).success).toBe(false);
  });

  it('canonicalizes only HTTPS sites and loopback HTTP fixtures', () => {
    expect(canonicalizeOrigin('https://example.test:443/')).toBe('https://example.test');
    expect(canonicalizeOrigin('http://127.0.0.1:8080')).toBe('http://127.0.0.1:8080');
    expect(() => canonicalizeOrigin('http://example.test')).toThrow(/VAULT_ORIGIN_MISMATCH/);
    expect(() => canonicalizeOrigin('https://user:pass@example.test')).toThrow(/VAULT_ORIGIN_MISMATCH/);
  });

  it('rejects malformed envelope shapes and unsafe versions', () => {
    expect(VaultEnvelopeSchema.safeParse({ version: 2, namespace: 'a'.repeat(64), nonce: 'a'.repeat(16), ciphertext: 'x', tag: 'a'.repeat(24) }).success).toBe(false);
    expect(VaultEnvelopeSchema.safeParse({ version: 1, namespace: 'a'.repeat(64), nonce: 'a'.repeat(16), ciphertext: 'x', tag: 'a'.repeat(24), path: '/tmp' }).success).toBe(false);
    expect(VaultEnvelopeSchema.safeParse({ version: 1, namespace: 'a'.repeat(64), nonce: 'a'.repeat(16), ciphertext: 'x', tag: 'a'.repeat(23) }).success).toBe(false);
  });

  it('accepts only a bounded pseudonymous session reference in durable audit rows', () => {
    const audit = {
      id: `audit_${'a'.repeat(32)}`,
      action: 'fill' as const,
      credentialId: credential.id,
      browserScope: 'b'.repeat(64),
      sessionRef: 'c'.repeat(24),
      origin: credential.origin,
      at: 1,
      result: 'success' as const,
    };
    expect(VaultAuditEventSchema.safeParse(audit).success).toBe(true);
    expect(VaultAuditEventSchema.safeParse({ ...audit, sessionRef: undefined, sessionId: 'session-token' }).success).toBe(false);
  });
});
