import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createLogger,
  currentCorrelationId,
  newCorrelationId,
  runWithCorrelationId,
} from '../mcp-server/src/core/logger.js';

/**
 * The logger is what makes a failure followable: the scope prefix and the
 * message text stay exactly as they were, and the correlation id of the
 * request in flight is added as one more field.
 */
describe('the scoped logger', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** The lines the logger wrote while `fn` ran. */
  function capture(fn: () => void): string[] {
    const lines: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      lines.push(args.map((arg) => (typeof arg === 'string' ? arg : String(arg))).join(' '));
    });
    fn();
    return lines;
  }

  it('keeps the scope prefix and the message text', () => {
    const lines = capture(() => {
      createLogger('Bridge').error('Socket error:', 'boom');
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe('[Bridge] Socket error: boom');
  });

  it('adds the correlation id of the request in flight', () => {
    const lines = capture(() => {
      runWithCorrelationId('abc12345', () => {
        createLogger('browser-controller').error('tool browser_click failed: TAB_LOCKED');
      });
    });
    expect(lines[0]).toBe('[browser-controller] tool browser_click failed: TAB_LOCKED cid=abc12345');
  });

  it('writes no correlation id outside a request', () => {
    const lines = capture(() => {
      createLogger('browser-controller-daemon').error('client disconnected: s-1');
    });
    expect(lines[0]).not.toContain('cid=');
  });

  it('gives every logger of one request the same id', () => {
    const seen: Array<string | null> = [];
    capture(() => {
      runWithCorrelationId('shared1', () => {
        seen.push(currentCorrelationId());
        createLogger('a').error('one');
        createLogger('b').error('two');
      });
    });
    expect(seen).toEqual(['shared1']);
  });

  it('pins an id to a logger that has one of its own', () => {
    const lines = capture(() => {
      runWithCorrelationId('ambient1', () => {
        createLogger('Bridge').withCorrelationId('pinned1').error('Timeout on browser_click');
      });
    });
    expect(lines[0]).toContain('cid=pinned1');
    expect(lines[0]).not.toContain('ambient1');
  });

  it('generates a short random correlation id', () => {
    const first = newCorrelationId();
    const second = newCorrelationId();
    expect(first).toMatch(/^[0-9a-z]{8}$/u);
    expect(second).not.toBe(first);
  });
});
