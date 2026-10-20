import { WebSocket } from 'ws';

/**
 * One connected extension = one browser (profile). Several can be connected
 * at once (multi-browser); a reconnect of the same browser replaces its old
 * socket. A helloAck that carries no browserId counts as "default".
 */
export interface ExtensionConnection {
  ws: WebSocket;
  browserId: string;
  label: string;
  state: 'pending' | 'ready' | 'incompatible';
  handshakeTimer: ReturnType<typeof setTimeout> | null;
  missedPongs: number;
  connectedAt: number;
}

export function newConnection(ws: WebSocket): ExtensionConnection {
  return {
    ws, browserId: 'default', label: 'default', state: 'pending',
    handshakeTimer: null, missedPongs: 0, connectedAt: Date.now(),
  };
}

/** Normalised identity from an extension helloAck (absent = "default"). */
export function identityOf(info?: { browserId?: unknown; browserLabel?: unknown }): { browserId: string; label: string } {
  const browserId = typeof info?.browserId === 'string' && info.browserId.trim() ? info.browserId.trim().slice(0, 64) : 'default';
  const label = typeof info?.browserLabel === 'string' && info.browserLabel.trim() ? info.browserLabel.trim().slice(0, 120) : browserId;
  return { browserId, label };
}

/**
 * The set of extension connections plus each session's browser choice.
 * Routing: a session's selected browser, else the default — the earliest-seen
 * live browser (see primary). An "auto" session is pinned to the browser its
 * first call went to: tab ids belong to one browser, so a browser connecting
 * mid-session (or mid-batch, or between a call and its retry) must not take
 * over that session's calls.
 */
export class ExtensionConnections {
  private conns = new Set<ExtensionConnection>();
  /** browserId -> epoch ms this daemon first saw that browser. Kept across reconnects. */
  private firstSeen = new Map<string, number>();
  /** sessionId -> browserId chosen with browser_tabs {browser}. */
  private sessionBrowser = new Map<string, string>();
  /** sessionId -> browserId an "auto" session was pinned to by its first call. */
  private autoBrowser = new Map<string, string>();

  add(conn: ExtensionConnection): void { this.conns.add(conn); }
  has(conn: ExtensionConnection): boolean { return this.conns.has(conn); }
  delete(conn: ExtensionConnection): boolean { return this.conns.delete(conn); }
  all(): ExtensionConnection[] { return [...this.conns]; }

  static isLive(conn: ExtensionConnection): boolean {
    return conn.state === 'ready' && conn.ws.readyState === WebSocket.OPEN;
  }

  live(): ExtensionConnection[] {
    return this.all().filter((c) => ExtensionConnections.isLive(c));
  }

  /**
   * A connection's browser identity is now known (its helloAck). Only the
   * first sighting of a browserId counts: a reconnect (service-worker recycle)
   * of the same browser keeps its place.
   */
  identify(conn: ExtensionConnection, browserId: string): void {
    conn.browserId = browserId;
    if (!this.firstSeen.has(browserId)) this.firstSeen.set(browserId, Date.now());
  }

  /**
   * The default browser: the earliest-seen live one. Connecting a second
   * browser, or recycling the default's service worker, never moves it, so new
   * sessions keep landing on the same browser.
   */
  primary(): ExtensionConnection | null {
    let best: ExtensionConnection | null = null;
    let bestSeen = Infinity;
    for (const c of this.live()) {
      const seen = this.firstSeen.get(c.browserId) ?? c.connectedAt;
      if (!best || seen < bestSeen) {
        best = c;
        bestSeen = seen;
      }
    }
    return best;
  }

  /** Where a session's calls go: its selected browser, else the default one. */
  forSession(sessionId?: string): ExtensionConnection {
    const want = sessionId ? this.sessionBrowser.get(sessionId) : undefined;
    if (want) {
      const chosen = this.live().find((c) => c.browserId === want);
      if (chosen) return chosen;
      throw new Error(`NOT_CONNECTED: Selected browser "${want}" is not connected. browser_tabs with browser "auto" selects the default one.`);
    }
    const pinned = sessionId ? this.autoBrowser.get(sessionId) : undefined;
    if (pinned) {
      const same = this.live().find((c) => c.browserId === pinned);
      if (same) return same;
      // Its browser is gone: moving on to another browser is only safe when
      // no other one could be confused with it — never switch silently.
      if (this.live().length > 0) {
        throw new Error(`NOT_CONNECTED: This session's browser "${pinned}" disconnected. Its tab ids are not valid in the other connected browser(s): reconnect it, or pick another browser with browser_tabs and its browser parameter to continue there.`);
      }
    }
    const primary = this.primary();
    if (!primary) throw new Error('NOT_CONNECTED: Chrome extension not connected. Make sure the Browser Controller extension is installed and enabled.');
    if (sessionId) this.autoBrowser.set(sessionId, primary.browserId);
    return primary;
  }

  /** Other sockets of the same browser (a reconnect replaces them). */
  siblingsOf(conn: ExtensionConnection): ExtensionConnection[] {
    return this.all().filter((c) => c !== conn && c.browserId === conn.browserId);
  }

  /** browser_tabs list: every connected extension, with this session's choice. */
  list(sessionId?: string): Record<string, unknown> {
    const primary = this.primary();
    const selected = sessionId ? (this.sessionBrowser.get(sessionId) ?? this.autoBrowser.get(sessionId)) : undefined;
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
      ...(sessionId && !this.sessionBrowser.has(sessionId) && selected ? { pinnedAuto: true } : {}),
    };
  }

  /** browser_tabs {browser}: route this session's calls to one browser ("auto" = default). */
  select(sessionId: string | undefined, browserId: unknown): Record<string, unknown> {
    if (!sessionId) throw new Error('INVALID_ARGUMENT: Selecting a browser needs a client session (connect through the Browser Controller MCP server).');
    const id = typeof browserId === 'string' ? browserId.trim() : '';
    if (!id || id === 'auto') {
      // "auto" again re-pins the session to the current default.
      this.autoBrowser.delete(sessionId);
      this.sessionBrowser.delete(sessionId);
      return { success: true, selected: 'auto', browserId: this.primary()?.browserId ?? null };
    }
    const conn = this.live().find((c) => c.browserId === id || c.label === id);
    // A failed selection changes nothing: the session keeps its pin.
    if (!conn) throw new Error(`NOT_CONNECTED: No connected browser "${id}". browser_tabs lists the connected ones.`);
    this.autoBrowser.delete(sessionId);
    this.sessionBrowser.set(sessionId, conn.browserId);
    return { success: true, selected: conn.browserId, label: conn.label };
  }

  releaseSession(sessionId: string): void {
    this.sessionBrowser.delete(sessionId);
    this.autoBrowser.delete(sessionId);
  }

  clear(): void {
    this.conns.clear();
    this.firstSeen.clear();
    this.sessionBrowser.clear();
    this.autoBrowser.clear();
  }
}
