import { describe, it, expect, afterEach } from 'vitest';
import { envInt } from '../mcp-server/src/daemon-config.js';

/**
 * envInt (critical audit #9): bare `parseInt(process.env.X || '…')` yielded
 * NaN for non-numeric values — `WS_PORT=abc` crashed listen(), a NaN heartbeat
 * interval fired pings ~every 1ms. envInt must fall back to the default for
 * unset/garbage/out-of-range values.
 */

const SET_KEYS = ['BC_TEST_INT', 'WS_PORT'] as const;

describe('envInt', () => {
  afterEach(() => {
    for (const k of SET_KEYS) delete process.env[k];
  });

  it('returns the default when unset', () => {
    expect(envInt('BC_TEST_INT', 42)).toBe(42);
  });

  it('returns the default for non-numeric values (no NaN leakage)', () => {
    process.env.BC_TEST_INT = 'abc';
    expect(envInt('BC_TEST_INT', 42)).toBe(42);
    expect(Number.isNaN(envInt('BC_TEST_INT', 42) as number)).toBe(false);
  });

  it('returns the parsed value when valid', () => {
    process.env.BC_TEST_INT = '7';
    expect(envInt('BC_TEST_INT', 42)).toBe(7);
  });

  it('clamps below-min values back to the default', () => {
    process.env.BC_TEST_INT = '0';
    expect(envInt('BC_TEST_INT', 42, 1)).toBe(42);
    process.env.BC_TEST_INT = '-5';
    expect(envInt('BC_TEST_INT', 42, 1)).toBe(42);
  });

  it('allows 0 when min is 0 (rate-limit opt-out)', () => {
    process.env.BC_TEST_INT = '0';
    expect(envInt('BC_TEST_INT', 120, 0)).toBe(0);
  });

  it('clamps above-max values back to the default (port range)', () => {
    process.env.WS_PORT = '70000';
    expect(envInt('WS_PORT', 7225, 1, 65535)).toBe(7225);
  });
});
