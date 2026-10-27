import { describe, it, expect } from 'vitest';

/**
 * F9-6: the size cap applies page-side, so a huge result never crosses CDP in full.
 * The mock runs the serializer from its source text (as the page would: serialized alone)
 * against a real value and records what it hands back over the boundary.
 */
const { cdpEvaluateSource } = await import('../extension/lib/cdp-evaluate.js');
const { MAX_RESULT_CHARS } = await import('../extension/lib/state.js');

function pageSend(value: unknown) {
  const crossed: number[] = [];
  const send = async (method: string, params: Record<string, unknown> = {}) => {
    if (method === 'Runtime.evaluate') return { result: { type: 'object', objectId: 'o1' } };
    if (method === 'Runtime.callFunctionOn') {
      const fn = new Function(`return (${params.functionDeclaration})`)();
      const args = ((params.arguments as Array<{ value: unknown }>) ?? []).map((a) => a.value);
      const out = fn.apply(value, args);
      crossed.push(typeof out === 'string' ? out.length : JSON.stringify(out).length);
      return { result: { value: out } };
    }
    return {};
  };
  return { send, crossed };
}

describe('evaluate size cap runs page-side (F9-6)', () => {
  it('an over-cap value returns the existing truncated result, and no payload over the cap crosses CDP', async () => {
    const big = { data: 'x'.repeat(MAX_RESULT_CHARS * 5) };
    const { send, crossed } = pageSend(big);
    const res = await cdpEvaluateSource(send, 'big') as Record<string, unknown>;
    expect(res.success).toBe(true);
    expect(res.truncated).toBe(true);
    expect((res.result as string).length).toBe(MAX_RESULT_CHARS);
    expect(res.fullLength).toBe(JSON.stringify(big).length);
    expect(Math.max(...crossed)).toBeLessThanOrEqual(MAX_RESULT_CHARS + 1_000);
  });

  it('an under-cap value is unchanged', async () => {
    const { send } = pageSend({ a: [1, 'two', null], b: { c: true } });
    expect(await cdpEvaluateSource(send, 'v')).toEqual({ success: true, result: { a: [1, 'two', null], b: { c: true } } });
  });
});
