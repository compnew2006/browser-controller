import type { ExtensionConnections } from './bridge-connections.js';
import { ERROR_CODES, formatError } from './core/error-codes.js';

/**
 * browser_tabs across several Chrome profiles (the bridge answers the browser
 * part itself, the extension lists the tabs). `browser` first selects this
 * session's browser ("auto" = the default). A list then starts with one line
 * per connected browser when more than one is connected.
 *
 * `forward` sends the rest of a call to the session's selected extension.
 * `inspect` reads a specific extension directly, without changing that session's selection.
 */
export async function tabsAcrossBrowsers(
  conns: ExtensionConnections,
  params: Record<string, unknown>,
  sessionId: string | undefined,
  forward: (params: Record<string, unknown>) => Promise<unknown>,
  inspect: (browserId: string, params: Record<string, unknown>) => Promise<unknown>,
): Promise<unknown> {
  const { browser, ...rest } = params;
  const action = (rest.action ?? 'list') as string;

  if (action === 'profiles') {
    if (!sessionId) throw new Error(formatError(ERROR_CODES.INVALID_ARGUMENT, 'Listing browser profiles needs a client session.'));
    if (browser !== undefined) throw new Error(formatError(ERROR_CODES.INVALID_ARGUMENT, 'browser cannot be combined with action "profiles".'));
    const listing = conns.list(sessionId) as {
      browsers: Array<{ browserId: string; label: string; default: boolean; selected: boolean }>;
      defaultBrowserId: string | null;
      selectedBrowserId: string | null;
      pinnedAuto?: boolean;
    };
    const browsers = await Promise.all(listing.browsers.map(async (profile) => {
      let hasOpenTabs: boolean | null = null;
      try {
        const result = await inspect(profile.browserId, { action: 'list' }) as Record<string, unknown>;
        if (typeof result?.openTabCount === 'number' && Number.isFinite(result.openTabCount)) {
          hasOpenTabs = result.openTabCount > 0;
        }
      } catch {
        // A profile may disconnect while the list is being collected.
      }
      return { ...profile, hasOpenTabs };
    }));
    const lines = browsers.map((profile) => {
      const state = profile.hasOpenTabs === null ? 'open tabs: unknown' : `open tabs: ${profile.hasOpenTabs ? 'yes' : 'no'}`;
      return `${browserLine(profile)} · ${state}`;
    });
    return {
      success: true,
      text: lines.length ? lines.join('\n') : 'no connected browser profiles',
      browsers,
      defaultBrowserId: listing.defaultBrowserId,
      selectedBrowserId: listing.selectedBrowserId,
      ...(listing.pinnedAuto ? { pinnedAuto: true } : {}),
    };
  }

  if (browser !== undefined) conns.select(sessionId, browser);
  const result = await forward(rest);
  if (action !== 'list') return result;
  const text = (result as { text?: unknown } | null)?.text;
  const listing = conns.list(sessionId) as {
    browsers: Array<{ browserId: string; label: string; default: boolean; selected: boolean }>;
    defaultBrowserId: string | null;
    selectedBrowserId: string | null;
    pinnedAuto?: boolean;
  };
  if (typeof text !== 'string') return result;
  return {
    ...(result as Record<string, unknown>),
    ...(listing.browsers.length > 1 ? { text: `${listing.browsers.map(browserLine).join('\n')}\n\n${text}` } : {}),
    browsers: listing.browsers,
    defaultBrowserId: listing.defaultBrowserId,
    selectedBrowserId: listing.selectedBrowserId,
    ...(listing.pinnedAuto ? { pinnedAuto: true } : {}),
  };
}

function browserLine(profile: { browserId: string; label: string; default: boolean; selected: boolean }): string {
  const markers = [profile.default ? 'default' : '', profile.selected ? 'selected' : ''].filter(Boolean);
  return `browser ${profile.browserId} ${JSON.stringify(profile.label)}${markers.length ? ` (${markers.join(', ')})` : ''}`;
}
