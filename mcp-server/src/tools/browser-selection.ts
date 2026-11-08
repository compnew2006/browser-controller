import type { ToolHost } from './types.js';
import { ERROR_CODES, formatError } from '../core/error-codes.js';

interface BrowserInfo {
  id: string;
  label: string;
  hasOpenTabs: boolean | null;
}

/** Read connected browser identities and tab availability without selecting a profile. */
export async function connectedBrowsers(host: ToolHost): Promise<BrowserInfo[] | null> {
  try {
    const raw = await host.callTool('browser_tabs', { action: 'profiles' }) as Record<string, unknown>;
    if (Array.isArray(raw?.browsers)) {
      return raw.browsers.flatMap((value): BrowserInfo[] => {
        if (!value || typeof value !== 'object') return [];
        const profile = value as Record<string, unknown>;
        if (typeof profile.browserId !== 'string' || typeof profile.label !== 'string') return [];
        return [{
          id: profile.browserId,
          label: profile.label,
          hasOpenTabs: typeof profile.hasOpenTabs === 'boolean' ? profile.hasOpenTabs : null,
        }];
      });
    }
  } catch { /* Older daemons do not have the read-only profiles action. */ }

  // Compatibility with older daemons: this list does not include per-profile
  // tab availability, but importantly it does not probe or rebind other profiles.
  try {
    const raw = await host.callTool('browser_tabs', { action: 'list' }) as Record<string, unknown>;
    const text = typeof raw?.text === 'string' ? raw.text : '';
    return text.split('\n').flatMap((line): BrowserInfo[] => {
      const match = /^browser (\S+) ("(?:[^"\\]|\\.)*")(?:\s+\((?:default|selected)(?:, (?:default|selected))*\))?$/.exec(line.trim());
      if (!match) return [];
      try {
        const label = JSON.parse(match[2]);
        return typeof label === 'string' ? [{ id: match[1], label, hasOpenTabs: null }] : [];
      } catch {
        return [];
      }
    });
  } catch {
    return null;
  }
}

/**
 * Chrome's own "No current window" reaches the agent as a bare internal error,
 * and the way out (another browser) is not in the message. This finds a browser
 * that has a window and says so, instead of leaving the agent to try them one
 * by one.
 */
export async function explainNoWindow(host: ToolHost, message: string): Promise<string> {
  const browsers = await connectedBrowsers(host);
  const head = formatError(ERROR_CODES.NOT_CONNECTED, `the selected browser has no open window (Chrome said "${message}").`);
  if (browsers === null) {
    return `${head} Could not inspect the connected browser profiles. Run browser_tabs {action:"profiles"} to check them, then select the intended profile explicitly.`;
  }
  const open = browsers.filter((browser) => browser.hasOpenTabs === true);
  if (open.length > 0) {
    const choices = open.map((browser) => `${browser.id} ${JSON.stringify(browser.label)}`).join(', ');
    return `${head} Connected profiles with open tabs: ${choices}. Select the intended profile with browser_tabs {browser:"<browserId>"}, then list its tabs.`;
  }
  if (browsers.length > 0 && browsers.every((browser) => browser.hasOpenTabs === false)) {
    return `${head} No connected profile currently has a readable open tab. Open a regular Chrome tab in the intended profile and retry.`;
  }
  if (browsers.length === 0) {
    return `${head} Connected profile details are unavailable. Check the Browser Controller connection, then run browser_tabs {action:"profiles"}.`;
  }
  const all = browsers.map((browser) => `${browser.id} ${JSON.stringify(browser.label)}`).join(', ');
  return `${head} Connected browser profiles: ${all}. Their open-tab status is unavailable; run browser_tabs {action:"profiles"} and select a listed browserId.`;
}

/** Whether a message is Chrome's "no current window". */
export function isNoWindow(message: string): boolean {
  return /no current window/i.test(message);
}
