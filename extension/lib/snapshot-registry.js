const DEFAULT_TTL_MS = 60_000;
const DEFAULT_MAX_ENTRIES = 64;

function isValidEntry(entry) {
  return !!entry
    && typeof entry.snapshotId === 'string'
    && entry.snapshotId.length > 0
    && Number.isInteger(entry.tabId)
    && typeof entry.sessionId === 'string'
    && typeof entry.documentId === 'string'
    && typeof entry.documentVersion === 'string'
    && Number.isFinite(entry.createdAt);
}

function copyEntry(entry) {
  const parts = String(entry.documentVersion).split(':');
  const parsedRouteEpoch = Number(parts[parts.length - 2]);
  return Object.freeze({
    snapshotId: entry.snapshotId,
    tabId: entry.tabId,
    sessionId: entry.sessionId,
    documentId: entry.documentId,
    documentVersion: entry.documentVersion,
    routeEpoch: Number.isInteger(entry.routeEpoch) ? entry.routeEpoch : (Number.isInteger(parsedRouteEpoch) ? parsedRouteEpoch : 1),
    ...(typeof entry.url === 'string' ? { url: entry.url } : {}),
    createdAt: entry.createdAt,
  });
}

/**
 * Bounded service-worker-side ownership index. Element objects remain in the
 * page's isolated world; this registry stores only small, serializable metadata
 * so a worker recycle never turns an old ref into an unrelated target.
 */
export class SnapshotRegistry {
  constructor({ ttlMs = DEFAULT_TTL_MS, maxEntries = DEFAULT_MAX_ENTRIES, now = Date.now } = {}) {
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
    this.now = now;
    this.entries = new Map();
    this.expiredIds = new Set();
    this.invalidatedIds = new Map();
  }

  get size() {
    return this.entries.size;
  }

  register(entry) {
    if (!isValidEntry(entry)) throw new TypeError('Invalid snapshot metadata');
    const next = copyEntry(entry);
    this.entries.set(next.snapshotId, next);
    this.expiredIds.delete(next.snapshotId);
    this.invalidatedIds.delete(next.snapshotId);
    this.prune();
    return next;
  }

  validate(snapshotId, tabId, sessionId) {
    const entry = this.entries.get(snapshotId);
    if (!entry) {
      const invalidated = this.invalidatedIds.get(snapshotId);
      if (invalidated) {
        if (invalidated.tabId !== tabId) return this.failure('SNAPSHOT_NOT_FOUND', 'WRONG_TAB');
        if (invalidated.sessionId !== sessionId) return this.failure('SNAPSHOT_NOT_FOUND', 'WRONG_SESSION');
        return this.failure('DOCUMENT_CHANGED');
      }
      return this.failure(this.expiredIds.has(snapshotId) ? 'SNAPSHOT_EXPIRED' : 'SNAPSHOT_NOT_FOUND');
    }
    if (this.isExpired(entry)) {
      this.expire(snapshotId);
      return this.failure('SNAPSHOT_EXPIRED');
    }
    if (entry.tabId !== tabId) return this.failure('SNAPSHOT_NOT_FOUND', 'WRONG_TAB');
    if (entry.sessionId !== sessionId) return this.failure('SNAPSHOT_NOT_FOUND', 'WRONG_SESSION');
    return { ok: true, snapshot: copyEntry(entry) };
  }

  dropTab(tabId) {
    this.dropWhere((entry) => entry.tabId === tabId);
  }

  dropSession(sessionId) {
    this.dropWhere((entry) => entry.sessionId === sessionId);
  }

  invalidateTab(tabId) {
    for (const [snapshotId, entry] of this.entries) {
      if (entry.tabId === tabId) {
        this.entries.delete(snapshotId);
        this.invalidatedIds.set(snapshotId, {
          tabId: entry.tabId,
          sessionId: entry.sessionId,
        });
      }
    }
    while (this.invalidatedIds.size > this.maxEntries * 2) {
      this.invalidatedIds.delete(this.invalidatedIds.keys().next().value);
    }
  }

  serialize() {
    this.prune();
    return Array.from(this.entries.values(), copyEntry);
  }

  restore(entries) {
    if (!Array.isArray(entries)) return;
    for (const entry of entries) {
      if (isValidEntry(entry) && !this.isExpired(entry)) this.register(entry);
    }
  }

  clear() {
    this.entries.clear();
    this.expiredIds.clear();
    this.invalidatedIds.clear();
  }

  failure(error, reason) {
    return {
      ok: false,
      error,
      message: error === 'SNAPSHOT_EXPIRED'
        ? 'The observation expired; call browser_observe again.'
        : error === 'DOCUMENT_CHANGED'
          ? 'The page document changed; call browser_observe again.'
          : 'The observation is unavailable; call browser_observe again.',
      ...(reason ? { reason } : {}),
    };
  }

  isExpired(entry) {
    return this.now() - entry.createdAt > this.ttlMs;
  }

  expire(snapshotId) {
    this.entries.delete(snapshotId);
    this.invalidatedIds.delete(snapshotId);
    this.expiredIds.add(snapshotId);
    while (this.expiredIds.size > this.maxEntries * 2) {
      this.expiredIds.delete(this.expiredIds.values().next().value);
    }
  }

  prune() {
    for (const [snapshotId, entry] of this.entries) {
      if (this.isExpired(entry)) this.expire(snapshotId);
    }
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      this.expire(oldest);
    }
  }

  dropWhere(predicate) {
    for (const [snapshotId, entry] of this.entries) {
      if (predicate(entry)) this.entries.delete(snapshotId);
    }
    for (const [snapshotId, entry] of this.invalidatedIds) {
      if (predicate(entry)) this.invalidatedIds.delete(snapshotId);
    }
  }
}

export const SNAPSHOT_TTL_MS = DEFAULT_TTL_MS;
export const SNAPSHOT_MAX_ENTRIES = DEFAULT_MAX_ENTRIES;
