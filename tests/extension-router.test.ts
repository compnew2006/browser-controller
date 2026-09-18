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
const { tabLocks, observationSnapshots } = await import('../extension/lib/state.js');
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
    observationSnapshots.clear();
    (globalThis as any).chrome.scripting.executeScript = async () => [{ result: null }];
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

describe('observe/act concurrency integration', () => {
  function register(snapshotId: string, tabId: number, sessionId: string) {
    observationSnapshots.register({
      snapshotId,
      tabId,
      sessionId,
      documentId: `d_${tabId}`,
      documentVersion: `d_${tabId}:1:0`,
      routeEpoch: 1,
      createdAt: Date.now(),
    });
  }

  function delayedActionExecutor(delayMs = 25) {
    let running = 0;
    let maxRunning = 0;
    (globalThis as any).chrome.scripting.executeScript = async (request: any) => {
      const config = request.args?.[0];
      if (!config?.snapshotId || !config?.params?.action) return [{ result: null }];
      running += 1;
      maxRunning = Math.max(maxRunning, running);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      running -= 1;
      return [{ result: {
        success: true,
        ok: true,
        action: config.params.action,
        ref: config.params.ref,
        documentVersion: `${config.documentId}:1:1`,
        url: `https://example.com/${request.target.tabId}`,
        metrics: { durationMs: delayMs, protocolCalls: 1 },
      } }];
    };
    return () => maxRunning;
  }

  beforeEach(() => {
    sent.length = 0;
    tabStore.clear();
    tabLocks.unlockAll();
    observationSnapshots.clear();
    tabStore.set(3, { id: 3, windowId: 1, url: 'https://example.com/3', title: 'Three', active: true });
    tabStore.set(4, { id: 4, windowId: 1, url: 'https://example.com/4', title: 'Four', active: false });
  });

  it('serializes simultaneous browser_act calls on the same tab', async () => {
    register('s_one', 3, 'session-a');
    register('s_two', 3, 'session-a');
    const maxRunning = delayedActionExecutor();

    await Promise.all([
      handleMessage({ id: 'a1', tool: 'browser_act', params: { tabId: 3, snapshotId: 's_one', action: 'focus', ref: 'e1' }, sessionId: 'session-a' }),
      handleMessage({ id: 'a2', tool: 'browser_act', params: { tabId: 3, snapshotId: 's_two', action: 'focus', ref: 'e2' }, sessionId: 'session-a' }),
    ]);
    await flush(140);

    expect(maxRunning()).toBe(1);
    expect(sent.filter((frame) => frame.id === 'a1' || frame.id === 'a2')).toHaveLength(2);
  });

  it('allows browser_act calls on different tabs to overlap', async () => {
    register('s_three', 3, 'session-a');
    register('s_four', 4, 'session-b');
    const maxRunning = delayedActionExecutor();

    await Promise.all([
      handleMessage({ id: 'b1', tool: 'browser_act', params: { tabId: 3, snapshotId: 's_three', action: 'focus', ref: 'e1' }, sessionId: 'session-a' }),
      handleMessage({ id: 'b2', tool: 'browser_act', params: { tabId: 4, snapshotId: 's_four', action: 'focus', ref: 'e1' }, sessionId: 'session-b' }),
    ]);
    await flush(100);

    expect(maxRunning()).toBe(2);
    expect(sent.filter((frame) => frame.id === 'b1' || frame.id === 'b2')).toHaveLength(2);
  });

  it('keeps same-tab observations independent across sessions', async () => {
    register('s_agent_a', 3, 'session-a');
    register('s_agent_b', 3, 'session-b');
    delayedActionExecutor(5);

    await handleMessage({ id: 'c1', tool: 'browser_act', params: { tabId: 3, snapshotId: 's_agent_a', action: 'focus', ref: 'e1' }, sessionId: 'session-a' });
    await handleMessage({ id: 'c2', tool: 'browser_act', params: { tabId: 3, snapshotId: 's_agent_b', action: 'focus', ref: 'e2' }, sessionId: 'session-b' });
    await flush(80);

    expect(sent.find((frame) => frame.id === 'c1')?.success).toBe(true);
    expect(sent.find((frame) => frame.id === 'c2')?.success).toBe(true);
  });

  it('rejects cross-session snapshot use before page action execution', async () => {
    register('s_private', 3, 'session-a');
    let actionExecutions = 0;
    (globalThis as any).chrome.scripting.executeScript = async (request: any) => {
      if (request.args?.[0]?.params?.action) actionExecutions += 1;
      return [{ result: null }];
    };

    await handleMessage({
      id: 'd1', tool: 'browser_act',
      params: { tabId: 3, snapshotId: 's_private', action: 'focus', ref: 'e1' },
      sessionId: 'session-b',
    });
    await flush(80);

    expect(sent.find((frame) => frame.id === 'd1')).toMatchObject({
      success: false,
      error: 'SNAPSHOT_NOT_FOUND',
      result: { reason: 'WRONG_SESSION' },
    });
    expect(actionExecutions).toBe(0);
  });

  it('drops a disconnected session snapshot without disturbing another session', async () => {
    register('s_session_a', 3, 'session-a');
    register('s_session_b', 3, 'session-b');

    await handleMessage({ type: 'releaseSession', sessionId: 'session-a' });

    expect(observationSnapshots.validate('s_session_a', 3, 'session-a')).toMatchObject({ error: 'SNAPSHOT_NOT_FOUND' });
    expect(observationSnapshots.validate('s_session_b', 3, 'session-b')).toMatchObject({ ok: true });
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
