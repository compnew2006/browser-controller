import { defaultBrowserLabel, normalizeBrowserLabel } from './connection-transport.js';

export const browserIdentity = {};

export function restoreBrowserIdentity(stored) {
  let browserId = stored.bcBrowserId;
  if (!browserId) {
    browserId = (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2)).replace(/-/g, '').slice(0, 12);
    chrome.storage.local.set({ bcBrowserId: browserId });
  }
  const label = normalizeBrowserLabel(stored.bcBrowserLabel);
  Object.assign(browserIdentity, { browserId, browserLabel: label || defaultBrowserLabel(browserId) });
  return browserIdentity;
}

export async function saveBrowserLabel(value, reconnect) {
  const label = normalizeBrowserLabel(value);
  if (label === null) return { success: false, error: 'Profile name must be 64 characters or fewer.' };
  try {
    await chrome.storage.local.set({ bcBrowserLabel: label });
  } catch {
    return { success: false, error: 'Could not save the profile name.' };
  }

  const browserLabel = label || (browserIdentity.browserId ? defaultBrowserLabel(browserIdentity.browserId) : '');
  const changed = browserLabel !== browserIdentity.browserLabel;
  Object.assign(browserIdentity, { browserLabel });
  if (changed) reconnect();
  return { success: true, browserLabel };
}
