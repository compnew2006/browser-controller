import { wedgedError } from './page-exec.js';
import { wedgedTabs } from './state.js';

/**
 * The private vault page's tabs, and the guarded page access every vault action shares: the
 * safe failure shape, the supported-origin rule, the top document, and a bounded script run.
 */

const VAULT_PAGE = 'vault/vault.html';
export const VAULT_PAGE_EXEC_TIMEOUT_MS = 8_000;
const privateVaultTabs = new Set();

export function isPrivateVaultUrl(raw) {
  try {
    const url = new URL(raw);
    return url.origin === new URL(chrome.runtime.getURL('')).origin && url.pathname === '/vault/vault.html';
  } catch {
    return false;
  }
}

export function safeFailure(code) {
  const messages = {
    VAULT_TARGET_UNSAFE: 'The page does not have one verified editable password field.',
    VAULT_ORIGIN_UNSUPPORTED: 'This page is not a supported vault target: fills work only on HTTPS sites and on loopback HTTP.',
    VAULT_PAGE_UNRESPONSIVE: 'The page did not respond before the vault action timed out.',
    VAULT_ORIGIN_MISMATCH: 'The page origin changed before the fill.',
    VAULT_DOCUMENT_CHANGED: 'The page changed before the fill.',
    VAULT_PERMISSION_DENIED: 'The private browser action is no longer valid.',
    VAULT_CONTEXT_PROTECTED: 'This page is protected by the credential vault.',
    INVALID_ARGUMENT: 'The private browser action is invalid.',
    VAULT_OUTCOME_UNKNOWN: 'The fill result is uncertain. Inspect the page before another explicit attempt.',
    VAULT_RECOVERY_REQUIRED: 'The browser protection state could not be saved. The page was left untouched.',
  };
  return { success: false, code, error: messages[code] || 'The private browser action could not be completed safely.' };
}

export function canonicalOrigin(raw) {
  let url;
  try { url = new URL(raw); } catch { throw new Error('VAULT_ORIGIN_UNSUPPORTED'); }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) {
    throw new Error('VAULT_ORIGIN_UNSUPPORTED');
  }
  if (url.username || url.password) throw new Error('VAULT_ORIGIN_UNSUPPORTED');
  return url.origin;
}

export async function getMainDocument(tabId) {
  const [tab, frame] = await Promise.all([
    chrome.tabs.get(tabId),
    chrome.webNavigation.getFrame({ tabId, frameId: 0 }),
  ]);
  if (!tab || typeof tab.url !== 'string' || !frame || typeof frame.documentId !== 'string' || !frame.documentId) {
    throw new Error('VAULT_DOCUMENT_CHANGED');
  }
  return { tab, frame, origin: canonicalOrigin(tab.url) };
}

export async function executeVaultScript(request, signal, timeoutMs = VAULT_PAGE_EXEC_TIMEOUT_MS) {
  const tabId = request.target.tabId;
  if (signal?.aborted) throw new Error('VAULT_PERMISSION_DENIED');
  const execution = chrome.scripting.executeScript(request);
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (error) reject(error);
      else if (signal?.aborted) reject(new Error('VAULT_PERMISSION_DENIED'));
      else resolve(value);
    };
    const timer = setTimeout(() => {
      wedgedTabs.set(tabId, Date.now());
      finish(wedgedError(tabId, timeoutMs));
    }, timeoutMs);
    const onAbort = () => finish(new Error('VAULT_PERMISSION_DENIED'));
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
    Promise.resolve(execution).then((value) => finish(null, value), (error) => finish(error));
  });
}

export function isPrivateVaultTab(tabId) {
  return privateVaultTabs.has(tabId);
}

export function isPrivateVaultSender(sender) {
  return !!sender && sender.id === chrome.runtime.id && sender.url === chrome.runtime.getURL(VAULT_PAGE);
}

export async function openPrivateVault(_requestId) {
  const url = chrome.runtime.getURL(VAULT_PAGE);
  const matches = await chrome.tabs.query({ url });
  const existing = matches.find((tab) => Number.isInteger(tab.id));
  if (existing) {
    registerPrivateVaultTab(existing.id);
    await chrome.tabs.update(existing.id, { active: true });
    if (existing.windowId != null) await chrome.windows.update(existing.windowId, { focused: true }).catch(() => {});
  } else {
    const created = await chrome.tabs.create({ url, active: true });
    registerPrivateVaultTab(created.id);
  }
  return { success: true };
}

export function registerPrivateVaultTab(tabId) {
  if (Number.isInteger(tabId)) privateVaultTabs.add(tabId);
}

export function forgetPrivateVaultTab(tabId) {
  return privateVaultTabs.delete(tabId);
}

export function clearPrivateVaultTabs() {
  privateVaultTabs.clear();
}
