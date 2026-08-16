import { vi, describe, it, expect, beforeEach } from 'vitest';

/**
 * First behavior tests for the extension side (architecture item: background
 * logic was never importable by any test). The module split makes the router
 * + state importable under vitest with a chrome.* mock; the connection module
 * is mocked so the router's outgoing WS frames are observable.
 */

const sent = vi.hoisted(() => [] as Array<Record<string, unknown>>);

vi.mock('../extension/lib/connection.js', () => ({
  sendJson: (obj: Record<string, unknown>) => { sent.push(obj); },
  updateBadge: () => {},
  broadcastStatus: async () => {},
  isWsConnected: () => true,
  setCurrentActivity: () => {},
}));

// chrome.* mock — must exist before any handler runs (module evaluation of the
// handler modules never touches chrome; only function bodies do).
const tabStore = new Map<number, { id: number; windowId: number; url: string; title: string; active: boolean }>();
(globalThis as unknown as { chrome: unknown }).chrome = {
  tabs: {
    get: async (id: number) => tabStore.get(id) ?? Promise.reject(new Error(`No tab ${id}`)),
    query: async () => [] as unknown[],
    update: async () => ({}),
    remove: async () => ({}),
    create: async () => ({}),
  },
  scripting: { executeScript: async () => [{ result: null }] },
  action: { setBadgeBackgroundColor: () => {}, setBadgeText: () => {} },
  storage: {
    session: { get: async () => ({}), set: async () => {} },
    local: { get: async () => ({}), set: async () => {} },
  },
  runtime: { sendMessage: async () => {}, onMessage: { addListener: () => {} } },
  alarms: { create: () => {}, onAlarm: { addListener: () => {} } },
  webRequest: { onCompleted: { addListener: () => {} } },
  debugger: { attach: async () => {}, detach: async () => {}, sendCommand: async () => ({}) },
};

const { handleMessage, dispatchedTools } = await import('../extension/lib/router.js');
const { tabLocks } = await import('../extension/lib/state.js');
const { allTools } = await import('../mcp-server/src/tools/index.js');

function lastFrame(): Record<string, unknown> {
  return sent[sent.length - 1]!;
}

/** The runOnTab path (tabId present) is fire-and-forget in handleMessage —
 *  let the mutex + overlay chain settle before asserting on the reply. */
async function flush(ms = 60): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

describe('extension router (handleMessage)', () => {
  beforeEach(() => {
    sent.length = 0;
    tabStore.clear();
    tabLocks.unlockAll();
    tabStore.set(3, { id: 3, windowId: 1, url: 'https://example.com/page', title: 'Page', active: true });
  });

  it('answers an unknown tool with a wire-level error', async () => {
    await handleMessage({ id: 'n1', tool: 'browser_nope', params: {} });
    expect(lastFrame()).toMatchObject({ id: 'n1', success: false });
    expect((lastFrame().error as string)).toContain('Unknown tool');
  });

  it('marks in-band {success:false} results as wire failures WITH the payload (unified error channel)', async () => {
    // browser_wait without selector/delay returns in-band {success:false} —
    // the router must send success:false + the payload as `result`, not wrap
    // it in a success envelope.
    await handleMessage({ id: 'w1', tool: 'browser_wait', params: { tabId: 3 }, sessionId: 's1' });
    await flush();
    const frame = lastFrame();
    expect(frame.id).toBe('w1');
    expect(frame.success).toBe(false);
    expect(frame.error).toBe('Need selector or delay');
    expect(frame.result).toEqual({ success: false, error: 'Need selector or delay' });
  });

  it('converts a THROWN handler error into a wire-level error', async () => {
    // click with neither ref nor selector throws in requireTarget.
    await handleMessage({ id: 'c1', tool: 'browser_click', params: { tabId: 3 }, sessionId: 's1' });
    await flush();
    const frame = lastFrame();
    expect(frame.id).toBe('c1');
    expect(frame.success).toBe(false);
    expect((frame.error as string)).toContain('ref or selector is required');
  });

  it('routes a successful tool through the mutex and replies success', async () => {
    await handleMessage({ id: 'k1', tool: 'browser_console', params: { tabId: 3 }, sessionId: 's1' });
    await flush();
    const frame = lastFrame();
    expect(frame.id).toBe('k1');
    expect(frame.success).toBe(true);
    expect((frame.result as { messages: unknown[] }).messages).toEqual([]);
  });

  it('honors tab-lock ownership: a non-owner call waits instead of running (TOCTOU fix, end-to-end)', async () => {
    tabLocks.lock(3, 'ownerA');
    await handleMessage({ id: 'k2', tool: 'browser_console', params: { tabId: 3 }, sessionId: 'sessionB' });
    // No reply yet — B is queued behind owner A's lock.
    expect(sent.filter((f) => f.id === 'k2')).toEqual([]);
    tabLocks.unlock(3, 'ownerA');
    await new Promise((r) => setTimeout(r, 120));
    const frame = sent.find((f) => f.id === 'k2');
    expect(frame?.success).toBe(true);
  });
});

describe('dispatch registry ↔ MCP tool registry (drift guard)', () => {
  it('every registered MCP tool has an extension handler', () => {
    for (const tool of allTools) {
      expect(dispatchedTools, `${tool.name} has no extension handler`).toContain(tool.name);
    }
  });

  it('dispatches exactly the known tool set (no stray handlers)', () => {
    // 22 wire tools; the meta tool (browser_tools) is server-local by design.
    expect(dispatchedTools.length).toBe(allTools.length);
  });
});
