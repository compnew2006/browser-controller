import path from 'node:path';

/** Serializes all knowledge files under one memory directory within the daemon. */
const tails = new Map<string, Promise<void>>();
const epochs = new Map<string, number>();
const deletionTails = new Map<string, Promise<void>>();

/** In-memory drafts are lost on restart; an epoch invalidates pending commits in this process. */
export function currentKnowledgeEpoch(memoryDir: string): number {
  return epochs.get(path.resolve(memoryDir)) ?? 0;
}

export function invalidateKnowledgeEpoch(memoryDir: string): void {
  const root = path.resolve(memoryDir);
  const next = (epochs.get(root) ?? 0) + 1;
  if (!Number.isSafeInteger(next)) throw new Error('Site knowledge generation exhausted');
  epochs.set(root, next);
}

export function serializeKnowledge<T>(memoryDir: string, operation: () => Promise<T>): Promise<T> {
  const root = path.resolve(memoryDir);
  const previous = tails.get(root) ?? Promise.resolve();
  const result = previous.then(operation);
  const tail = result.then(() => undefined, () => undefined);
  tails.set(root, tail);
  void tail.then(() => { if (tails.get(root) === tail) tails.delete(root); });
  return result;
}

/** Existing memory-policy changes invalidate knowledge commits before entering their shared queue. */
export function coordinateLegacyPolicy<T>(memoryDir: string, operation: () => Promise<T>): Promise<T> {
  invalidateKnowledgeEpoch(memoryDir);
  return serializeKnowledge(memoryDir, operation);
}

/** Wait for work already queued for this memory directory. */
export async function drainKnowledge(memoryDir: string): Promise<void> {
  await tails.get(path.resolve(memoryDir));
}

export class KnowledgeDeletionBusy extends Error {
  constructor() { super('Site knowledge deletion is already in progress'); }
}

/** Deletion spans several store transactions; refuse overlaps instead of clearing a shared block early. */
export function serializeKnowledgeDeletion<T>(memoryDir: string, operation: () => Promise<T>): Promise<T> {
  const root = path.resolve(memoryDir);
  if (deletionTails.has(root)) return Promise.reject(new KnowledgeDeletionBusy());
  const result = Promise.resolve().then(operation);
  const tail = result.then(() => undefined, () => undefined);
  deletionTails.set(root, tail);
  return result.finally(() => { if (deletionTails.get(root) === tail) deletionTails.delete(root); });
}
