import { afterEach, describe, expect, it, vi } from 'vitest';
import { normalizeBrowserLabel, withTimeout } from '../extension/lib/connection-transport.js';

describe('normalizeBrowserLabel', () => {
  it('compacts whitespace and removes control characters', () => {
    expect(normalizeBrowserLabel('  Treelancer\n\t Work  ')).toBe('Treelancer Work');
  });

  it('allows clearing a label and rejects values over the limit or non-text input', () => {
    expect(normalizeBrowserLabel('')).toBe('');
    expect(normalizeBrowserLabel('x'.repeat(65))).toBeNull();
    expect(normalizeBrowserLabel(12)).toBeNull();
  });
});

describe('withTimeout', () => {
  afterEach(() => vi.useRealTimers());

  it('a synchronous throw from run propagates and leaves no timer to reject later (AC-W2)', async () => {
    vi.useFakeTimers();
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      expect(() => withTimeout(() => { throw new Error('boom'); }, 50)).toThrow('boom');
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(100);
      vi.useRealTimers();
      await new Promise((r) => setTimeout(r, 5));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('still times out a run that never settles and aborts its signal', async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const pending = withTimeout((s: AbortSignal) => { signal = s; return new Promise(() => {}); }, 50);
    const assertion = expect(pending).rejects.toThrow('request timed out');
    await vi.advanceTimersByTimeAsync(60);
    await assertion;
    expect(signal?.aborted).toBe(true);
  });
});
