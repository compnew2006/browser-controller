import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { ERROR_CODES, formatError } from '../core/error-codes.js';
import { createKnowledgeContextProvider, type KnowledgeContextProviderDependencies } from './knowledge-context.js';
import { currentKnowledgeEpoch } from './knowledge-coordinator.js';
import { JsonKnowledgePolicyStore } from './knowledge-policy-store.js';
import { readPolicy } from './policy.js';
import { KnowledgeService } from './knowledge-service.js';
import type { KnowledgeEntry } from './knowledge-entry.js';
import type { KnowledgeFile } from './knowledge-record.js';

type RouteDependencies = Omit<KnowledgeContextProviderDependencies, 'memoryPolicy' | 'knowledgePolicy' | 'knowledgePolicyForCommit' | 'epoch'> & {
  memoryDir: string;
};

type RelatedSite = NonNullable<KnowledgeFile['relatedSites']>[number];
type ReadResult = { success: true; result: { untrusted: true; entries: KnowledgeEntry[]; relatedSites?: RelatedSite[]; nextCursor: string | null } }
  | { success: false; error: string };

const argsSchema = z.object({
  tabId: z.number().int().nonnegative().safe(), cursor: z.string().min(1).max(512).optional(),
  action: z.enum(['read', 'search']).optional(), query: z.string().min(1).max(160).optional(),
  category: z.enum(['site', 'role', 'function', 'problem', 'change', 'test']).optional(),
}).strict().refine((value) => value.action === 'search' || value.query === undefined);
const cursorSchema = z.object({ v: z.literal(1), offset: z.number().int().nonnegative().safe(), siteOffset: z.number().int().nonnegative().safe(), revision: z.number().int().nonnegative().safe(), scope: z.string().min(1) }).strict();
const MAX_PAGE_BYTES = 8 * 1024;

/** Daemon-side read path. This module does not register tools or enable knowledge. */
export class KnowledgeReadRouter {
  private readonly cursorKey = randomBytes(32);
  private readonly policies: JsonKnowledgePolicyStore;

  constructor(private readonly deps: RouteDependencies) {
    this.policies = new JsonKnowledgePolicyStore(deps.memoryDir);
  }

  private scopeDigest(sessionId: string, browserId: string, origin: string, filter: unknown): string {
    return createHmac('sha256', this.cursorKey).update(JSON.stringify([sessionId, browserId, origin, filter])).digest('base64url');
  }

  private cursor(offset: number, siteOffset: number, revision: number, scope: string): string {
    const payload = Buffer.from(JSON.stringify({ v: 1, offset, siteOffset, revision, scope })).toString('base64url');
    const mac = createHmac('sha256', this.cursorKey).update(payload).digest('base64url');
    return `${payload}.${mac}`;
  }

  private parseCursor(token: string, revision: number, scope: string): { offset: number; siteOffset: number } {
    const parts = token.split('.');
    if (parts.length !== 2) throw new Error('Invalid site knowledge cursor');
    const [payload, signature] = parts as [string, string];
    if (!/^[A-Za-z0-9_-]+$/u.test(payload) || !/^[A-Za-z0-9_-]+$/u.test(signature)) {
      throw new Error('Invalid site knowledge cursor');
    }
    const actual = Buffer.from(signature, 'base64url');
    const expected = createHmac('sha256', this.cursorKey).update(payload).digest();
    if (actual.toString('base64url') !== signature || actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      throw new Error('Invalid site knowledge cursor');
    }
    const parsed = cursorSchema.safeParse(JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')));
    if (!parsed.success || parsed.data.revision !== revision || parsed.data.scope !== scope) throw new Error('Invalid site knowledge cursor');
    return { offset: parsed.data.offset, siteOffset: parsed.data.siteOffset };
  }

  async read(raw: unknown, sessionId: string, agentName: string, signal: AbortSignal): Promise<ReadResult> {
    const args = argsSchema.safeParse(raw);
    if (!args.success) return { success: false, error: formatError(ERROR_CODES.INVALID_ARGUMENT, 'Invalid site knowledge read request.') };
    try {
      const epoch = currentKnowledgeEpoch(this.deps.memoryDir);
      const provider = createKnowledgeContextProvider({
        ...this.deps,
        memoryPolicy: () => readPolicy(this.deps.memoryDir),
        knowledgePolicy: (browserId) => this.policies.get(browserId),
        knowledgePolicyForCommit: (browserId) => this.policies.readForCommit(browserId),
        epoch: () => currentKnowledgeEpoch(this.deps.memoryDir),
      }, sessionId, agentName, args.data.tabId, signal);
      const initial = await provider('normal');
      const service = new KnowledgeService(this.deps.memoryDir, { currentContext: provider, currentMemoryPolicy: () => readPolicy(this.deps.memoryDir) });
      const record = await service.read();
      const current = await provider('normal');
      if (signal.aborted || epoch !== currentKnowledgeEpoch(this.deps.memoryDir)
          || initial.sessionId !== current.sessionId || initial.connectionId !== current.connectionId
          || initial.browserId !== current.browserId || initial.origin !== current.origin
          || (record !== null && (record.browserId !== current.browserId || record.origin !== current.origin))) throw new Error();
      if (!record) {
        if (args.data.cursor) throw new Error();
        return { success: true, result: { untrusted: true, entries: [], nextCursor: null } };
      }
      const filter = { action: args.data.action ?? 'read', query: args.data.query ?? null, category: args.data.category ?? null };
      const query = args.data.query?.normalize('NFC').toLocaleLowerCase('und');
      const matches = record.entries.filter((entry) => (!args.data.category || entry.category === args.data.category)
        && (!query || `${entry.subject}\n${entry.body}`.normalize('NFC').toLocaleLowerCase('und').includes(query)));
      const scope = this.scopeDigest(sessionId, current.browserId, current.origin, filter);
      const sites = filter.action === 'read' ? record.relatedSites : undefined;
      const position = args.data.cursor ? this.parseCursor(args.data.cursor, record.revision, scope) : { offset: 0, siteOffset: 0 };
      const { offset, siteOffset } = position;
      if (offset > matches.length || siteOffset > (sites?.length ?? 0)
          || (args.data.cursor && offset === matches.length && siteOffset === (sites?.length ?? 0))) throw new Error();
      const entries: KnowledgeEntry[] = [];
      const relatedSites: RelatedSite[] = [];
      let next = offset;
      let nextSite = siteOffset;
      const result = (candidateEntries: KnowledgeEntry[], candidateSites: RelatedSite[], entryOffset: number, relatedOffset: number) => ({
        untrusted: true as const, entries: candidateEntries,
        ...(sites === undefined ? {} : { relatedSites: candidateSites }),
        nextCursor: entryOffset < matches.length || relatedOffset < (sites?.length ?? 0)
          ? this.cursor(entryOffset, relatedOffset, record.revision, scope) : null,
      });
      while (sites && nextSite < sites.length) {
        const candidate = [...relatedSites, sites[nextSite]!];
        if (Buffer.byteLength(JSON.stringify(result(entries, candidate, next, nextSite + 1)), 'utf8') > MAX_PAGE_BYTES) break;
        relatedSites.push(sites[nextSite]!);
        nextSite += 1;
      }
      while (next < matches.length && entries.length < 20) {
        const candidate = [...entries, matches[next]!];
        if (Buffer.byteLength(JSON.stringify(result(candidate, relatedSites, next + 1, nextSite)), 'utf8') > MAX_PAGE_BYTES) break;
        entries.push(matches[next]!);
        next += 1;
      }
      if (next === offset && nextSite === siteOffset && (next < matches.length || nextSite < (sites?.length ?? 0))) throw new Error();
      return { success: true, result: result(entries, relatedSites, next, nextSite) };
    } catch {
      return { success: false, error: formatError(ERROR_CODES.MEMORY_UNAVAILABLE, 'Site knowledge is unavailable or its scope changed.') };
    }
  }
}
