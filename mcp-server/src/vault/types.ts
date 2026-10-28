import crypto from 'node:crypto';
import { z } from 'zod';

export const VAULT_VERSION = 1 as const;
export const VAULT_MAX_ENTRIES = 1_000;
export const VAULT_MAX_PASSWORD_CHARS = 4_096;
export const VAULT_MAX_LABEL_CHARS = 120;
export const VAULT_MAX_IDENTIFIER_CHARS = 320;
export const VAULT_MAX_AUDIT_EVENTS = 500;
export const VAULT_MAX_ALLOWLIST = 200;

export function canonicalizeOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('VAULT_ORIGIN_MISMATCH: a valid site origin is required');
  }
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('VAULT_ORIGIN_MISMATCH: credentials, paths, queries, and fragments are not site origins');
  }
  if (url.protocol !== 'https:') {
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    const loopback = host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '::ffff:127.0.0.1';
    if (url.protocol !== 'http:' || !loopback) {
      throw new Error('VAULT_ORIGIN_MISMATCH: only HTTPS sites and loopback HTTP fixtures are supported');
    }
  }
  return url.origin;
}

export const originSchema = z.string().min(1).max(2_048).transform((value, context) => {
  try {
    return canonicalizeOrigin(value);
  } catch (error) {
    context.addIssue({ code: 'custom', message: error instanceof Error ? error.message : 'invalid origin' });
    return z.NEVER;
  }
});

export const VaultCredentialSchema = z.object({
  id: z.string().regex(/^cred_[a-f0-9]{32}$/),
  kind: z.literal('login'),
  label: z.string().min(1).max(VAULT_MAX_LABEL_CHARS),
  identifier: z.string().min(1).max(VAULT_MAX_IDENTIFIER_CHARS),
  password: z.string().min(1).max(VAULT_MAX_PASSWORD_CHARS),
  origin: originSchema,
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
}).strict();

export type VaultCredential = z.infer<typeof VaultCredentialSchema>;

export const VaultAuditEventSchema = z.object({
  id: z.string().regex(/^audit_[a-f0-9]{32}$/),
  action: z.enum(['create', 'update', 'delete', 'grant', 'revoke', 'fill', 'lock', 'unlock', 'backup', 'restore']),
  credentialId: z.string().regex(/^cred_[a-f0-9]{32}$/).optional(),
  browserScope: z.string().regex(/^[a-f0-9]{64}$/),
  sessionRef: z.string().regex(/^[a-f0-9]{24}$/).optional(),
  origin: originSchema.optional(),
  at: z.number().int().nonnegative(),
  result: z.enum(['success', 'denied', 'cancelled', 'failed']),
}).strict();

/** An origin the owner allowlisted: agents list and fill its accounts without asking (specs/006 FR-009). */
export const VaultAllowlistEntrySchema = z.object({
  origin: originSchema,
  addedAt: z.number().int().nonnegative(),
}).strict();

export type VaultAllowlistEntry = z.infer<typeof VaultAllowlistEntrySchema>;

export const VaultDataSchema = z.object({
  version: z.literal(VAULT_VERSION),
  entries: z.array(VaultCredentialSchema).max(VAULT_MAX_ENTRIES),
  audit: z.array(VaultAuditEventSchema).max(VAULT_MAX_AUDIT_EVENTS),
  // Written only while non-empty, so a vault without an allowlist stays readable by earlier daemons.
  allowlist: z.array(VaultAllowlistEntrySchema).max(VAULT_MAX_ALLOWLIST).optional(),
}).strict();

export type VaultData = z.infer<typeof VaultDataSchema>;

export const VaultEnvelopeSchema = z.object({
  version: z.literal(VAULT_VERSION),
  namespace: z.string().regex(/^[a-f0-9]{64}$/),
  nonce: z.string().regex(/^[A-Za-z0-9+/]{16}$/),
  ciphertext: z.string().min(1).max(10_000_000),
  tag: z.string().regex(/^[A-Za-z0-9+/]{22}==$/),
}).strict();

export type VaultEnvelope = z.infer<typeof VaultEnvelopeSchema>;

export const VaultPrivateRequestSchema = z.object({
  requestId: z.string().regex(/^req_[a-f0-9]{32}$/),
  purpose: z.enum(['approve', 'fill', 'save', 'unlock']),
  sessionId: z.string().min(1).max(128),
  browserScope: z.string().regex(/^[a-f0-9]{64}$/),
  tabId: z.number().int().nonnegative().optional(),
  documentId: z.string().max(256).optional(),
  origin: originSchema.optional(),
  credentialId: z.string().regex(/^cred_[a-f0-9]{32}$/).optional(),
  createdAt: z.number().int().nonnegative(),
  expiresAt: z.number().int().nonnegative(),
  state: z.enum(['pending', 'processing', 'accepted', 'declined', 'cancelled', 'expired', 'failed']),
}).strict();

export type VaultPrivateRequest = z.infer<typeof VaultPrivateRequestSchema>;

export const VaultGrantSchema = z.object({
  grantId: z.string().regex(/^grant_[a-f0-9]{32}$/),
  sessionId: z.string().min(1).max(128),
  browserScope: z.string().regex(/^[a-f0-9]{64}$/),
  connectionId: z.string().min(16).max(128),
  origin: originSchema,
  credentialId: z.string().regex(/^cred_[a-f0-9]{32}$/).optional(),
  purpose: z.enum(['list', 'fill']),
  oneShot: z.boolean().optional(),
  createdAt: z.number().int().nonnegative(),
  expiresAt: z.number().int().nonnegative(),
  revoked: z.boolean(),
}).strict();

export type VaultGrant = z.infer<typeof VaultGrantSchema>;

export const VaultMetadataSchema = VaultCredentialSchema.omit({ password: true });
export type VaultMetadata = z.infer<typeof VaultMetadataSchema>;

export function metadataOf(entry: VaultCredential): VaultMetadata {
  const { password: _password, ...metadata } = entry;
  return metadata;
}

/** Opaque identifiers keep the shape their schemas above require: `<prefix>_<32 hex>`. */
export function randomId(prefix: string): string {
  return `${prefix}_${crypto.randomBytes(16).toString('hex')}`;
}
