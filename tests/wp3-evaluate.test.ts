import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * browser_evaluate (WP3): the scripting fallback is bounded by the caller's
 * timeout (a busy page never answers executeScript), every result says which path
 * ran (`via`), a returned promise is awaited on the CDP path, and the default
 * timeout is one number shared by the handler and the MCP schema.
 */

type Reply = () => unknown;
const script = {
  kick: (() => [{ result: true }]) as Reply,
  read: (() => [{ result: null }]) as Reply,
  cdpAttachFails: true,
  cdpEvaluate: (() => ({ result: { type: 'number', value: 5 } })) as Reply,
  cdpAwait: (() => ({ result: { type: 'number', value: 7 } })) as Reply,
};
const sendLog: string[] = [];

const tabStore = new Map<number, { id: number; url: string; windowId: number }>();
(globalThis as unknown as { chrome: unknown }).chrome = {
  tabs: {
    get: async (id: number) => {
      const t = tabStore.get(id);
      if (!t) throw new Error(`No tab ${id}`);
      return t;
    },
    query: async () => [],
  },
  windows: { get: async () => ({ width: 1280, height: 900 }) },
  scripting: {
    executeScript: async (opts: { func: () => unknown }) => {
      const src = opts.func.toString();
      if (src.includes('window.__bcEvalOut = undefined')) return script.kick();
      if (src.includes('__bcEvalOut === undefined')) return script.read();
      return [{ result: null }];
    },
  },
  debugger: {
    attach: async () => {
      if (script.cdpAttachFails) throw new Error('Cannot attach to this target');
    },
    detach: async () => {},
    sendCommand: async (_t: unknown, method: string, params: { expression?: string } = {}) => {
      sendLog.push(method);
      if (method === 'Runtime.evaluate') {
        return params.expression === 'innerWidth * innerHeight' ? { result: { type: 'number', value: 1 } } : script.cdpEvaluate();
      }
      if (method === 'Runtime.awaitPromise') return script.cdpAwait();
      return {};
    },
    onEvent: { addListener: () => {} },
    onDetach: { addListener: () => {} },
  },
  storage: { session: { get: async () => ({}), set: async () => {} }, local: { get: async () => ({}), set: async () => {} } },
  action: { setBadgeBackgroundColor: () => {}, setBadgeText: () => {} },
  runtime: { sendMessage: async () => {}, onMessage: { addListener: () => {} } },
  alarms: { create: () => {}, onAlarm: { addListener: () => {} } },
  webRequest: { onCompleted: { addListener: () => {} } },
};

const { handleEvaluate } = await import('../extension/handlers/inspection.js');
const { DEFAULT_EVAL_TIMEOUT_MS } = await import('../extension/lib/cdp-evaluate.js');
const { evaluateTool } = await import('../mcp-server/src/tools/evaluate.js');

const never = () => new Promise<never>(() => {});

describe('browser_evaluate scripting fallback is bounded', () => {
  beforeEach(() => {
    tabStore.clear();
    tabStore.set(3, { id: 3, url: 'https://example.com/page', windowId: 1 });
    script.cdpAttachFails = true;
    script.kick = () => [{ result: true }];
    script.read = () => [{ result: null }];
  });

  it('returns TIMEOUT when the page never settles, instead of blocking the tab', async () => {
    script.read = never;
    const started = Date.now();
    const res = await handleEvaluate({ tabId: 3, expression: 'busy()', timeout: 1000 });
    expect(Date.now() - started).toBeLessThan(4000);
    expect(res).toMatchObject({ success: false, via: 'scripting' });
    expect(String((res as { error?: string }).error)).toMatch(/^TIMEOUT: evaluate did not finish within 1000ms/);
  });

  it('returns TIMEOUT when even the start of the evaluation never answers', async () => {
    script.kick = never;
    const res = await handleEvaluate({ tabId: 3, expression: 'x', timeout: 1000 });
    expect(res).toMatchObject({ success: false, via: 'scripting' });
    expect(String((res as { error?: string }).error)).toMatch(/^TIMEOUT/);
  });

  it('reports via:"scripting" on a normal result', async () => {
    let parked: unknown = null;
    script.kick = () => { parked = { ok: true, json: '5' }; return [{ result: true }]; };
    script.read = () => [{ result: parked }];
    expect(await handleEvaluate({ tabId: 3, expression: '2 + 3' })).toEqual({ success: true, result: 5, via: 'scripting' });
  });
});

describe('browser_evaluate CDP path', () => {
  beforeEach(() => {
    tabStore.clear();
    tabStore.set(3, { id: 3, url: 'https://example.com/page', windowId: 1 });
    script.cdpAttachFails = false;
    script.cdpEvaluate = () => ({ result: { type: 'number', value: 5 } });
    sendLog.length = 0;
  });
  afterEach(() => { script.cdpAttachFails = true; });

  it('reports via:"cdp" and the value', async () => {
    expect(await handleEvaluate({ tabId: 3, expression: '2 + 3' })).toEqual({ success: true, result: 5, via: 'cdp' });
  });

  it('awaits a returned promise and returns its value, not {}', async () => {
    script.cdpEvaluate = () => ({ result: { type: 'object', subtype: 'promise', className: 'Promise', description: 'Promise', objectId: 'p1' } });
    script.cdpAwait = () => ({ result: { type: 'number', value: 7 } });
    expect(await handleEvaluate({ tabId: 3, expression: 'fetch("/n").then(r => r.json())' })).toEqual({ success: true, result: 7, via: 'cdp' });
    expect(sendLog).toContain('Runtime.awaitPromise');
  });
});

describe('the default timeout is single-sourced', () => {
  it('the MCP schema default equals the extension default', () => {
    const parsed = evaluateTool.inputSchema.parse({ tabId: 3, expression: '1' });
    expect(parsed.timeout).toBe(DEFAULT_EVAL_TIMEOUT_MS);
    expect(DEFAULT_EVAL_TIMEOUT_MS).toBe(30_000);
  });
});
