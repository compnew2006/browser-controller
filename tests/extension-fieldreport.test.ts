import { vi, describe, it, expect, beforeEach } from 'vitest';

/**
 * Field-report regressions:
 *  1. Frozen-tab deadlock — a page blocked by a native dialog pins its tab
 *     mutex forever (an in-flight executeScript can't be aborted), so EVERY
 *     tool routed through runOnTab deadlocked, including browser_tabs close.
 *     Close/focus now bypass the mutex: closing a tab must ALWAYS work — it
 *     is the operator's escape hatch.
 *  2. handle_dialog must reach an ALREADY-OPEN dialog via CDP (out-of-band,
 *     no page JS) instead of only pre-arming window.alert overrides — the
 *     state the tool exists for was unreachable.
 */

const sent = vi.hoisted(() => [] as Array<Record<string, unknown>>);
const injections = vi.hoisted(() => [] as Array<{ world?: string; func: string }>);
const cdpCommands = vi.hoisted(() => [] as string[]);
const dialogCommandsFail = vi.hoisted(() => ({ flag: false }));

vi.mock('../extension/lib/connection.js', () => ({
  sendJson: (obj: Record<string, unknown>) => { sent.push(obj); },
  updateBadge: () => {},
  broadcastStatus: async () => {},
  isWsConnected: () => true,
  setCurrentActivity: () => {},
}));

const tabStore = new Map<number, { id: number; url: string }>();
(globalThis as unknown as { chrome: unknown }).chrome = {
  tabs: {
    get: async (id: number) => tabStore.get(id) ?? Promise.reject(new Error(`No tab ${id}`)),
    query: async () => [],
    update: async () => ({}),
    remove: async (id: number) => { tabStore.delete(id); },
  },
  scripting: {
    executeScript: async (opts: { world?: string; func: () => void }) => {
      injections.push({ world: opts.world, func: opts.func.toString() });
      const src = opts.func.toString();
      const result = src.includes('__mcpDialogOverrides')
        ? { success: true, dialogs: [], message: 'Overrides configured' }
        : null;
      return [{ result }];
    },
  },
  debugger: {
    attach: async () => ({}),
    detach: async () => ({}),
    sendCommand: async (_t: unknown, method: string) => {
      cdpCommands.push(method);
      if (dialogCommandsFail.flag && method === 'Page.handleJavaScriptDialog') {
        throw new Error('No dialog is showing');
      }
      return {};
    },
  },
  action: { setBadgeBackgroundColor: () => {}, setBadgeText: () => {} },
  storage: { session: { get: async () => ({}), set: async () => {} }, local: { get: async () => ({}), set: async () => {} } },
  runtime: { sendMessage: async () => {}, onMessage: { addListener: () => {} } },
  alarms: { create: () => {}, onAlarm: { addListener: () => {} } },
  webRequest: { onCompleted: { addListener: () => {} } },
};

const { handleMessage } = await import('../extension/lib/router.js');
const { handleDialog } = await import('../extension/handlers/interaction.js');
const { tabMutex } = await import('../extension/lib/state.js');

const flush = (ms = 60) => new Promise((r) => setTimeout(r, ms));

describe('frozen-tab escape hatch (mutex bypass for tabs close/focus)', () => {
  beforeEach(() => {
    sent.length = 0;
    tabStore.clear();
    tabMutex.unlockAll?.();
    tabStore.set(3, { id: 3, url: 'https://legacy.example.com/console' });
  });

  it('browser_tabs close responds even when the tab mutex is pinned forever', async () => {
    // Simulate the frozen page: an action whose executeScript never settles
    // holds tab 3's mutex with no abort path.
    tabMutex.run(3, () => new Promise(() => {}));

    await handleMessage({ id: 'x1', tool: 'browser_tabs', params: { action: 'close', tabId: 3 }, sessionId: 's1' });
    await flush(80);

    const frame = sent.find((f) => f.id === 'x1');
    expect(frame, 'close must NOT queue behind the pinned mutex').toBeDefined();
    expect(frame!.success).toBe(true);
    expect(frame!.result).toMatchObject({ closed: 3 });
    expect(tabStore.has(3)).toBe(false);
  });

  it('browser_tabs focus also bypasses the pinned mutex', async () => {
    tabMutex.run(3, () => new Promise(() => {}));
    await handleMessage({ id: 'x2', tool: 'browser_tabs', params: { action: 'focus', tabId: 3 }, sessionId: 's1' });
    await flush(80);
    expect(sent.find((f) => f.id === 'x2')?.success).toBe(true);
  });

  it('a PAGE tool on the pinned tab still queues (mutex semantics preserved)', async () => {
    tabMutex.run(3, () => new Promise(() => {}));
    await handleMessage({ id: 'x3', tool: 'browser_console', params: { tabId: 3 }, sessionId: 's1' });
    await flush(80);
    expect(sent.find((f) => f.id === 'x3')).toBeUndefined(); // still queued — by design
  });
});

describe('handle_dialog reaches an ALREADY-OPEN dialog via CDP', () => {
  beforeEach(() => {
    cdpCommands.length = 0;
    injections.length = 0;
    dialogCommandsFail.flag = false;
  });

  it('dismisses an open dialog out-of-band (no page JS needed)', async () => {
    const res = await handleDialog({ tabId: 3, action: 'dismiss' });
    expect(cdpCommands).toContain('Page.handleJavaScriptDialog');
    expect(res).toMatchObject({ success: true, handled: 'open-dialog', action: 'dismiss' });
    // The override path must NOT have run — CDP already handled it.
    expect(injections.some((i) => i.func.includes('__mcpDialogOverrides'))).toBe(false);
  });

  it('falls back to arming overrides when no dialog is currently showing', async () => {
    dialogCommandsFail.flag = true; // CDP says: no dialog open
    const res = await handleDialog({ tabId: 3, action: 'accept' });
    expect(res.success).toBe(true);
    const overrideInjection = injections.find((i) => i.func.includes('__mcpDialogOverrides'));
    expect(overrideInjection, 'override pre-arm must run').toBeDefined();
    expect(overrideInjection!.world).toBe('MAIN');
  });
});
