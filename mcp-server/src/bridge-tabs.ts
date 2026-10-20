import type { ExtensionConnections } from './bridge-connections.js';

/**
 * browser_tabs across several Chrome profiles (the bridge answers the browser
 * part itself, the extension lists the tabs). `browser` first selects this
 * session's browser ("auto" = the default). A list then starts with one line
 * per connected browser when more than one is connected.
 *
 * `forward` sends the rest of the call (without `browser`) to the extension.
 */
export async function tabsAcrossBrowsers(
  conns: ExtensionConnections,
  params: Record<string, unknown>,
  sessionId: string | undefined,
  forward: (params: Record<string, unknown>) => Promise<unknown>,
): Promise<unknown> {
  const { browser, ...rest } = params;
  if (browser !== undefined) conns.select(sessionId, browser);
  const result = await forward(rest);
  if ((rest.action ?? 'list') !== 'list') return result;
  const text = (result as { text?: unknown } | null)?.text;
  const browsers = conns.list(sessionId).browsers as Array<{ browserId: string; label: string; selected?: boolean }>;
  if (typeof text !== 'string' || browsers.length < 2) return result;
  const lines = browsers.map((b) => `browser ${b.browserId} "${b.label}"${b.selected ? ' (selected)' : ''}`);
  return { ...(result as Record<string, unknown>), text: `${lines.join('\n')}\n\n${text}` };
}
