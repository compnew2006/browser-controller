import path from 'node:path';

/** Serializes all knowledge files under one memory directory within the daemon. */
const tails = new Map<string, Promise<void>>();
const epochs = new Map<string, number>();

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
