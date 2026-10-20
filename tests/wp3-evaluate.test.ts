import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * browser_evaluate (WP3, contract 3.0): the scripting fallback is bounded by the caller's
 * timeout (a busy page never answers executeScript), every result says which path ran
 * (`via`), a returned promise comes back resolved (awaitPromise on the evaluate), and the
 * default timeout is 5 s with a 30 s maximum.
 */

type Reply = () => unknown;
const script = {
  kick: (() => [{ result: true }]) as Reply,
  read: (() => [{ result: null }]) as Reply,
  cdpAttachFails: true,
  cdpEvaluate: (() => ({ result: { type: 'number', value: 5 } })) as Reply,
};
const sendLog: string[] = [];
const evaluateParams: Array<Record<string, unknown>> = [];

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
    executeScript: async (opts: { func: () => unknown; args?: unknown[] }) => {
      // evalStep's first argument is its op: start (kick), take (read), drop (give up).
      const op = (opts.args ?? [])[0];
      if (op === 'start') return script.kick();
      if (op === 'take') return script.read();
      return [{ result: null }];
    },
  },
  debugger: {
    attach: async () => {
      if (script.cdpAttachFails) throw new Error('Cannot attach to this target');
    },
    detach: async () => {},
    sendCommand: async (_t: unknown, method: string, params: Record<string, unknown> = {}) => {
      sendLog.push(method);
      if (method === 'Runtime.evaluate') {
        if (params.expression === 'innerWidth * innerHeight') return { result: { type: 'number', value: 1 } };
        evaluateParams.push(params);
        return script.cdpEvaluate();
      }
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
const { BROWSER_EVALUATE_DEFAULT_MS, BROWSER_EVALUATE_MAX_MS } = await import('../extension/lib/cdp-evaluate.js');
const { detachCdp, hasCdp } = await import('../extension/lib/cdp-session.js');

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

  it('reports via: scripting on a line of its own, and the value', async () => {
    let parked: unknown = null;
    script.kick = () => { parked = { ok: true, json: '5' }; return [{ result: true }]; };
    script.read = () => [{ result: parked }];
    expect(await handleEvaluate({ tabId: 3, expression: '2 + 3' })).toMatchObject({
      success: true,
      result: 5,
      via: 'scripting',
      text: 'via: scripting\n5',
    });
  });
});

describe('browser_evaluate CDP path', () => {
  beforeEach(async () => {
    tabStore.clear();
    tabStore.set(3, { id: 3, url: 'https://example.com/page', windowId: 1 });
    script.cdpAttachFails = false;
    script.cdpEvaluate = () => ({ result: { type: 'number', value: 5 } });
    sendLog.length = 0;
    evaluateParams.length = 0;
    await detachCdp(3);
  });
  afterEach(async () => {
    script.cdpAttachFails = true;
    await detachCdp(3);
  });

  it('reports via: cdp and the value as text, with no via line', async () => {
    expect(await handleEvaluate({ tabId: 3, expression: '2 + 3' })).toEqual({ success: true, text: '5', result: 5, via: 'cdp' });
  });

  it('a returned promise comes back resolved: the evaluate awaits it, no separate awaitPromise call', async () => {
    script.cdpEvaluate = () => ({ result: { type: 'number', value: 7 } });
    expect(await handleEvaluate({ tabId: 3, expression: 'fetch("/n").then(r => r.json())' })).toMatchObject({ success: true, result: 7, via: 'cdp' });
    expect(evaluateParams.at(-1)).toMatchObject({ awaitPromise: true, returnByValue: false });
    expect(sendLog).not.toContain('Runtime.awaitPromise');
  });
});

describe('the browser_evaluate timeouts', () => {
  it('the default is 5 s and the maximum 30 s', () => {
    expect(BROWSER_EVALUATE_DEFAULT_MS).toBe(5_000);
    expect(BROWSER_EVALUATE_MAX_MS).toBe(30_000);
  });
});

describe('browser_evaluate CDP path: a debugger that detaches mid-call', () => {
  beforeEach(async () => {
    tabStore.clear();
    tabStore.set(3, { id: 3, url: 'https://example.com/page', windowId: 1 });
    script.cdpAttachFails = false;
    await detachCdp(3);
  });
  afterEach(async () => {
    script.cdpAttachFails = true;
    script.cdpEvaluate = () => ({ result: { type: 'number', value: 5 } });
    await detachCdp(3);
  });

  it('is DEBUGGER_UNAVAILABLE, not the raw CDP error', async () => {
    script.cdpEvaluate = () => { throw new Error('{"code":-32000,"message":"Detached while handling command."}'); };
    const res = await handleEvaluate({ tabId: 3, expression: '2 + 3' });
    expect(res.success).toBe(false);
    expect(String((res as { error?: string }).error)).toMatch(/^DEBUGGER_UNAVAILABLE: Detached while handling command\./);
  });
});

describe('browser_evaluate on a browser-internal page', () => {
  beforeEach(async () => {
    tabStore.clear();
    tabStore.set(3, { id: 3, url: 'chrome://settings/', windowId: 1 });
    await detachCdp(3);
  });

  it('is INVALID_ARGUMENT: the tab cannot be evaluated on, and nothing is attached', async () => {
    await expect(handleEvaluate({ tabId: 3, expression: '1 + 1' }))
      .rejects.toThrow(/^INVALID_ARGUMENT: Cannot evaluate on protected page \(chrome:\/\/settings\/\)\./);
    expect(hasCdp(3)).toBe(false);
  });
});
