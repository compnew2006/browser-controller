import type { MemoryCallOutcome, MemoryConnection } from './service.js';

/** Delta snapshots cannot safely attribute a complete page tree to a tab. */
export function invalidateDeltaSnapshot(
  outcome: MemoryCallOutcome,
  connection: (sessionId: string) => MemoryConnection,
  cache: { delete: (connectionId: string, tabId: number) => unknown },
  tabs: { forgetTab: (connectionId: string, tabId: number) => unknown },
): boolean {
  if (outcome.tool !== 'browser_snapshot' || outcome.params.delta !== true) return false;
  try {
    const tabId = typeof outcome.params.tabId === 'number' ? outcome.params.tabId : undefined;
    if (tabId !== undefined) {
      const connectionId = connection(outcome.sessionId).connectionId;
      cache.delete(connectionId, tabId);
      tabs.forgetTab(connectionId, tabId);
    }
  } catch { /* No connection means no safely attributable tab. */ }
  return true;
}
