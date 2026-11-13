import { z } from 'zod';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import type { ToolDefinition, ToolHost, ToolResult } from './types.js';
import { tabIdParam, targetParam, forwardHandler, rawResultOf } from './types.js';

// The daemon redacts the complete snapshot before it reaches this handler.
// Retain keyed line digests only, scoped to this MCP host, never page text.
const digestKey = randomBytes(32);
const digest = (value: string) => createHmac('sha256', digestKey).update(value).digest('hex');
const MAX_BASELINES = 16;
const MAX_LINES = 2_048;
const TTL_MS = 30_000;
interface Baseline { revision: string; epoch: string; url: string; lines: string[]; expires: number }
const baselines = new WeakMap<ToolHost, Map<string, Baseline>>();
const forward = forwardHandler('browser_snapshot');

async function snapshotHandler(host: ToolHost, params: Record<string, unknown>): Promise<ToolResult> {
  const result = await forward(host, params);
  if (params.delta !== true || result.isError) return result;
  const raw = rawResultOf(result);
  if (typeof raw?.text !== 'string') return result;
  const text = raw.text;
  const lines = text.split('\n');
  const scope = digest(JSON.stringify([params.tabId, params.target ?? null, params.query ?? null, params.maxChars ?? 8_000]));
  let cache = baselines.get(host);
  if (!cache) { cache = new Map(); baselines.set(host, cache); }
  const previous = cache.get(scope);
  const identity = raw.snapshotEpoch;
  const epoch = Array.isArray(identity) && identity.length >= 5 && identity.every(Number.isSafeInteger)
    ? digest(JSON.stringify(identity)) : null;
  const url = digest(typeof raw.url === 'string' ? raw.url : '');
  const unavailable = raw.truncated === true ? 'truncated'
    : !epoch ? 'document-identity-unavailable' : lines.length > MAX_LINES ? 'baseline-too-large' : null;
  const full = (revision: string | null, reason: string) => ({
    ...result,
    content: [{ type: 'text' as const, text: `${JSON.stringify({ kind: 'full', revision, reason })}\n${text}` }],
  });
  if (unavailable) { cache.delete(scope); return full(null, unavailable); }
  const since = typeof params.since === 'string' ? params.since : null;
  const reason = !since ? 'initial' : !previous || previous.expires <= Date.now() || previous.revision !== since
    ? 'baseline-unavailable' : previous.epoch !== epoch || previous.url !== url ? 'document-changed' : null;
  const hashes = lines.map(digest);
  const revision = randomUUID();
  let output: ToolResult;
  if (reason || !previous) output = full(revision, reason ?? 'baseline-unavailable');
  else {
    let startLine = 0;
    while (startLine < previous.lines.length && startLine < hashes.length && previous.lines[startLine] === hashes[startLine]) startLine++;
    let suffix = 0;
    while (suffix < previous.lines.length - startLine && suffix < hashes.length - startLine
      && previous.lines[previous.lines.length - 1 - suffix] === hashes[hashes.length - 1 - suffix]) suffix++;
    const change = { kind: 'delta', baseRevision: previous.revision, revision, startLine,
      deleteCount: previous.lines.length - startLine - suffix, lines: lines.slice(startLine, lines.length - suffix) };
    const encoded = JSON.stringify(change);
    output = encoded.length < text.length
      ? { ...result, content: [{ type: 'text', text: encoded }] }
      : full(revision, 'delta-not-smaller');
  }
  cache.delete(scope);
  while (cache.size >= MAX_BASELINES) cache.delete(cache.keys().next().value!);
  cache.set(scope, { revision, epoch: epoch!, url, lines: hashes, expires: Date.now() + TTL_MS });
  return output;
}
(snapshotHandler as typeof snapshotHandler & { toolName: string }).toolName = 'browser_snapshot';

export const snapshotTool: ToolDefinition = {
  name: 'browser_snapshot',
  summary: 'Accessibility tree of the page with element refs',
  description: 'Accessibility tree with refs; scope by target or query. Passwords are masked. With delta:true, pass the prior revision as since; apply the line splice or replace on kind:"full".',
  inputSchema: z.object({
    tabId: tabIdParam,
    target: targetParam.optional(),
    query: z.string().optional(),
    maxChars: z.number().int().min(200).max(50_000).optional().describe('Default 8000'),
    delta: z.boolean().optional().describe('Request incremental snapshot'),
    since: z.string().min(1).max(100).optional().describe('Prior revision'),
  }).strict(),
  // Read-only (refs are deterministic given a stable DOM): safe to retry.
  idempotent: true,
  timeoutMs: 15_000,
  handler: snapshotHandler,
};
