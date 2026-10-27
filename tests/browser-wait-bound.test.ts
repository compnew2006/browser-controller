import { describe, it, expect, vi, afterEach } from 'vitest';

/**
 * F8-5: browser_wait must settle with its own coded result before the 55 s transport timeout,
 * even when a poll hangs (execDom here ignores its budget, as a doubled install+retry would)
 * and must stop at once on abort.
 */
const exec = vi.hoisted(() => ({ execDom: vi.fn() }));
vi.mock('../extension/lib/page-exec.js', () => ({
  safeExec: vi.fn(),
  execDom: exec.execDom,
  resolveTab: vi.fn(async () => ({ id: 1, url: 'https://example.com/' })),
  getFallback: vi.fn(() => null),
}));
vi.mock('../extension/lib/trusted-input.js', () => ({ requireSender: vi.fn(), pointInfo: vi.fn(), releaseShield: vi.fn() }));
vi.mock('../extension/lib/drag-input.js', () => ({ withFrames: vi.fn() }));
vi.mock('../extension/lib/state.js', () => ({ fallbackByTab: new Map(), persistSessionState: vi.fn() }));

const { handleWait } = await import('../extension/handlers/inspection.js');

const hang = () => new Promise(() => {});

describe('browser_wait bound (F8-5)', () => {
  afterEach(() => { vi.useRealTimers(); exec.execDom.mockReset(); });

  it('ends with its own TIMEOUT at the timeout when a poll never answers', async () => {
    vi.useFakeTimers();
    exec.execDom.mockImplementation(hang);
    let settled: unknown = null;
    void handleWait({ tabId: 1, url: 'x', timeout: 50_000 }).then((r: unknown) => { settled = r; });
    await vi.advanceTimersByTimeAsync(50_000);
    expect(settled).toMatchObject({ success: false });
    expect((settled as { error: string }).error).toMatch(/^TIMEOUT: .*not met after 50000 ms/);
  });

  it('never runs past the 50 s hard max (margin below the 55 s tool timeout) when a poll is slow', async () => {
    vi.useFakeTimers();
    exec.execDom.mockImplementation(() => new Promise((r) => setTimeout(() => r({ met: false }), 49_000)));
    let settled: unknown = null;
    void handleWait({ tabId: 1, url: 'x', timeout: 99_999 }).then((r: unknown) => { settled = r; });
    await vi.advanceTimersByTimeAsync(50_000);
    expect(settled).toMatchObject({ success: false });
    expect((settled as { error: string }).error).toMatch(/^TIMEOUT:/);
  });

  it('stops at once on abort while a poll hangs', async () => {
    vi.useFakeTimers();
    exec.execDom.mockImplementation(hang);
    const ac = new AbortController();
    let settled: unknown = null;
    void handleWait({ tabId: 1, url: 'x', timeout: 50_000 }, undefined, undefined, ac.signal).then((r: unknown) => { settled = r; });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(settled).toBeNull();
    ac.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toEqual({ success: false, error: 'TIMEOUT: wait cancelled by the caller' });
  });

  it('does not poll again after abort', async () => {
    vi.useFakeTimers();
    exec.execDom.mockResolvedValue({ met: false });
    const ac = new AbortController();
    const p = handleWait({ tabId: 1, url: 'x', timeout: 50_000 }, undefined, undefined, ac.signal);
    await vi.advanceTimersByTimeAsync(500);
    ac.abort();
    const calls = exec.execDom.mock.calls.length;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await p).toMatchObject({ success: false });
    expect(exec.execDom.mock.calls.length).toBe(calls);
  });
});

describe('browser_wait TIMEOUT says what the target matched', () => {
  afterEach(() => { vi.useRealTimers(); exec.execDom.mockReset(); });

  it('a selector that matched nothing says so (a wrong selector, not a slow page)', async () => {
    vi.useFakeTimers();
    exec.execDom.mockResolvedValue({ met: false, miss: 'NOT_FOUND' });
    const p = handleWait({ tabId: 1, target: '#nope', timeout: 1_000 });
    await vi.advanceTimersByTimeAsync(1_200);
    expect((await p as { error: string }).error).toBe('TIMEOUT: target #nope visible not met after 1000 ms (it matched nothing: check the selector or take a snapshot)');
  });

  it('a target that matched only hidden elements says so', async () => {
    vi.useFakeTimers();
    exec.execDom.mockResolvedValue({ met: false, miss: 'ELEMENT_HIDDEN' });
    const p = handleWait({ tabId: 1, target: '.spinner', timeout: 1_000 });
    await vi.advanceTimersByTimeAsync(1_200);
    expect((await p as { error: string }).error).toBe('TIMEOUT: target .spinner visible not met after 1000 ms (it matched only hidden elements)');
  });
});
