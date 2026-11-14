import { z } from 'zod';
import { knowledgeEntrySchema, knowledgeTimestampSchema } from './knowledge-entry.js';
import { canonicalOrigin } from './policy.js';
import { ERROR_CODES } from '../core/error-codes.js';

export const relatedSiteSchema = z.object({
  origin: z.string().max(2048).refine((value) => canonicalOrigin(value) === value),
  relationship: z.enum(['same_product', 'staging_for', 'production_for', 'other']),
  source: knowledgeEntrySchema.shape.source,
  attestation: knowledgeEntrySchema.shape.attestation,
  observedAt: knowledgeTimestampSchema.nullable(),
}).strict();
const relatedSitesSchema = z.array(relatedSiteSchema).max(20);

const relatedSiteProposalSchema = relatedSiteSchema.omit({ attestation: true });

export function createRelatedSiteProposal(value: unknown): z.infer<typeof relatedSiteSchema> {
  const result = relatedSiteProposalSchema.safeParse(value);
  if (!result.success || result.data.source === 'owner_statement') throw new Error('Invalid related site proposal');
  return { ...result.data, attestation: 'declared' };
}

const recordSchema = z.object({
  schemaVersion: z.literal(1),
  browserId: z.string().min(1).max(64).refine((value) => value !== 'default' && !/[\p{Cc}\p{Cf}]/u.test(value)),
  origin: z.string().max(2048).refine((value) => canonicalOrigin(value) === value),
  revision: z.number().int().nonnegative().safe(),
  updatedAt: knowledgeTimestampSchema,
  entries: z.array(knowledgeEntrySchema).max(100),
  relatedSites: relatedSitesSchema.optional(),
}).strict().superRefine((record, context) => {
  const ids = new Set(record.entries.map((entry) => entry.id));
  if (ids.size !== record.entries.length || record.entries.some((entry) => entry.relatedIds.some((id) => !ids.has(id)))) {
    context.addIssue({ code: 'custom', message: 'Invalid entry relationships' });
  }
  const origins = record.relatedSites?.map((site) => site.origin) ?? [];
  if (origins.includes(record.origin) || new Set(origins).size !== origins.length) {
    context.addIssue({ code: 'custom', message: 'Invalid site relationships' });
  }
  if (Buffer.byteLength(JSON.stringify(record), 'utf8') > 128 * 1024) {
    context.addIssue({ code: 'custom', message: 'Record exceeds size limit' });
  }
});

export type KnowledgeFile = z.infer<typeof recordSchema>;

/** Refuse malformed or future versions without including input in diagnostic text. */
export function validateKnowledgeRecord(value: unknown): KnowledgeFile {
  const result = recordSchema.safeParse(value);
  if (!result.success) {
    throw Object.assign(new Error('Invalid site knowledge record'), { code: ERROR_CODES.INVALID_ARGUMENT });
  }
  return result.data;
}
