import { describe, it, expect } from 'vitest';

const { cdpEvaluateSource } = await import('../extension/lib/cdp-evaluate.js');

type Reply = Record<string, unknown>;
function fakeSend(evalReply: Reply | (() => Promise<Reply>), serialized?: string) {
  const calls: Array<{ method: string; params: Reply }> = [];
  const send = async (method: string, params: Reply = {}) => {
    calls.push({ method, params });
    if (method === 'Runtime.evaluate') return typeof evalReply === 'function' ? evalReply() : evalReply;
    if (method === 'Runtime.callFunctionOn') return { result: { value: serialized } };
    return {};
  };
  return { send, calls };
}

describe('cdpEvaluateSource (browser_evaluate over CDP)', () => {
  it('runs the source once, awaited, in an object group that is released afterwards', async () => {
    const { send, calls } = fakeSend({ result: { type: 'number', value: 5 } });
    expect(await cdpEvaluateSource(send, 'await 2; 5')).toEqual({ success: true, result: 5 });
    // The parse check is a Runtime.evaluate too (no awaitPromise): the run is the one that awaits.
    const run = calls.filter((c) => c.method === 'Runtime.evaluate').find((c) => c.params.awaitPromise === true);
    expect(run?.params).toMatchObject({ awaitPromise: true, userGesture: true });
    expect(String(run?.params.expression)).toContain('await 2; 5');
    expect(calls.at(-1)!.method).toBe('Runtime.releaseObjectGroup');
  });

  it('serializes objects page-side', async () => {
    const { send } = fakeSend({ result: { type: 'object', objectId: 'o1' } }, '{"a":[1,"<input#x>"]}');
    expect(await cdpEvaluateSource(send, '({a:[1,el]})')).toEqual({ success: true, result: { a: [1, '<input#x>'] } });
  });

  it('describes DOM nodes', async () => {
    const { send } = fakeSend({ result: { type: 'object', subtype: 'node', objectId: 'n', description: 'input#a' } });
    expect(await cdpEvaluateSource(send, 'document.activeElement')).toEqual({ success: true, result: 'input#a' });
  });

  it('reports undefined, NaN and exceptions', async () => {
    expect(await cdpEvaluateSource(fakeSend({ result: { type: 'undefined' } }).send, 'void 0'))
      .toMatchObject({ success: true, result: null, type: 'undefined' });
    expect(await cdpEvaluateSource(fakeSend({ result: { type: 'number', unserializableValue: 'NaN' } }).send, 'NaN'))
      .toEqual({ success: true, result: 'NaN' });
    const err = await cdpEvaluateSource(fakeSend({ result: {}, exceptionDetails: { exception: { description: 'ReferenceError: x is not defined' } } }).send, 'x');
    expect(err).toEqual({ success: false, error: 'SCRIPT_ERROR: ReferenceError: x is not defined' });
  });

  it('times out on a promise that never settles', async () => {
    const { send } = fakeSend(() => new Promise(() => {}));
    const res = await cdpEvaluateSource(send, 'await new Promise(()=>{})', { timeoutMs: 1000 });
    expect(res.success).toBe(false);
    expect(String(res.error)).toMatch(/did not finish within 1000ms/);
  });
});

/**
 * A fake page-side parser: `new Function` compiles the source and runs nothing. A run is an
 * expression ending in `()`; every other evaluate only builds the function (the parse check).
 */
function parsingSend() {
  const calls: Array<{ method: string; params: Reply }> = [];
  const send = async (method: string, params: Reply = {}) => {
    calls.push({ method, params });
    if (method === 'Runtime.compileScript') throw new Error('{"code":-32000,"message":"Runtime agent is not enabled"}');
    if (method !== 'Runtime.evaluate') return {};
    const expr = String(params.expression);
    try { new Function(`return ${expr}`); } catch (err) {
      return { result: {}, exceptionDetails: { exception: { description: `SyntaxError: ${(err as Error).message}` } } };
    }
    if (expr.endsWith('()')) return { result: { type: 'number', value: 5 } };
    return { result: { type: 'function', objectId: 'fn1' } };
  };
  return { send, calls };
}

describe('cdpEvaluateSource parses without Runtime.compileScript', () => {
  it('never calls Runtime.compileScript: it fails unless the Runtime domain is enabled, and a fresh attach has it off', async () => {
    const { send, calls } = parsingSend();
    expect(await cdpEvaluateSource(send, '2 + 3')).toEqual({ success: true, result: 5 });
    expect(calls.map((c) => c.method)).not.toContain('Runtime.compileScript');
  });

  it('a statement body (return) fails the expression parse, runs as a body, and the source is not run twice', async () => {
    const { send, calls } = parsingSend();
    expect(await cdpEvaluateSource(send, 'const x = 2;\nreturn x * 3')).toEqual({ success: true, result: 5 });
    const runs = calls.filter((c) => c.method === 'Runtime.evaluate' && String(c.params.expression).endsWith('()'));
    expect(runs).toHaveLength(1);
    expect(String(runs[0].params.expression)).toContain('return x * 3');
  });

  it('a CDP failure (the debugger detached mid-call) is DEBUGGER_UNAVAILABLE, never a raw JSON error', async () => {
    const send = async (method: string) => {
      if (method === 'Runtime.evaluate') throw new Error('{"code":-32000,"message":"Detached while handling command."}');
      return {};
    };
    const res = await cdpEvaluateSource(send, '1 + 1');
    expect(res.success).toBe(false);
    expect(String(res.error)).toMatch(/^DEBUGGER_UNAVAILABLE: Detached while handling command\./);
    expect(String(res.error)).not.toMatch(/^\{|"code"/);
  });
});

/**
 * A page that counts side effects the way V8 does: a break-out (the source closes the wrapper
 * early) runs its statements when they are evaluated, unless the evaluate asked for
 * throwOnSideEffect, which refuses them with an EvalError before they run.
 */
function v8Send() {
  const calls: Array<{ method: string; params: Reply }> = [];
  const state = { sideEffects: 0 };
  const send = async (method: string, params: Reply = {}) => {
    calls.push({ method, params });
    if (method !== 'Runtime.evaluate') return {};
    const expr = String(params.expression);
    if (expr.includes('window.__n=')) {
      if (params.throwOnSideEffect) return { result: {}, exceptionDetails: { exception: { description: 'EvalError: Possible side-effect in debug-evaluate' } } };
      state.sideEffects += 1;
    }
    try { new Function(`return ${expr}`); } catch (err) {
      return { result: {}, exceptionDetails: { exception: { description: `SyntaxError: ${(err as Error).message}` } } };
    }
    if (expr.endsWith('()')) return { result: { type: 'number', value: 5 } };
    return { result: { type: 'function', objectId: 'fn1' } };
  };
  return { send, calls, state };
}

describe('cdpEvaluateSource: the parse check cannot run the source', () => {
  it('the parse checks are made with throwOnSideEffect; the run is not', async () => {
    const { send, calls } = parsingSend();
    await cdpEvaluateSource(send, 'const a = 2;\nreturn a * 3');
    const parses = calls.filter((c) => c.method === 'Runtime.evaluate' && c.params.awaitPromise !== true);
    expect(parses.length).toBeGreaterThan(0);
    expect(parses.every((c) => c.params.throwOnSideEffect === true)).toBe(true);
    const run = calls.find((c) => c.method === 'Runtime.evaluate' && c.params.awaitPromise === true);
    expect(run?.params.throwOnSideEffect).toBeUndefined();
  });

  it('a break-out that would run code outside the wrapper is refused before it runs: SCRIPT_ERROR, no run', async () => {
    const { send, calls, state } = v8Send();
    const res = await cdpEvaluateSource(send, '1)); window.__n=(window.__n||0)+1; ((0');
    expect(res.success).toBe(false);
    expect(String(res.error)).toMatch(/^SCRIPT_ERROR: .*outside its function/);
    expect(state.sideEffects).toBe(0);
    expect(calls.filter((c) => c.params.awaitPromise === true)).toEqual([]);
  });
});

describe('cdpEvaluateSource: a cancelled call has a coded failure', () => {
  it('a signal that is already aborted is TIMEOUT: evaluate cancelled by the caller, and nothing runs', async () => {
    const { send, calls } = parsingSend();
    const ac = new AbortController();
    ac.abort();
    expect(await cdpEvaluateSource(send, '2 + 3', { signal: ac.signal })).toEqual({ success: false, error: 'TIMEOUT: evaluate cancelled by the caller' });
    expect(calls.filter((c) => c.params.awaitPromise === true)).toEqual([]);
  });

  it('a cancel while the run is pending is TIMEOUT: evaluate cancelled by the caller, not a hang', async () => {
    const ac = new AbortController();
    const send = async (method: string, params: Reply = {}) => {
      if (method === 'Runtime.evaluate' && params.awaitPromise === true) {
        setTimeout(() => ac.abort(), 20);
        return new Promise(() => {});
      }
      if (method === 'Runtime.evaluate') return { result: { type: 'function', objectId: 'f' } };
      return {};
    };
    expect(await cdpEvaluateSource(send, '2 + 3', { signal: ac.signal, timeoutMs: 5000 })).toEqual({ success: false, error: 'TIMEOUT: evaluate cancelled by the caller' });
  }, 3000);
});
