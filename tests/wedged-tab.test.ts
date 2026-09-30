import { beforeEach, describe, expect, it } from 'vitest';

// executeScript never settles while `frozen` — like a page whose main thread is stuck.
let frozen = false;
let calls = 0;
const created: Array<Record<string, unknown>> = [];
const removed: number[] = [];
(globalThis as any).chrome = {
  tabs: {
    get: async (id: number) => ({ id, url: 'https://example.test/huge.json', windowId: 1 }),
    query: async () => [],
    onRemoved: { addListener: () => {} },
    create: async (o: Record<string, unknown>) => { created.push(o); return { id: 99, ...o }; },
    remove: async (id: number) => { removed.push(id); },
  },
  scripting: {
    executeScript: (o: { func: (...a: any[]) => unknown; args?: unknown[] }) => {
      calls++;
      if (frozen) return new Promise(() => {});
      return Promise.resolve([{ result: o.func(...(o.args ?? [])) }]);
    },
  },
  storage: { session: { get: async () => ({}), set: async () => {} }, local: { get: async () => ({}), set: async () => {} } },
};

const { safeExec, assertResponsive, replaceFrozenTab } = await import('../extension/lib/page-exec.js');
const { wedgedTabs, dropDocumentState } = await import('../extension/lib/state.js');

describe('frozen pages fail fast instead of pinning the tab', () => {
  beforeEach(() => { frozen = false; calls = 0; wedgedTabs.clear(); });

  it('a page call that never answers rejects with TAB_WEDGED after its budget and marks the tab', async () => {
    frozen = true;
    const t0 = Date.now();
    await expect(safeExec(3, () => 1, [], { timeoutMs: 120 })).rejects.toMatchObject({ code: 'TAB_WEDGED' });
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(wedgedTabs.has(3)).toBe(true);
  });

  it('later calls on a wedged tab only pay one short probe', async () => {
    wedgedTabs.set(3, Date.now());
    frozen = true;
    const t0 = Date.now();
    await expect(safeExec(3, () => 1, [])).rejects.toThrow(/TAB_WEDGED/);
    const took = Date.now() - t0;
    expect(took).toBeGreaterThanOrEqual(1400);
    expect(took).toBeLessThan(3000); // probe (1.5s), not the full 8s page budget
    expect(calls).toBe(1); // the real call is never queued behind the frozen page
  });

  it('a wedged tab that answers the probe again is cleared and works normally', async () => {
    wedgedTabs.set(3, Date.now());
    await assertResponsive(3);
    expect(wedgedTabs.has(3)).toBe(false);
    expect(await safeExec(3, () => 42, [])).toBe(42);
  });

  it('a new navigation clears the wedge mark', () => {
    wedgedTabs.set(3, Date.now());
    dropDocumentState(3);
    expect(wedgedTabs.has(3)).toBe(false);
  });

  it('a frozen tab is replaced in place (same window/index/active state), never waited on', async () => {
    created.length = 0; removed.length = 0;
    expect(await replaceFrozenTab({ id: 3, windowId: 1, index: 4, active: false }, 'https://example.test/next')).toBeNull();
    wedgedTabs.set(3, Date.now());
    const fresh = await replaceFrozenTab({ id: 3, windowId: 1, index: 4, active: false }, 'https://example.test/next');
    expect(fresh.id).toBe(99);
    expect(created[0]).toEqual({ windowId: 1, index: 4, url: 'https://example.test/next', active: false });
    expect(removed).toEqual([3]);
    expect(wedgedTabs.has(3)).toBe(false);
  });
});
