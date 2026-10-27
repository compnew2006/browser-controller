/**
 * Tab handler (extracted from background.js): browser_tabs list / close / focus.
 * Tabs are opened and reloaded by browser_navigate (handlers/navigation.js); the
 * screenshot is handlers/screenshot.js, the page logs handlers/logs.js.
 */
import { resolveTab } from '../lib/page-exec.js';
import { tabLocks, tabControl } from '../lib/state.js';
import { releaseTabUi } from '../lib/lock-ops.js';
import { tabLockedMessage } from '../lib/tab-concurrency.js';
import { isPrivateVaultTab, isPrivateVaultUrl } from '../lib/vault-actions.js';

/**
 * A locked tab belongs to its owner session: closing or focusing it from another session
 * (or an anonymous caller) would undo the work the lock exists to protect. Refused at once with TAB_LOCKED.
 */
function refuseLocked(tabId, sessionId) {
  const grant = tabLocks.grantOf(tabId);
  if (grant && grant.sessionId !== sessionId) throw new Error(tabLockedMessage(tabId, grant));
}

/** Clip to `max` characters; the last one becomes an ellipsis. */
const clip = (text, max) => (text.length <= max ? text : `${text.slice(0, max - 1)}…`);

/** host + path of a web address, 80 characters at most. Other addresses are shown as they are. */
function addressOf(raw) {
  const text = String(raw || '');
  let u;
  try { u = new URL(text); } catch { return clip(text, 80); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return clip(text, 80);
  return clip(`${u.host}${u.pathname === '/' ? '' : u.pathname}`, 80);
}

/** The title on one line, 60 characters at most, in quotes. */
const titleOf = (tab) => `"${clip(String(tab.title || '').replace(/\s+/g, ' ').trim(), 60)}"`;

/**
 * browser_tabs list. The session's own tabs first, then the user's focused tab.
 * Tabs another session owns or is driving are only counted: their titles and
 * addresses belong to that agent (L4). The other user tabs are listed as [other].
 * ALL windows are queried: "current window" is ill-defined in an MV3
 * service worker, and windowId disambiguates tabs across windows.
 */
async function listTabs(sessionId) {
  const [tabs, focused] = await Promise.all([
    chrome.tabs.query({}),
    chrome.tabs.query({ active: true, lastFocusedWindow: true }),
  ]);
  const focusedId = focused[0]?.id;
  const own = [];
  const user = [];
  let otherAgents = 0;
  const rest = [];
  for (const tab of tabs) {
    if (isPrivateVaultTab(tab.id) || isPrivateVaultUrl(tab.url)) continue;
    const owner = tabLocks.owner(tab.id);
    // Another session driving an unowned tab right now (or within the last 30s) counts as its tab.
    const driver = tabControl.controller(tab.id)?.sessionId ?? null;
    if (owner !== undefined && owner === sessionId) own.push(tab);
    else if (owner !== undefined || (driver && driver !== sessionId)) otherAgents += 1;
    else if (tab.id === focusedId) user.push(tab);
    else rest.push(tab);
  }
  const line = (tab, role) => `${tab.id} [${role}${tab.incognito ? ', incognito' : ''}] ${titleOf(tab)} ${addressOf(tab.url)}`;
  const lines = [
    ...own.map((t) => line(t, 'own')),
    ...user.map((t) => line(t, 'user, focused')),
    ...rest.map((t) => line(t, 'other')),
  ];
  if (otherAgents) lines.push(`+${otherAgents} ${otherAgents === 1 ? 'tab' : 'tabs'} used by other agents`);
  const roleOf = (role) => (tab) => ({ tabId: tab.id, role });
  return {
    success: true,
    text: lines.length ? lines.join('\n') : 'no tabs',
    tabs: [...own.map(roleOf('own')), ...user.map(roleOf('user'))],
    otherAgentTabs: otherAgents,
  };
}

/** close and focus name the tab they act on. */
function requireTabId(tabId, action) {
  if (typeof tabId !== 'number') {
    throw new Error(`INVALID_ARGUMENT: tabId is required for ${action}. Call browser_tabs list first.`);
  }
  return tabId;
}

export async function handleTabs(params, sessionId) {
  const { action = 'list', tabId } = params;
  switch (action) {
    case 'list':
      return listTabs(sessionId);
    case 'close': {
      const id = requireTabId(tabId, 'close');
      refuseLocked(id, sessionId);
      await resolveTab(id);
      await chrome.tabs.remove(id);
      releaseTabUi(id); // release + persist + shield removal
      return { success: true, text: `closed tab ${id}`, closed: id };
    }
    case 'focus': {
      const id = requireTabId(tabId, 'focus');
      refuseLocked(id, sessionId);
      const tab = await resolveTab(id);
      await chrome.tabs.update(id, { active: true });
      // Its window comes to the front too (OS focus).
      if (tab.windowId != null) await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
      return { success: true, text: `focused tab ${id}`, focused: id };
    }
    default:
      throw new Error(`INVALID_ARGUMENT: unknown action "${action}". Use list, close or focus; browser_navigate opens and reloads tabs.`);
  }
}
