import { describe, it, expect } from 'vitest';

const { cdpEvaluate } = await import('../extension/lib/cdp-evaluate.js');

type Reply = unknown | (() => unknown);
const answer = (reply: Reply) => (typeof reply === 'function' ? (reply as () => unknown)() : reply);

/** send() whose Runtime.evaluate / Runtime.awaitPromise replies are scripted. */
function scripted(evalReply: Reply, awaitReply: Reply = {}, serialized?: string) {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const send = async (method: string, params: Record<string, unknown> = {}) => {
    calls.push({ method, params });
    if (method === 'Runtime.evaluate') return answer(evalReply);
    if (method === 'Runtime.awaitPromise') return answer(awaitReply);
    if (method === 'Runtime.callFunctionOn') return { result: { value: serialized } };
    return {};
  };
  return { send, calls };
}

// What Chrome really returns for a promise-valued expression in replMode: awaitPromise is
// ignored there, so the result is the unresolved promise handle (see the real-browser check).
const pendingPromise = { result: { type: 'object', subtype: 'promise', className: 'Promise', description: 'Promise', objectId: 'p1' } };

describe('cdpEvaluate awaits a promise-valued result', () => {
  it('awaits the promise handle and returns the resolved primitive', async () => {
    const { send, calls } = scripted(pendingPromise, { result: { type: 'number', value: 5 } });
    expect(await cdpEvaluate(send, 'new Promise(r => setTimeout(() => r(5), 50))')).toEqual({ success: true, result: 5 });
    expect(calls.find((c) => c.method === 'Runtime.awaitPromise')?.params).toMatchObject({ promiseObjectId: 'p1' });
  });

  it('serializes the resolved object, never the promise itself ({} before the fix)', async () => {
    const { send } = scripted(pendingPromise, { result: { type: 'object', objectId: 'o1' } }, '{"a":[1,2]}');
    expect(await cdpEvaluate(send, 'Promise.resolve({a:[1,2]})')).toEqual({ success: true, result: { a: [1, 2] } });
  });

  it('reports a rejected promise as an error, not a value', async () => {
    const { send } = scripted(pendingPromise, {
      result: { type: 'object', subtype: 'error', objectId: 'e1', description: 'Error: nope' },
      exceptionDetails: { exception: { description: 'Error: nope' } },
    });
    expect(await cdpEvaluate(send, 'Promise.reject(new Error("nope"))')).toEqual({ success: false, error: 'Error: nope' });
  });

  it('bounds an await that never settles by the evaluate timeout', async () => {
    const { send } = scripted(pendingPromise, () => new Promise(() => {}));
    const res = await cdpEvaluate(send, 'new Promise(() => {})', { timeoutMs: 1000 });
    expect(res.success).toBe(false);
    expect(String(res.error)).toMatch(/did not finish within 1000ms/);
  });

  it('leaves non-promise results on the existing path (no awaitPromise call)', async () => {
    const { send, calls } = scripted({ result: { type: 'number', value: 2 } });
    expect(await cdpEvaluate(send, '1+1')).toEqual({ success: true, result: 2 });
    expect(calls.some((c) => c.method === 'Runtime.awaitPromise')).toBe(false);
  });
});
