import { vi, describe, it, expect, beforeAll, beforeEach } from 'vitest';

/**
 * Agent-control shield (user request): while an agent is ACTIVELY controlling
 * a tab, the page shows the blue inner frame + input blocking (the lock
 * shield) with the running tool's name INSIDE the frame — replacing the old
 * small corner badge. The frame goes away when the action finishes, locked or
 * not: a tab lock holds ownership and draws no frame of its own.
 */

const sent = vi.hoisted(() => [] as Array<Record<string, unknown>>);
const injections = vi.hoisted(() => [] as Array<{ target: { tabId: number; allFrames?: boolean; frameIds?: number[] }; func: string; args: unknown[] }>);
const faults = vi.hoisted(() => ({ activeBadgeThrows: false, shieldInjectionThrows: false, storageReadThrows: false }));
const cursorSetting = vi.hoisted(() => ({ enabled: false }));
const mouseMovementLockSetting = vi.hoisted(() => ({ enabled: false }));
const profileLabel = vi.hoisted(() => ({ apply: vi.fn(async (label: unknown) => ({ success: true, browserLabel: String(label) })) }));
const listeners = vi.hoisted(() => ({
  message: [] as Array<(...args: unknown[]) => unknown>,
  updated: [] as Array<(...args: unknown[]) => unknown>,
  committed: [] as Array<(...args: unknown[]) => unknown>,
  replaced: [] as Array<(...args: unknown[]) => unknown>,
}));

vi.mock('../extension/lib/connection.js', () => ({
  sendJson: (obj: Record<string, unknown>) => { sent.push(obj); },
  updateBadge: (status: string) => {
    if (status === 'active' && faults.activeBadgeThrows) throw new Error('badge API gone');
  },
  broadcastStatus: async () => {},
  isWsConnected: () => true,
  setCurrentActivity: () => {},
  getOpenTabs: async () => [],
  buildStatusPayload: () => ({}),
  applyPort: () => ({}),
  applyToken: () => ({}),
  applyBrowserLabel: (label: unknown) => profileLabel.apply(label),
  applyEnrollment: async () => {},
}));

const tabStore = new Map<number, { id: number; windowId: number; url: string; title: string; active: boolean }>();
(globalThis as unknown as { chrome: unknown }).chrome = {
  tabs: {
    get: async (id: number) => {
      const t = tabStore.get(id);
      if (!t) throw new Error(`No tab ${id}`);
      return t;
    },
    query: async () => [...tabStore.values()],
    update: async () => ({}),
    remove: async () => ({}),
    create: async () => ({}),
    captureVisibleTab: async () => 'data:image/png;base64,QUJD',
    onRemoved: { addListener: () => {} },
    onReplaced: { addListener: (fn: (...args: unknown[]) => unknown) => { listeners.replaced.push(fn); } },
    onUpdated: { addListener: (fn: (...args: unknown[]) => unknown) => { listeners.updated.push(fn); } },
    onActivated: { addListener: () => {} },
  },
  webNavigation: {
    onCreatedNavigationTarget: { addListener: () => {} },
    onCommitted: { addListener: (fn: (...args: unknown[]) => unknown) => { listeners.committed.push(fn); } },
  },
  scripting: {
    executeScript: async (opts: { target: { tabId: number; allFrames?: boolean; frameIds?: number[] }; func: () => void; args?: unknown[] }) => {
      injections.push({ target: opts.target, func: opts.func.toString(), args: opts.args ?? [] });
      if (faults.shieldInjectionThrows && opts.func.toString().includes('__bc-lock-shield')) throw new Error('cannot inject shield');
      const frameIds = opts.target.frameIds ?? (opts.target.allFrames ? [0, 2] : [0]);
      return frameIds.map((frameId) => ({ result: null, frameId }));
    },
  },
  action: { setBadgeBackgroundColor: () => {}, setBadgeText: () => {} },
  storage: {
    session: { get: async () => ({}), set: async () => {} },
    local: {
      get: async () => {
        if (faults.storageReadThrows) throw new Error('storage unavailable');
        return { agentCursor: cursorSetting.enabled, agentMouseMovementLock: mouseMovementLockSetting.enabled };
      },
      set: async () => {},
    },
  },
  runtime: {
    id: 'extension-id',
    getURL: (path: string) => `chrome-extension://extension-id/${path}`,
    sendMessage: async () => {},
    onMessage: { addListener: (fn: (...args: unknown[]) => unknown) => { listeners.message.push(fn); } },
  },
  alarms: { create: () => {}, onAlarm: { addListener: () => {} } },
  webRequest: {
    onBeforeRequest: { addListener: () => {} },
    onSendHeaders: { addListener: () => {} },
    onCompleted: { addListener: () => {} },
    onErrorOccurred: { addListener: () => {} },
  },
  debugger: { attach: async () => {}, detach: async () => {}, sendCommand: async () => ({}) },
};

// The screenshot path decodes and encodes with canvas APIs (service worker only; absent in Node).
(globalThis as unknown as { createImageBitmap: unknown }).createImageBitmap = async () => ({ width: 800, height: 600, close() {} });
(globalThis as unknown as { OffscreenCanvas: unknown }).OffscreenCanvas = class {
  constructor(public width: number, public height: number) {}
  getContext() { return { imageSmoothingQuality: 'low', drawImage() {} }; }
  async convertToBlob(opts: { type: string }) { return new Blob([new Uint8Array(8)], { type: opts.type }); }
};

const { handleMessage } = await import('../extension/dispatch/router.js');
const { handleScreenshot } = await import('../extension/handlers/screenshot.js');
const { tabLocks, tabControl, wedgedTabs } = await import('../extension/lib/state.js');
const { lockTabUi } = await import('../extension/lib/lock-ops.js');
const { registerEventListeners } = await import('../extension/events.js');
const { dispatchAgentInput, hideLockShield, refreshLockShield, showLockShield } = await import('../extension/lib/overlay.js');

const shieldInjections = () => injections.filter((i) => i.func.includes('__bc-lock-shield'));
const overlayInjections = () => injections.filter((i) => i.func.includes('__bc-overlay'));
const flush = (ms = 60) => new Promise((r) => setTimeout(r, ms));

describe('agent-control shield (blue frame instead of corner badge)', () => {
  beforeEach(() => {
    cursorSetting.enabled = false;
    mouseMovementLockSetting.enabled = false;
    faults.activeBadgeThrows = false;
    faults.shieldInjectionThrows = false;
    faults.storageReadThrows = false;
    sent.length = 0;
    injections.length = 0;
    tabStore.clear();
    tabLocks.unlockAll();
    wedgedTabs.delete(3);
    tabStore.set(3, { id: 3, windowId: 1, url: 'https://example.com/page', title: 'Page', active: true });
  });

  it('shows the lock-shield frame WITH the agent-name label during an agent action (no corner badge)', async () => {
    await handleMessage({ id: 'a1', tool: 'browser_wait', params: { tabId: 3, ms: 1 }, sessionId: 's1', agentName: 'Vitest' });
    await flush();

    const shields = shieldInjections();
    expect(shields.length, 'a shield injection must happen for the action').toBeGreaterThanOrEqual(1);
    // The label names the AGENT controlling the tab (user request), not the tool.
    expect(shields[0]!.args).toContain('agent Vitest controlling the tab');
    expect(shields[0]!.target).toEqual({ tabId: 3 });
    expect(overlayInjections(), 'the old corner badge must not be used anymore').toEqual([]);
    expect(sent.find((f) => f.id === 'a1')?.success).toBe(true);
  });

  it('falls back to a generic label when the message carries no agentName', async () => {
    await handleMessage({ id: 'a4', tool: 'browser_wait', params: { tabId: 3, ms: 1 }, sessionId: 's1' });
    await flush();
    expect(shieldInjections()[0]!.args).toContain('agent controlling the tab');
  });

  it('opts into movement and hover blocking across frames only during an agent command', async () => {
    mouseMovementLockSetting.enabled = true;
    await handleMessage({ id: 'mouse-lock', tool: 'browser_wait', params: { tabId: 3, ms: 1 }, sessionId: 's1' });
    await flush();

    const shields = shieldInjections();
    expect(shields[0]!.args).toEqual(['agent controlling the tab', false, true]);
    expect(shields[0]!.target).toEqual({ tabId: 3, allFrames: true });
    expect(shields[0]!.func).toContain("'pointermove'");
    expect(shields[0]!.func).toContain("el.style.pointerEvents = blockMouse ? 'auto' : 'none'");
    expect(shields.at(-1)!.func).toContain('root.__bcShieldDocListeners');
    expect(sent.find((f) => f.id === 'mouse-lock')?.success).toBe(true);
  });

  it('opens a short all-frame permit for each agent CDP input and closes it on failure', async () => {
    mouseMovementLockSetting.enabled = true;
    await showLockShield(3, 'agent controlling the tab');
    const before = injections.length;

    await expect(dispatchAgentInput(3, async () => { throw new Error('CDP failed'); }, 'Input.dispatchMouseEvent', { type: 'mouseMoved' }))
      .rejects.toThrow('CDP failed');

    const permits = injections.slice(before);
    expect(permits).toHaveLength(2);
    expect(permits.map((item) => item.target)).toEqual([
      { tabId: 3, allFrames: true }, { tabId: 3, frameIds: [0, 2] },
    ]);
    expect(permits[0]!.func).toContain('window.__bcAgentInputUntil = until');
    expect(permits[0]!.args[0]).toMatchObject({ durationMs: 500, eventTypes: ['pointermove', 'mousemove', 'pointerover', 'pointerout', 'pointerenter', 'pointerleave', 'mouseover', 'mouseout', 'mouseenter', 'mouseleave'] });
    expect(permits[0]!.func).toContain("shield.style.pointerEvents = 'none'");
    expect(permits[1]!.func).toContain("shield.style.pointerEvents = 'auto'");
    expect(permits[0]!.func).toContain('window.__bcAgentInputPermit = activePermit');
    expect(permits[1]!.func).toContain('window.__bcAgentInputPermit?.id !== id');
    await hideLockShield(3);
  });

  it('lets the agent dispatch drag events through the movement shield', async () => {
    mouseMovementLockSetting.enabled = true;
    await showLockShield(3, 'agent controlling the tab');
    const before = injections.length;
    const send = vi.fn(async () => undefined);

    await dispatchAgentInput(3, send, 'Input.dispatchDragEvent', { type: 'drop', x: 40, y: 60 });

    const permits = injections.slice(before);
    expect(send).toHaveBeenCalledWith('Input.dispatchDragEvent', { type: 'drop', x: 40, y: 60 });
    expect(permits).toHaveLength(2);
    expect(permits.map((item) => item.target)).toEqual([
      { tabId: 3, allFrames: true }, { tabId: 3, frameIds: [0, 2] },
    ]);
    expect((permits[0]!.args[0] as { allowMouseTarget: boolean }).allowMouseTarget).toBe(true);
    expect(permits[0]!.func).toContain("shield.style.pointerEvents = 'none'");
    expect(permits[0]!.func).toContain('setTimeout');
    await hideLockShield(3);
  });

  it('keeps the visual frame between calls when the agent cursor is enabled', async () => {
    cursorSetting.enabled = true;
    await handleMessage({ id: 'linger', tool: 'browser_wait', params: { tabId: 3, ms: 1 }, sessionId: 's1' });
    await flush();
    expect(shieldInjections().at(-1)!.args).toEqual([30_000]);
  });

  it('keeps the visual frame for an owned tab until the session releases it', async () => {
    cursorSetting.enabled = true;
    tabLocks.lock(3, 's1');
    await handleMessage({ id: 'owned', tool: 'browser_wait', params: { tabId: 3, ms: 1 }, sessionId: 's1' });
    await flush();
    expect(shieldInjections().at(-1)!.args).toEqual([-1]);
  });

  it('removes the frame when the action ends on an UNLOCKED tab', async () => {
    await handleMessage({ id: 'a2', tool: 'browser_wait', params: { tabId: 3, ms: 1 }, sessionId: 's1' });
    await flush();

    // Last shield-related injection must be the REMOVAL (hideLockShield's
    // func removes the element), not a re-show.
    const last = shieldInjections().at(-1)!;
    expect(last.func).toMatch(/remove|__bcShieldDocListeners/);
  });

  it('removes the frame when the action ends on a LOCKED tab too (no plain frame between calls)', async () => {
    tabLocks.lock(3, 's1');
    await handleMessage({ id: 'a3', tool: 'browser_wait', params: { tabId: 3, ms: 1 }, sessionId: 's1', agentName: 'Vitest' });
    await flush();

    const shields = shieldInjections();
    expect(shields[0]!.args).toContain('agent Vitest controlling the tab'); // shown for the call
    expect(shields, 'one show, then one removal: nothing re-shown').toHaveLength(2);
    expect(shields.at(-1)!.args).toEqual([]); // the removal takes no label argument
  });

  it('screenshot on a LOCKED tab does not crash (regression: showLockShield import)', async () => {
    tabLocks.lock(3, 's1');
    // Previously rejected with ReferenceError: showLockShield is not defined
    // (the dedup edit dropped its import from handlers/tabs.js).
    await expect(handleScreenshot({ tabId: 3 }, 's1')).resolves.toMatchObject({ success: true });
    // The frame is hidden during capture and restored afterward; the router
    // decides whether to retain its visual cue after the call ends.
    expect(shieldInjections().map((i) => i.args)).toEqual([[true], [false]]);
  });
});

describe('pinning a tab draws no frame (the frame is shown only during a tool call)', () => {
  beforeAll(() => {
    registerEventListeners(); // captures the events.js message and onUpdated listeners
  });
  beforeEach(() => {
    sent.length = 0;
    injections.length = 0;
    mouseMovementLockSetting.enabled = false;
    faults.activeBadgeThrows = false;
    faults.shieldInjectionThrows = false;
    faults.storageReadThrows = false;
    tabStore.clear();
    tabLocks.unlockAll();
    tabStore.set(3, { id: 3, windowId: 1, url: 'https://example.com/page', title: 'Page', active: true });
  });

  it('reinstalls the shield when a frame commits during an active command', async () => {
    mouseMovementLockSetting.enabled = true;
    await handleMessage({ id: 'frame-nav', tool: 'browser_wait', params: { tabId: 3, ms: 80 }, sessionId: 's1' });
    await flush(10);
    listeners.committed.at(-1)!({ tabId: 3, frameId: 2, documentId: 'frame-doc', url: 'https://example.com/frame' });
    await flush(10);

    const shows = injections.filter((item) => item.args[0] === 'agent controlling the tab');
    expect(shows).toHaveLength(2);
    expect(shows[0]!.target.allFrames).toBe(true);
    expect(shows[1]!.target.frameIds).toEqual([2]);
    await flush(100);
    expect(sent.find((f) => f.id === 'frame-nav')?.success).toBe(true);
  });

  it('moves active shield ownership with a replaced tab and resolves cleanup to the new id', async () => {
    mouseMovementLockSetting.enabled = true;
    await showLockShield(3, 'agent controlling the tab');
    tabStore.set(4, { id: 4, windowId: 1, url: 'https://example.com/replaced', title: 'Replaced', active: true });
    const before = injections.length;
    listeners.replaced.at(-1)!(4, 3);
    await flush();
    expect(injections.slice(before).some((item) => item.target.tabId === 4 && item.func.includes('__bc-lock-shield'))).toBe(true);
    await dispatchAgentInput(3, async () => undefined, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: 20, y: 30 });

    expect(injections.slice(before).every((item) => item.target.tabId === 4)).toBe(true);
    await hideLockShield(3);
    expect(injections.at(-1)!.target.tabId).toBe(4);
  });

  it('refuses input when a replacement tab cannot receive the movement shield', async () => {
    mouseMovementLockSetting.enabled = true;
    await showLockShield(3, 'agent controlling the tab');
    tabStore.set(4, { id: 4, windowId: 1, url: 'https://example.com/replaced', title: 'Replaced', active: true });
    faults.shieldInjectionThrows = true;
    listeners.replaced.at(-1)!(4, 3);
    await flush();

    const send = vi.fn(async () => undefined);
    await expect(dispatchAgentInput(3, send, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: 20, y: 30 }))
      .rejects.toThrow('AGENT_INPUT_SHIELD_UNAVAILABLE');
    expect(send).not.toHaveBeenCalled();
  });

  it('does not execute a command when the enabled movement shield cannot be installed', async () => {
    mouseMovementLockSetting.enabled = true;
    faults.shieldInjectionThrows = true;

    await handleMessage({ id: 'no-shield', tool: 'browser_wait', params: { tabId: 3, ms: 1 }, sessionId: 's1' });
    await flush();

    expect(sent.find((f) => f.id === 'no-shield')).toMatchObject({ success: false });
    expect(sent.find((f) => f.id === 'no-shield')?.error).toContain('MOUSE_MOVEMENT_LOCK_UNAVAILABLE');
  });

  it('does not execute a command when the movement-lock setting cannot be read', async () => {
    faults.storageReadThrows = true;

    await handleMessage({ id: 'no-setting', tool: 'browser_wait', params: { tabId: 3, ms: 1 }, sessionId: 's1' });
    await flush();

    expect(sent.find((f) => f.id === 'no-setting')?.error).toContain('MOUSE_MOVEMENT_LOCK_UNAVAILABLE');
    expect(sent.find((f) => f.id === 'no-setting')?.success).toBe(false);
  });

  it('does not reinstall a shield after a wedged command ends', async () => {
    mouseMovementLockSetting.enabled = true;
    await showLockShield(3, 'agent controlling the tab');
    wedgedTabs.set(3, Date.now());

    await handleMessage({ id: 'wedged', tool: 'browser_wait', params: { tabId: 3, ms: 1 }, sessionId: 's1' });
    await flush();

    expect(await refreshLockShield(3)).toBe(false);
    wedgedTabs.delete(3);
  });

  it('lockTabUi takes the lock and injects no frame', () => {
    lockTabUi(3, 's1', 'Tab 3 pinned to s1');
    expect(tabLocks.owner(3)).toBe('s1');
    expect(shieldInjections()).toEqual([]);
  });

  it('the lockTab message replies success with no shield flag, and injects no frame', async () => {
    const replies: Array<Record<string, unknown>> = [];
    listeners.message.at(-1)!({ type: 'lockTab', tabId: 3, sessionId: 's1' }, {}, (r: Record<string, unknown>) => replies.push(r));
    await flush();
    expect(replies).toEqual([{ success: true }]);
    expect(tabLocks.owner(3)).toBe('s1');
    expect(shieldInjections()).toEqual([]);
  });

  it('allows only the extension popup to rename the profile', async () => {
    profileLabel.apply.mockClear();
    const listener = listeners.message.at(-1)!;
    const popupReply: Array<Record<string, unknown>> = [];
    const popupHandled = listener(
      { type: 'setBrowserLabel', label: 'Treelancer' },
      { id: 'extension-id', url: 'chrome-extension://extension-id/popup/popup.html' },
      (result: Record<string, unknown>) => popupReply.push(result),
    );
    await flush();
    expect(popupHandled).toBe(true);
    expect(profileLabel.apply).toHaveBeenCalledWith('Treelancer');
    expect(popupReply).toEqual([{ success: true, browserLabel: 'Treelancer' }]);

    const pageHandled = listener(
      { type: 'setBrowserLabel', label: 'Attacker' },
      { id: 'extension-id', url: 'https://example.com/' },
      () => {},
    );
    expect(pageHandled).toBe(false);
    expect(profileLabel.apply).toHaveBeenCalledTimes(1);
  });

  it('a refused pin (tab held by another session) replies with the refusal and injects no frame', async () => {
    tabLocks.lock(3, 'other');
    const replies: Array<Record<string, unknown>> = [];
    listeners.message.at(-1)!({ type: 'lockTab', tabId: 3, sessionId: 's1' }, {}, (r: Record<string, unknown>) => replies.push(r));
    await flush();
    expect(replies[0]).toMatchObject({ success: false });
    expect(tabLocks.owner(3)).toBe('other');
    expect(shieldInjections()).toEqual([]);
  });

  it('a navigation that completes on a locked tab does not re-inject the frame', async () => {
    tabLocks.lock(3, 's1');
    listeners.updated.at(-1)!(3, { status: 'complete' }, {});
    await flush();
    expect(shieldInjections()).toEqual([]);
  });
});

describe('tab control tracking (popup Open Tabs must not say "free")', () => {
  beforeEach(() => {
    sent.length = 0;
    tabStore.clear();
    tabLocks.unlockAll();
    tabControl.release(3);
    tabStore.set(3, { id: 3, windowId: 1, url: 'https://example.com/page', title: 'Page', active: true });
  });

  it('records the agent driving an UNLOCKED tab (queued path)', async () => {
    await handleMessage({ id: 'c1', tool: 'browser_wait', params: { tabId: 3, ms: 1 }, sessionId: 's1', agentName: 'Vitest' });
    await flush();
    expect(tabLocks.owner(3)).toBeUndefined(); // still no lock…
    // …but the tab is reported as controlled (lingering after the call).
    expect(tabControl.controller(3)).toEqual({ sessionId: 's1', agentName: 'Vitest', active: false });
  });

  it('records calls that bypass the tab mutex too (tabs focus)', async () => {
    await handleMessage({ id: 'c2', tool: 'browser_tabs', params: { action: 'focus', tabId: 3 }, sessionId: 's1', agentName: 'Vitest' });
    expect(tabControl.controller(3)).toMatchObject({ sessionId: 's1', active: false });
  });

  it('does not record tab-agnostic calls (tabs list)', async () => {
    await handleMessage({ id: 'c3', tool: 'browser_tabs', params: { action: 'list' }, sessionId: 's1' });
    expect(tabControl.controller(3)).toBeUndefined();
  });

  it('clears control when the agent session is released (disconnect)', async () => {
    await handleMessage({ id: 'c4', tool: 'browser_wait', params: { tabId: 3, ms: 1 }, sessionId: 's1', agentName: 'Vitest' });
    await flush();
    await handleMessage({ type: 'releaseSession', sessionId: 's1' });
    expect(tabControl.controller(3)).toBeUndefined();
  });

  it('does not record a caller the lock refuses on the mutex-bypass path', async () => {
    tabLocks.lock(3, 'owner-a');
    await handleMessage({ id: 'c5', tool: 'browser_tabs', params: { action: 'focus', tabId: 3 }, sessionId: 's-b', agentName: 'Other' });
    expect(sent.find((f) => f.id === 'c5')?.success).toBe(false); // refused: locked by owner-a
    tabLocks.unlockAll();
    // After the owner lets go, the tab must not claim s-b "controlled" it.
    expect(tabControl.controller(3)).toBeUndefined();
  });

  // Replaces the lock/unlock actions (removed in 3.0): the owner closing its own tab hands it back.
  it('closing its own tab hands it back: free at once, no 30s linger', async () => {
    tabLocks.lock(3, 's1');
    await handleMessage({ id: 'c6', tool: 'browser_wait', params: { tabId: 3, ms: 1 }, sessionId: 's1', agentName: 'Vitest' });
    await flush();
    expect(tabControl.controller(3)).toMatchObject({ sessionId: 's1', active: false }); // still lingering
    await handleMessage({ id: 'c7', tool: 'browser_tabs', params: { action: 'close', tabId: 3 }, sessionId: 's1', agentName: 'Vitest' });
    await flush();
    expect(sent.find((f) => f.id === 'c7')?.success).toBe(true);
    expect(tabLocks.owner(3)).toBeUndefined();
    expect(tabControl.controller(3)).toBeUndefined();
  });

  it('ends control even when the task throws before the dispatch try (no stuck "running")', async () => {
    faults.activeBadgeThrows = true;
    try {
      await handleMessage({ id: 'c8', tool: 'browser_wait', params: { tabId: 3, ms: 1 }, sessionId: 's1', agentName: 'Vitest' });
      await flush();
    } finally {
      faults.activeBadgeThrows = false;
    }
    expect(sent.find((f) => f.id === 'c8')?.success).toBe(false);
    expect(tabControl.controller(3)?.active).toBe(false);
  });

  it('browser_tabs list counts a tab another agent drives, to OTHER agents only, without its title', async () => {
    await handleMessage({ id: 'c9', tool: 'browser_wait', params: { tabId: 3, ms: 1 }, sessionId: 's1', agentName: 'Vitest' });
    await flush();
    await handleMessage({ id: 'c10', tool: 'browser_tabs', params: { action: 'list' }, sessionId: 's2' });
    await handleMessage({ id: 'c11', tool: 'browser_tabs', params: { action: 'list' }, sessionId: 's1' });
    const textFor = (id: string) => (sent.find((f) => f.id === id)?.result as { text: string }).text;
    expect(textFor('c10')).toBe('+1 tab used by other agents');
    expect(textFor('c11')).toBe('3 [user, focused] "Page" example.com/page'); // your own activity is not news
  });
});
