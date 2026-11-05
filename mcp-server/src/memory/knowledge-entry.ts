import { z } from 'zod';
import { randomUUID } from 'node:crypto';

/** Detection is best effort: passing validation does not prove text has no secret. */
const suspicious = /(?:password|passwd|api[_ -]?key|access[_ -]?token|refresh[_ -]?token|authorization|cookie|account[_ -]?id|user[_ -]?id|full[_ -]?name|اسم\s+(?:الموظف|الشخص|المستخدم))\s*[:=：]\s*\S+/iu;
const emailAddress = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.[\p{L}]{2,}/iu;
const unsafeControl = /[\p{Cc}\p{Cf}]/u;

function containsCardNumber(value: string): boolean {
  for (const match of value.matchAll(/(?<!\d)(?:\d[ -]?){13,19}(?!\d)/gu)) {
    const digits = match[0].replace(/\D/gu, '');
    if (digits.length < 13 || digits.length > 19) continue;
    let sum = 0;
    for (let index = 0; index < digits.length; index += 1) {
      let digit = Number(digits[digits.length - 1 - index]);
      if (index % 2 === 1) digit = digit * 2 > 9 ? digit * 2 - 9 : digit * 2;
      sum += digit;
    }
    if (sum % 10 === 0) return true;
  }
  return false;
}
export const knowledgeTimestampSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u)
  .refine((value) => {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 19) === value.slice(0, 19);
  });

function safeText(value: string): boolean {
  if (unsafeControl.test(value) || suspicious.test(value) || emailAddress.test(value) || containsCardNumber(value)) return false;
  for (const match of value.matchAll(/https?:\/\/[^\s]+/giu)) {
    try {
      const url = new URL(match[0]);
      if (url.username || url.password || url.search || url.hash) return false;
    } catch {
      return false;
    }
  }
  return true;
}

function safeReference(value: string): boolean {
  if (!safeText(value)) return false;
  try {
    const url = new URL(value);
    return (url.protocol === 'https:' || url.protocol === 'http:')
      && !url.username && !url.password && !url.search && !url.hash;
  } catch {
    return false;
  }
}

export const knowledgeEntrySchema = z.object({
  id: z.string().uuid(),
  category: z.enum(['site', 'role', 'function', 'problem', 'change', 'test']),
  subject: z.string().min(1).max(160).refine(safeText),
  body: z.string().min(1).refine(safeText),
  source: z.enum(['owner_statement', 'direct_observation', 'historical_record', 'task_summary']),
  attestation: z.enum(['corroborated', 'declared']),
  sourceReference: z.string().max(512).refine(safeReference).optional(),
  observedAt: knowledgeTimestampSchema.nullable(),
  lastVerifiedAt: knowledgeTimestampSchema.nullable(),
  createdAt: knowledgeTimestampSchema,
  updatedAt: knowledgeTimestampSchema,
  status: z.enum(['unverified', 'verified_at_time', 'historical', 'needs_recheck']),
  execution: z.enum(['planned', 'performed', 'unknown', 'not_applicable']),
  testOutcome: z.enum(['not_run', 'passed', 'failed', 'unknown', 'not_applicable']),
  relatedIds: z.array(z.string().uuid()).max(100),
}).strict().superRefine((entry, context) => {
  if (Buffer.byteLength(JSON.stringify(entry), 'utf8') > 2048) {
    context.addIssue({ code: 'custom', message: 'Entry exceeds size limit' });
  }
  if ((entry.status === 'verified_at_time' || entry.testOutcome === 'passed' || entry.testOutcome === 'failed')
      && (entry.lastVerifiedAt === null || entry.attestation !== 'corroborated' || !entry.sourceReference)) {
    context.addIssue({ code: 'custom', message: 'Verified result requires evidence and verification time' });
  }
});

export type KnowledgeEntry = z.infer<typeof knowledgeEntrySchema>;

/**
 * Untrusted proposals cannot promote their own claims to independently verified evidence.
 * The caller must first assign the ID and system timestamps; this validator does not authenticate them.
 */
export function validateKnowledgeProposal(value: unknown): KnowledgeEntry {
  const result = knowledgeEntrySchema.safeParse(value);
  if (!result.success || result.data.source === 'owner_statement' || result.data.attestation !== 'declared'
      || result.data.status === 'verified_at_time' || result.data.lastVerifiedAt !== null
      || result.data.testOutcome === 'passed' || result.data.testOutcome === 'failed') {
    throw new Error('Invalid site knowledge proposal');
  }
  return result.data;
}

const proposalInputSchema = z.object({
  category: knowledgeEntrySchema.shape.category,
  subject: knowledgeEntrySchema.shape.subject,
  body: knowledgeEntrySchema.shape.body,
  source: knowledgeEntrySchema.shape.source,
  sourceReference: knowledgeEntrySchema.shape.sourceReference,
  observedAt: knowledgeTimestampSchema.nullable().optional(),
}).strict();

/** Build system-owned fields locally, then validate the normalized untrusted proposal. */
export function createKnowledgeProposal(input: unknown): KnowledgeEntry {
  const result = proposalInputSchema.safeParse(input);
  if (!result.success) throw new Error('Invalid site knowledge proposal');
  const now = new Date().toISOString();
  return validateKnowledgeProposal({
    ...result.data,
    id: randomUUID(),
    attestation: 'declared',
    observedAt: result.data.observedAt ?? null,
    lastVerifiedAt: null,
    createdAt: now,
    updatedAt: now,
    status: result.data.source === 'historical_record' ? 'historical' : 'unverified',
    execution: 'unknown',
    testOutcome: 'not_applicable',
    relatedIds: [],
  });
}
