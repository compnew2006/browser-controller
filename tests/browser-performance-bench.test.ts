import { describe, expect, it } from 'vitest';
import { runPairedBenchmark, startFixture, summarize } from '../scripts/browser-performance-bench.mjs';

describe('browser performance fixture and reporting', () => {
  it('uses nearest-rank percentiles and represents missing samples honestly', () => {
    expect(summarize([])).toEqual({ n: 0, p50: null, p95: null });
    expect(summarize(Array.from({ length: 20 }, (_, i) => 20 - i))).toEqual({ n: 20, p50: 10, p95: 19 });
    expect(() => summarize([NaN])).toThrow();
  });

  it('serves only a small loopback fixture and its same-origin iframe', async () => {
    const fixture = await startFixture();
    try {
      expect(fixture.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      const main = await fetch(fixture.baseUrl);
      expect(main.status).toBe(200);
      expect(await main.text()).toContain('src="/frame"');
      expect((await fetch(`${fixture.baseUrl}/frame`)).status).toBe(200);
      expect((await fetch(`${fixture.baseUrl}/missing`)).status).toBe(404);
      expect((await fetch(fixture.baseUrl, { method: 'POST' })).status).toBe(404);
    } finally { await fixture.close(); }
  });

  it('pairs cold and warm samples, counts real callbacks, and excludes warmups', async () => {
    let now = 0;
    const created = { a: 0, b: 0 };
    const closed = { a: 0, b: 0 };
    const order: string[] = [];
    const adapter = (key: 'a' | 'b') => ({
      async createSession({ baseUrl, mode, measure }: { baseUrl: string; mode: string; measure?: (name: string, fn: () => Promise<void>) => Promise<void> }) {
        expect(baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
        created[key] += 1;
        expect(measure).toBeTypeOf('function');
        await measure!('connection', async () => {});
        return {
          async reset() {},
          async run({ scenario, measure: timed, recordRequest }: { scenario: string; measure: (name: string, fn: () => Promise<void>) => Promise<void>; recordRequest: (bytes: number) => void }) {
            order.push(key);
            expect(scenario).toBe('navigation');
            await timed('target_resolution', async () => {});
            recordRequest(12);
            return { success: true };
          },
          async close() { closed[key] += 1; },
        };
      },
    });
    const report = await runPairedBenchmark({ adapters: { a: adapter('a'), b: adapter('b') }, scenarios: ['navigation'], iterations: 3, warmups: 1, clock: () => now++ });
    expect(created).toEqual({ a: 4, b: 4 });
    expect(closed).toEqual(created);
    expect(order.slice(0, 6)).toEqual(['a', 'b', 'b', 'a', 'a', 'b']);
    for (const key of ['a', 'b'] as const) {
      const cold = report.results.navigation.cold[key];
      const warm = report.results.navigation.warm[key];
      expect(cold).toMatchObject({ attempted: 3, passed: 3, failed: 0, requests: 3, payloadBytes: 36 });
      expect(warm).toMatchObject({ attempted: 3, passed: 3, failed: 0, requests: 3, payloadBytes: 36 });
      expect(cold.phasesMs.connection.n).toBe(3);
      expect(warm.phasesMs.connection).toEqual({ n: 0, p50: null, p95: null });
      expect(warm.phasesMs.target_resolution.n).toBe(3);
      expect(warm.phasesMs.save.n).toBe(0);
    }
  });

  it('counts failed attempts without reporting adapter exception text', async () => {
    const secret = 'SENSITIVE-PAGE-CONTENT';
    let closed = 0;
    const broken = { async createSession() { return { async reset() {}, async run() { throw new Error(secret); }, async close() { closed += 1; } }; } };
    const good = { async createSession() { return { async reset() {}, async run() { return { success: true }; }, async close() {} }; } };
    const report = await runPairedBenchmark({ adapters: { a: broken, b: good }, scenarios: ['input'], iterations: 2, warmups: 1 });
    expect(report.results.input.cold.a).toMatchObject({ attempted: 2, passed: 0, failed: 2 });
    expect(report.results.input.warm.a).toMatchObject({ attempted: 2, passed: 0, failed: 2 });
    expect(report.results.input.warm.a.successfulDurationMs.n).toBe(0);
    expect(report.results.input.warm.a.failedDurationMs.n).toBe(2);
    expect(report.results.input.warm.b.successfulDurationMs.n).toBe(2);
    expect(closed).toBe(3);
    expect(JSON.stringify(report)).not.toContain(secret);
  });

  it('resets a reused session before every sample', async () => {
    const adapter = { async createSession() {
      let dirty = false;
      return {
        async reset() { dirty = false; },
        async run() { if (dirty) throw new Error('stale state'); dirty = true; return { success: true }; },
        async close() {},
      };
    } };
    const report = await runPairedBenchmark({ adapters: { a: adapter, b: adapter }, scenarios: ['spa'], iterations: 3, warmups: 1 });
    expect(report.results.spa.warm.a).toMatchObject({ passed: 3, failed: 0 });
  });

  it('rejects unsupported scenarios and invalid sample counts', async () => {
    const adapter = { async createSession() { return { async reset() {}, async run() { return { success: true }; }, async close() {} }; } };
    await expect(runPairedBenchmark({ adapters: { a: adapter, b: adapter }, scenarios: ['external'], iterations: 1 })).rejects.toThrow();
    await expect(runPairedBenchmark({ adapters: { a: adapter, b: adapter }, iterations: 0 })).rejects.toThrow();
  });
});
