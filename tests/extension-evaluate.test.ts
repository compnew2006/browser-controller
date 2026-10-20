import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * browser_evaluate regression (production stress audit): async injected funcs
 * lose their return value across the world boundary (crbug 1304272) — every
 * expression used to come back as {"success":true} with NO result. The fix
 * parks the value on a page global from a SYNC kick func and reads it back
 * with a SYNC poll func. This mock simulates the page side: kick schedules the
 * parked result, reads return it once available.
 */

const parked = vi.hoisted(() => ({ value: null as unknown }));

const tabStore = new Map<number, { id: number; url: string }>();
(globalThis as unknown as { chrome: unknown }).chrome = {
  tabs: {
    get: async (id: number) => {
      const t = tabStore.get(id);
      if (!t) throw new Error(`No tab ${id}`);
      return t;
    },
    query: async () => [],
  },
  scripting: {
    executeScript: async (opts: { func: () => unknown; args?: unknown[] }) => {
      const op = (opts.args ?? [])[0];
      if (op === 'start') {
        // KICK: simulate the page's async IIFE settling ~30ms later.
        parked.value = null;
        setTimeout(() => { parked.value = { ok: true, json: '5' }; }, 30);
        return [{ result: true }];
      }
      if (op === 'take') {
        // READ: sync return of the parked global.
        return [{ result: parked.value }];
      }
      return [{ result: null }];
    },
  },
  storage: { session: { get: async () => ({}), set: async () => {} }, local: { get: async () => ({}), set: async () => {} } },
  action: { setBadgeBackgroundColor: () => {}, setBadgeText: () => {} },
  runtime: { sendMessage: async () => {}, onMessage: { addListener: () => {} } },
  alarms: { create: () => {}, onAlarm: { addListener: () => {} } },
  webRequest: { onCompleted: { addListener: () => {} } },
};

const { handleEvaluate } = await import('../extension/handlers/inspection.js');

describe('browser_evaluate value round-trip (crbug 1304272 regression)', () => {
  beforeEach(() => {
    tabStore.clear();
    parked.value = null;
    tabStore.set(3, { id: 3, url: 'https://example.com/page' });
  });

  it('returns the evaluated value (2+3 → 5), not an empty success', async () => {
    const res = await handleEvaluate({ tabId: 3, expression: '2 + 3' });
    expect(res.success).toBe(true);
    expect((res as { result?: unknown }).result).toBe(5);
    expect((res as { text?: string }).text).toBe('via: scripting\n5');
  });

  it('surfaces a page-side throw as an error result', async () => {
    // Re-mock the kick to park an error, like the page catch would.
    const chromeMock = (globalThis as unknown as { chrome: { scripting: { executeScript: unknown } } }).chrome;
    const orig = chromeMock.scripting.executeScript;
    chromeMock.scripting.executeScript = async (opts: { func: () => unknown }) => {
      const op = (opts.args ?? [])[0];
      if (op === 'start') {
        parked.value = null;
        setTimeout(() => { parked.value = { ok: false, error: 'boom' }; }, 10);
        return [{ result: true }];
      }
      if (op === 'take') return [{ result: parked.value }];
      return [{ result: null }];
    };
    const res = await handleEvaluate({ tabId: 3, expression: 'throw new Error("boom")' });
    expect(res.success).toBe(false);
    expect((res as { error?: string }).error).toBe('SCRIPT_ERROR: boom');
    chromeMock.scripting.executeScript = orig;
  });
});

describe('browser_evaluate scripting fallback leaves nothing on the page', () => {
  it('deletes the parked value from the page global once it is read', async () => {
    const page: Record<string, unknown> = {};
    (globalThis as unknown as { window: unknown }).window = page;
    const chromeMock = (globalThis as unknown as { chrome: { scripting: { executeScript: unknown } } }).chrome;
    const orig = chromeMock.scripting.executeScript;
    // Run the injected functions for real, against a stand-in page global.
    chromeMock.scripting.executeScript = async (opts: { func: (...a: unknown[]) => unknown; args?: unknown[] }) => [{ result: await opts.func(...(opts.args ?? [])) }];
    try {
      tabStore.set(3, { id: 3, url: 'https://example.com/page' });
      const res = await handleEvaluate({ tabId: 3, expression: '2 + 3' });
      expect(res).toMatchObject({ success: true, result: 5 });
      expect(page).not.toHaveProperty('__bcEvalRuns');
    } finally {
      chromeMock.scripting.executeScript = orig;
      delete (globalThis as unknown as { window?: unknown }).window;
    }
  });
});

describe('browser_evaluate scripting fallback: a run that timed out cannot answer the next call', () => {
  it('the next call returns its own value, not the late value of the run that gave up', async () => {
    const page: Record<string, unknown> = {};
    (globalThis as unknown as { window: unknown }).window = page;
    const chromeMock = (globalThis as unknown as { chrome: { scripting: { executeScript: unknown } } }).chrome;
    const orig = chromeMock.scripting.executeScript;
    chromeMock.scripting.executeScript = async (opts: { func: (...a: unknown[]) => unknown; args?: unknown[] }) => [{ result: await opts.func(...(opts.args ?? [])) }];
    try {
      tabStore.set(3, { id: 3, url: 'https://example.com/page' });
      // Settles 500 ms after the call gave up (budget 1 s): its value must be dropped, not parked for the next call.
      const stale = await handleEvaluate({ tabId: 3, expression: 'new Promise((r) => setTimeout(() => r("STALE"), 1500))', timeout: 1000 });
      expect(stale).toMatchObject({ success: false });
      expect(String((stale as { error?: string }).error)).toMatch(/^TIMEOUT/);
      // Settles 2 s after the call starts, after the stale run wrote its value (1.5 s).
      const fresh = await handleEvaluate({ tabId: 3, expression: 'new Promise((r) => setTimeout(() => r("FRESH"), 2000))', timeout: 5000 });
      expect(fresh).toMatchObject({ success: true, result: 'FRESH' });
      expect(page).not.toHaveProperty('__bcEvalRuns');
    } finally {
      chromeMock.scripting.executeScript = orig;
      delete (globalThis as unknown as { window?: unknown }).window;
    }
  }, 15_000);
});
