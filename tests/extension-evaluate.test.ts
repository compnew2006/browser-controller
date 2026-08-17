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
      const src = opts.func.toString();
      if (src.includes('window.__bcEvalOut = undefined')) {
        // KICK: simulate the page's async IIFE settling ~30ms later.
        parked.value = null;
        setTimeout(() => { parked.value = { ok: true, json: '5' }; }, 30);
        return [{ result: true }];
      }
      if (src.includes('__bcEvalOut === undefined')) {
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
  });

  it('surfaces a page-side throw as an error result', async () => {
    // Re-mock the kick to park an error, like the page catch would.
    const chromeMock = (globalThis as unknown as { chrome: { scripting: { executeScript: unknown } } }).chrome;
    const orig = chromeMock.scripting.executeScript;
    chromeMock.scripting.executeScript = async (opts: { func: () => unknown }) => {
      const src = opts.func.toString();
      if (src.includes('window.__bcEvalOut = undefined')) {
        parked.value = null;
        setTimeout(() => { parked.value = { ok: false, error: 'boom' }; }, 10);
        return [{ result: true }];
      }
      if (src.includes('__bcEvalOut === undefined')) return [{ result: parked.value }];
      return [{ result: null }];
    };
    const res = await handleEvaluate({ tabId: 3, expression: 'throw new Error("boom")' });
    expect(res.success).toBe(false);
    expect((res as { error?: string }).error).toBe('boom');
    chromeMock.scripting.executeScript = orig;
  });
});
