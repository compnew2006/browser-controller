import type { ToolHost, ToolResult } from './types.js';
import { failureResult } from './types.js';
import { ERROR_CODES, formatError } from '../core/error-codes.js';

/**
 * Which tabs the agent may act on.
 *
 * `trusted` (the default) keeps the whole browser available: the agent acts in
 * the user's own tabs, with the user's own logged-in sessions. `isolated` is
 * the mode the in-app browser has by construction: the agent only ever sees
 * and touches the tabs it opened itself.
 */
export type Isolation = 'trusted' | 'isolated';

/** Whether the agent may change anything in the page. */
export type Access = 'full' | 'read-only';

export interface SessionPolicy {
  isolation: Isolation;
  access: Access;
}

const DEFAULT_POLICY: SessionPolicy = { isolation: 'trusted', access: 'full' };

const policyByHost = new WeakMap<ToolHost, SessionPolicy>();

export function getSessionPolicy(host: ToolHost): SessionPolicy {
  const policy = policyByHost.get(host);
  return policy ? { ...policy } : { ...DEFAULT_POLICY };
}

export function setSessionPolicy(host: ToolHost, patch: Partial<SessionPolicy>): SessionPolicy {
  const next: SessionPolicy = { ...getSessionPolicy(host), ...patch };
  policyByHost.set(host, next);
  // The owned-tab cache belongs to the isolated mode only.
  if (next.isolation === 'trusted') ownedTabsByHost.delete(host);
  return next;
}

export function isIsolated(host: ToolHost): boolean {
  return getSessionPolicy(host).isolation === 'isolated';
}

export function isReadOnly(host: ToolHost): boolean {
  return getSessionPolicy(host).access === 'read-only';
}

/**
 * The tools that change something: the page, its data, or the environment.
 *
 * Read-only mode refuses exactly these. Navigation is not on the list: opening
 * a page is how a read-only session reads anything at all, and it changes no
 * data. Scrolling is not on the list either: it moves the viewport, nothing
 * else.
 */
const MUTATING_TOOLS = new Set([
  'browser_click',
  'browser_type',
  'browser_fill',
  'browser_evaluate',
  'browser_handle_dialog',
  'browser_emulate',
  'browser_mock',
  'browser_vault',
]);

/** How long the owned-tab list is trusted before it is read again. */
const OWNED_TTL_MS = 15_000;

interface OwnedTabs {
  ids: Set<number>;
  at: number;
}

const ownedTabsByHost = new WeakMap<ToolHost, OwnedTabs>();

/** A tab line of browser_tabs list: `<id> [own] "title" host/path`. */
const OWNED_LINE = /^(\d+)\s+\[own\b/;
const ANY_TAB_LINE = /^\d+\s+\[/;

/**
 * The tabs this session owns: the ones it opened, which the extension locked
 * to it. Read from browser_tabs list, where the extension marks them [own].
 */
async function fetchOwnedTabs(host: ToolHost): Promise<Set<number>> {
  const ids = new Set<number>();
  let raw: Record<string, unknown> | undefined;
  try {
    raw = await host.callTool('browser_tabs', { action: 'list' }) as Record<string, unknown>;
  } catch {
    return ids;
  }
  const listed = raw?.tabs;
  if (Array.isArray(listed)) {
    for (const item of listed) {
      if (!item || typeof item !== 'object') continue;
      const entry = item as { tabId?: unknown; role?: unknown };
      if (entry.role === 'own' && typeof entry.tabId === 'number') ids.add(entry.tabId);
    }
  }
  if (ids.size > 0) return ids;
  // The extension's own listing is the fallback: the machine field is missing
  // on an older daemon, the text is always there.
  const text = typeof raw?.text === 'string' ? raw.text : '';
  for (const line of text.split('\n')) {
    const match = OWNED_LINE.exec(line.trim());
    if (match) ids.add(Number(match[1]));
  }
  return ids;
}

/** The session's owned tabs, read again when the cache is older than its window. */
async function ownedTabs(host: ToolHost, refresh: boolean): Promise<Set<number>> {
  const cached = ownedTabsByHost.get(host);
  if (!refresh && cached && Date.now() - cached.at <= OWNED_TTL_MS) return cached.ids;
  const ids = await fetchOwnedTabs(host);
  ownedTabsByHost.set(host, { ids, at: Date.now() });
  return ids;
}

/** A tab the session opened: it is the session's, and the extension locked it to it. */
export function noteOwnedTab(host: ToolHost, tabId: number): void {
  if (!Number.isFinite(tabId)) return;
  const cached = ownedTabsByHost.get(host);
  const ids = new Set(cached?.ids ?? []);
  ids.add(tabId);
  ownedTabsByHost.set(host, { ids, at: Date.now() });
}

/**
 * The gate every tool call passes before it is dispatched.
 *
 * Read-only mode refuses the tools that change something. Isolated mode
 * refuses a call that names a tab the session does not own. The refusal is a
 * `CODE: message` result, so the agent reads it like any other failure and
 * knows what to do next.
 */
export async function sessionGate(
  tool: string,
  params: Record<string, unknown>,
  host: ToolHost,
): Promise<ToolResult | null> {
  const policy = getSessionPolicy(host);
  if (policy.access === 'read-only' && MUTATING_TOOLS.has(tool)) {
    return failureResult(formatError(ERROR_CODES.READ_ONLY, `this session is read-only, so ${tool} was not dispatched. Read what you need, then open a write session with browser_tabs {action:"session", access:"full"}.`));
  }
  if (policy.isolation !== 'isolated') return null;
  const tabId = typeof params.tabId === 'number' ? params.tabId : undefined;
  if (tabId === undefined) return null;
  let owned = await ownedTabs(host, false);
  if (!owned.has(tabId)) {
    // A miss may be a tab the session opened a moment ago: read the list again.
    owned = await ownedTabs(host, true);
    if (!owned.has(tabId)) {
      return failureResult(formatError(ERROR_CODES.TAB_NOT_OWNED, `tab ${tabId} does not belong to this session, so ${tool} was not dispatched. In isolated mode the agent only touches the tabs it opened: open one with browser_navigate, or switch back with browser_tabs {action:"session", isolation:"trusted"}.`));
    }
  }
  return null;
}

/**
 * The tab listing an isolated session sees: its own tabs only.
 *
 * The extension lists every tab it can see, and in isolated mode the user has
 * no business in the agent's window: the other tabs are counted, not shown.
 */
export function isolateTabListing(text: string): string {
  const kept: string[] = [];
  let hidden = 0;
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!ANY_TAB_LINE.test(trimmed)) {
      kept.push(line);
      continue;
    }
    if (OWNED_LINE.test(trimmed)) kept.push(line);
    else hidden += 1;
  }
  if (hidden === 0) return text;
  kept.push(`+${hidden} tab(s) hidden: this session is isolated (browser_tabs {action:"session", isolation:"trusted"} shows them)`);
  return kept.join('\n');
}
