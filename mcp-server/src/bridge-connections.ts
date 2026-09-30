import { WebSocket } from 'ws';

/**
 * One connected extension = one browser (profile). Several can be connected
 * at once (multi-browser); a reconnect of the same browser replaces its old
 * socket. Legacy extensions that send no browserId all count as "default".
 */
export interface ExtensionConnection {
  ws: WebSocket;
  browserId: string;
  label: string;
  state: 'pending' | 'ready' | 'legacy' | 'incompatible';
  handshakeTimer: ReturnType<typeof setTimeout> | null;
  missedPongs: number;
  connectedAt: number;
}

/** Tools the bridge answers itself (browser selection), never forwarded to an extension. */
export const BRIDGE_TOOLS = new Set(['browser_list_browsers', 'browser_select_browser']);

export function newConnection(ws: WebSocket): ExtensionConnection {
  return {
    ws, browserId: 'default', label: 'default', state: 'pending',
    handshakeTimer: null, missedPongs: 0, connectedAt: Date.now(),
  };
}

/** Normalised identity from an extension helloAck (absent = legacy "default"). */
export function identityOf(info?: { browserId?: unknown; browserLabel?: unknown }): { browserId: string; label: string } {
  const browserId = typeof info?.browserId === 'string' && info.browserId.trim() ? info.browserId.trim().slice(0, 64) : 'default';
  const label = typeof info?.browserLabel === 'string' && info.browserLabel.trim() ? info.browserLabel.trim().slice(0, 120) : browserId;
  return { browserId, label };
}

/**
 * The set of extension connections plus each session's browser choice.
 * Routing: a session's selected browser, else the default — the most
 * recently connected live browser (so one browser behaves exactly as before).
 */
export class ExtensionConnections {
  private conns = new Set<ExtensionConnection>();
  /** sessionId -> browserId chosen with browser_select_browser. */
  private sessionBrowser = new Map<string, string>();

  add(conn: ExtensionConnection): void { this.conns.add(conn); }
  has(conn: ExtensionConnection): boolean { return this.conns.has(conn); }
  delete(conn: ExtensionConnection): boolean { return this.conns.delete(conn); }
  all(): ExtensionConnection[] { return [...this.conns]; }

  static isLive(conn: ExtensionConnection): boolean {
    return (conn.state === 'ready' || conn.state === 'legacy') && conn.ws.readyState === WebSocket.OPEN;
  }

  live(): ExtensionConnection[] {
    return this.all().filter((c) => ExtensionConnections.isLive(c));
  }

  /** The default browser: the most recently connected live one. */
  primary(): ExtensionConnection | null {
    let best: ExtensionConnection | null = null;
    for (const c of this.live()) if (!best || c.connectedAt >= best.connectedAt) best = c;
    return best;
  }

  /** Where a session's calls go: its selected browser, else the default one. */
  forSession(sessionId?: string): ExtensionConnection {
    const want = sessionId ? this.sessionBrowser.get(sessionId) : undefined;
    if (want) {
      const chosen = this.live().find((c) => c.browserId === want);
      if (chosen) return chosen;
      throw new Error(`Selected browser "${want}" is not connected. browser_list_browsers shows the connected ones (browser_select_browser "auto" = default).`);
    }
    const primary = this.primary();
    if (!primary) throw new Error('Chrome extension not connected. Make sure the Browser Controller extension is installed and enabled.');
    return primary;
  }

  /** Other sockets of the same browser (a reconnect replaces them). */
  siblingsOf(conn: ExtensionConnection): ExtensionConnection[] {
    return this.all().filter((c) => c !== conn && c.browserId === conn.browserId);
  }

  /** browser_list_browsers: every connected extension, with this session's choice. */
  list(sessionId?: string): Record<string, unknown> {
    const primary = this.primary();
    const selected = sessionId ? this.sessionBrowser.get(sessionId) : undefined;
    return {
      success: true,
      browsers: this.live().map((c) => ({
        browserId: c.browserId,
        label: c.label,
        connectedAt: new Date(c.connectedAt).toISOString(),
        ...(c === primary ? { default: true } : {}),
        ...((selected ? selected === c.browserId : c === primary) ? { selected: true } : {}),
      })),
      ...(selected ? { selectedBrowserId: selected } : {}),
    };
  }

  /** browser_select_browser: route this session's calls to one browser ("auto" = default). */
  select(sessionId: string | undefined, browserId: unknown): Record<string, unknown> {
    if (!sessionId) throw new Error('Selecting a browser needs a client session (connect through the Browser Controller MCP server).');
    const id = typeof browserId === 'string' ? browserId.trim() : '';
    if (!id || id === 'auto') {
      this.sessionBrowser.delete(sessionId);
      return { success: true, selected: 'auto', browserId: this.primary()?.browserId ?? null };
    }
    const conn = this.live().find((c) => c.browserId === id || c.label === id);
    if (!conn) throw new Error(`No connected browser "${id}". browser_list_browsers shows the connected ones.`);
    this.sessionBrowser.set(sessionId, conn.browserId);
    return { success: true, selected: conn.browserId, label: conn.label };
  }

  releaseSession(sessionId: string): void { this.sessionBrowser.delete(sessionId); }

  clear(): void {
    this.conns.clear();
    this.sessionBrowser.clear();
  }
}
