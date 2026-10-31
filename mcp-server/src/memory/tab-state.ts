/**
 * The memory service's per-tab memory (specs/007-form-shape-facts, R-07, C7, C8).
 *
 * A failed call carries no `siteContext` and no observation: the daemon returns an observation only for a
 * successful call, so it cannot ask the page which site a refused action was aimed at. The last **observed**
 * read of that tab answers it, inside a short window — the same answer the site map gives from its own tab
 * cache. The cache also holds the commit mode a write produced, until the next observed read of that path can
 * store it where the anonymity gate is evaluated.
 *
 * Nothing here is written to disk and nothing here reaches the agent: the cache holds an origin, a path, an
 * anonymity verdict and the roles of the last snapshot's refs.
 */
import type { CommitMode } from './allowlist.js';

/** How many tabs one connection may hold. */
export const TAB_CACHE_ENTRIES = 64;
/** How long a read stays usable for attributing a later failure. */
export const TAB_ATTRIBUTION_MS = 120_000;
/** How many refs of one snapshot are kept. */
export const TAB_ROLE_ENTRIES = 256;
/** How many pending commit modes are kept. */
export const TAB_MODE_ENTRIES = 32;

/** One snapshot line: its role and its ref. The name is never read. */
const REF_LINE = /^( *)(?:- )?([a-z]+)(?: ("(?:[^"\\]|\\.)*"))?(?: \[(e\d+)\])?/u;

export interface TabEntry {
  /** The connection that observed the read. A later failure from another connection is not attributed to it. */
  connectionId: string;
  /** The URL of the last observed read. */
  url: string;
  /** Its canonical origin. */
  origin: string;
  /** Its path, for the commit mode and the shape fact's identity. */
  path: string;
  /** The anonymity verdict of that read: true, false, or null when it could not be determined. */
  anonymous: boolean | null;
  /** The last snapshot's ref → role, so a click's role can be read without reading the page again. */
  roles: Map<string, string>;
  /** When the entry was written (epoch ms). */
  atMs: number;
}

/** The roles of the refs in a snapshot text. No name, no value, no other string. */
export function snapshotRoles(text: string | null | undefined): Map<string, string> {
  const roles = new Map<string, string>();
  if (typeof text !== 'string') return roles;
  for (const line of text.split('\n')) {
    const match = REF_LINE.exec(line);
    if (!match) continue;
    const ref = match[4];
    if (!ref || roles.size >= TAB_ROLE_ENTRIES) continue;
    roles.set(ref, match[2]);
  }
  return roles;
}

export class TabStateCache {
  /** One map per connection, so one busy profile cannot evict another's tabs. */
  private readonly tabs = new Map<string, Map<number, TabEntry>>();
  /** The commit modes a write produced, waiting for the next observed read of their path. */
  private readonly modes = new Map<string, { mode: CommitMode; atMs: number }>();

  /** The entry for a tab, or null when there is none or it is too old to attribute a failure to. */
  lookup(connectionId: string, tabId: number, nowMs: number): TabEntry | null {
    const entry = this.tabs.get(connectionId)?.get(tabId);
    if (!entry) return null;
    if (nowMs - entry.atMs > TAB_ATTRIBUTION_MS) {
      this.tabs.get(connectionId)?.delete(tabId);
      return null;
    }
    return entry;
  }

  /** Records an observed read. The oldest tab of that connection is dropped when the bound is reached. */
  remember(connectionId: string, tabId: number, entry: { connectionId?: string; url: string; origin: string; path: string; anonymous: boolean | null; roles?: Map<string, string> }, nowMs: number): void {
    const tabs = this.tabs.get(connectionId) ?? new Map<number, TabEntry>();
    this.tabs.set(connectionId, tabs);
    tabs.delete(tabId);
    tabs.set(tabId, {
      connectionId: entry.connectionId ?? connectionId,
      url: entry.url,
      origin: entry.origin,
      path: entry.path,
      anonymous: entry.anonymous,
      roles: entry.roles ?? new Map(),
      atMs: nowMs,
    });
    while (tabs.size > TAB_CACHE_ENTRIES) {
      const oldest = tabs.keys().next();
      if (oldest.done) break;
      tabs.delete(oldest.value);
    }
  }

  /** The role of a ref in the last snapshot of that tab, or null when it is not known. */
  roleOf(connectionId: string, tabId: number, ref: string | undefined, nowMs: number): string | null {
    if (!ref) return null;
    return this.lookup(connectionId, tabId, nowMs)?.roles.get(ref) ?? null;
  }

  /** Holds a commit mode for a path until the next observed read of that path. */
  setCommitMode(connectionId: string, origin: string, path: string, mode: CommitMode, nowMs: number): void {
    const key = `${connectionId}\n${origin}\n${path}`;
    this.modes.delete(key);
    this.modes.set(key, { mode, atMs: nowMs });
    while (this.modes.size > TAB_MODE_ENTRIES) {
      const oldest = this.modes.keys().next();
      if (oldest.done) break;
      this.modes.delete(oldest.value);
    }
  }

  /**
   * The commit mode held for a path, and removes it: the mode is stored once, at the next observed read of
   * that path. A mode that waited longer than the attribution window is dropped: it says too little to be
   * worth a stale hint.
   */
  takeCommitMode(connectionId: string, origin: string, path: string, nowMs: number): CommitMode | null {
    const key = `${connectionId}\n${origin}\n${path}`;
    const held = this.modes.get(key);
    if (!held) return null;
    this.modes.delete(key);
    if (nowMs - held.atMs > TAB_ATTRIBUTION_MS) return null;
    return held.mode;
  }

  /** Forgets one connection, for example when its browser profile changes. */
  forgetConnection(connectionId: string): void {
    this.tabs.delete(connectionId);
    for (const key of [...this.modes.keys()]) {
      if (key.startsWith(`${connectionId}\n`)) this.modes.delete(key);
    }
  }

  /** Forgets everything. Used when the memory is turned off. */
  clear(): void {
    this.tabs.clear();
    this.modes.clear();
  }
}
