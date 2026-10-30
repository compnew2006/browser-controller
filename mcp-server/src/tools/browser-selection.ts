import type { ToolHost } from './types.js';

interface BrowserInfo {
  id: string;
  label: string;
}

/** The browsers the daemon has connected, with their labels. */
export async function connectedBrowsers(host: ToolHost): Promise<BrowserInfo[]> {
  try {
    const raw = await host.callTool('browser_tabs', { action: 'list' }) as Record<string, unknown>;
    const text = typeof raw?.text === 'string' ? raw.text : '';
    const browsers: BrowserInfo[] = [];
    for (const line of text.split('\n')) {
      const match = /^browser (\S+) "(.*)"(?:\s+\(selected\))?$/.exec(line.trim());
      if (match) browsers.push({ id: match[1], label: match[2] });
    }
    return browsers;
  } catch {
    return [];
  }
}

/** The tabs a browser has: a browser with no open window has none. */
async function tabCount(host: ToolHost, browserId: string): Promise<number> {
  try {
    const raw = await host.callTool('browser_tabs', { action: 'list', browser: browserId }) as Record<string, unknown>;
    const text = typeof raw?.text === 'string' ? raw.text : '';
    return text.split('\n').filter((line) => /^\d+\s+\[/.test(line.trim())).length;
  } catch {
    return 0;
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
  const open: string[] = [];
  for (const browser of browsers) {
    if (await tabCount(host, browser.id) > 0) open.push(`${browser.id} "${browser.label}"`);
  }
  const head = `NOT_CONNECTED: the selected browser has no open window (Chrome said "${message}").`;
  if (open.length > 0) {
    return `${head} A browser with an open window: ${open.join(', ')}. Select it with browser_tabs {browser:"<id>"} and retry.`;
  }
  const all = browsers.map((browser) => `${browser.id} "${browser.label}"`).join(', ');
  return `${head} Connected browsers: ${all || '(none)'}. None of them has an open window: open one in Chrome, then retry.`;
}

/** Whether a message is Chrome's "no current window". */
export function isNoWindow(message: string): boolean {
  return /no current window/i.test(message);
}
