import { describe, it, expect, vi } from 'vitest';
import { toolMap } from '../../mcp-server/src/tools/index.js';
import type { ToolHost } from '../../mcp-server/src/tools/types.js';

const batch = toolMap.get('browser_batch')!;

function fakeHost(failOn?: string) {
  const calls: Array<{ tool: string; params: Record<string, unknown> }> = [];
  const host: ToolHost = {
    async callTool(tool, params) {
      calls.push({ tool, params });
      if (tool === failOn) throw Object.assign(new Error('boom'), { result: { success: false, error: 'boom' } });
      return { success: true, tool };
    },
  };
  return { host, calls };
}

const run = (host: ToolHost, params: Record<string, unknown>) =>
  batch.handler(host, batch.inputSchema.parse(params) as Record<string, unknown>);

describe('browser_batch', () => {
  it('runs steps in order and applies the default tabId', async () => {
    const { host, calls } = fakeHost();
    const res = await run(host, {
      tabId: 9,
      actions: [
        { tool: 'browser_click', params: { selector: '#a' } },
        { tool: 'browser_type', params: { selector: '#a', text: 'x', tabId: 3 } },
        { tool: 'browser_press_key', params: { key: 'Tab' } },
      ],
    });
    expect(res.isError).toBeUndefined();
    expect(calls.map((c) => [c.tool, c.params.tabId])).toEqual([
      ['browser_click', 9], ['browser_type', 3], ['browser_press_key', 9],
    ]);
    expect((res.content[0] as { text: string }).text).toBe('batch: 3/3 steps ok');
  });

  it('stops at the first failing step', async () => {
    const { host, calls } = fakeHost('browser_type');
    const res = await run(host, {
      tabId: 1,
      actions: [
        { tool: 'browser_click', params: { selector: '#a' } },
        { tool: 'browser_type', params: { selector: '#a', text: 'x' } },
        { tool: 'browser_press_key', params: { key: 'Tab' } },
      ],
    });
    expect(res.isError).toBe(true);
    expect(calls.map((c) => c.tool)).toEqual(['browser_click', 'browser_type']);
    expect(res.content.some((c) => c.type === 'text' && c.text.includes('1 remaining step(s) skipped'))).toBe(true);
  });

  it('continueOnError keeps going', async () => {
    const { host, calls } = fakeHost('browser_click');
    const res = await run(host, {
      tabId: 1,
      continueOnError: true,
      actions: [
        { tool: 'browser_click', params: { selector: '#a' } },
        { tool: 'browser_press_key', params: { key: 'Tab' } },
      ],
    });
    expect(res.isError).toBe(true);
    expect(calls).toHaveLength(2);
    expect((res.content[0] as { text: string }).text).toBe('batch: 1/2 steps ok');
  });

  it('validates each step with its own schema and rejects nesting / unknown tools', async () => {
    const { host, calls } = fakeHost();
    const bad = await run(host, { tabId: 1, actions: [{ tool: 'browser_type', params: { selector: '#a' } }] });
    expect(bad.isError).toBe(true);
    expect(JSON.stringify(bad.content)).toMatch(/Invalid tool arguments for browser_type/);
    const nested = await run(host, { actions: [{ tool: 'browser_batch', params: {} }] });
    expect(JSON.stringify(nested.content)).toMatch(/cannot be used inside a batch/);
    const unknown = await run(host, { actions: [{ tool: 'nope' }] });
    expect(JSON.stringify(unknown.content)).toMatch(/unknown tool/);
    expect(calls).toHaveLength(0);
  });

  it('output:last returns only the last step (and failures)', async () => {
    const { host } = fakeHost();
    const res = await run(host, {
      tabId: 1,
      output: 'last',
      actions: [
        { tool: 'browser_click', params: { selector: '#a' } },
        { tool: 'browser_press_key', params: { key: 'Tab' } },
      ],
    });
    const texts = res.content.map((c) => (c.type === 'text' ? c.text : ''));
    expect(texts[0]).toBe('batch: 2/2 steps ok');
    expect(texts.some((t) => t.startsWith('[1/2]'))).toBe(false);
    expect(texts.some((t) => t.startsWith('[2/2] browser_press_key ok'))).toBe(true);
  });

  it('runs a pure delay locally and retries a rate-limited step', async () => {
    const calls: string[] = [];
    let limited = 1;
    const host: ToolHost = {
      async callTool(tool) {
        calls.push(tool);
        if (tool === 'browser_click' && limited-- > 0) throw new Error('Rate limit exceeded (120 calls/min). Retry in ~0s.');
        return { success: true };
      },
    };
    const res = await run(host, {
      tabId: 1,
      actions: [
        { tool: 'browser_wait', params: { delay: 10 } },
        { tool: 'browser_click', params: { selector: '#a' } },
      ],
    });
    expect(res.isError).toBeUndefined();
    expect(calls).toEqual(['browser_click', 'browser_click']);
  });

  it('shows per-step time for the steps it prints, then one total line', async () => {
    const { host } = fakeHost();
    const res = await run(host, {
      tabId: 1,
      actions: [
        { tool: 'browser_click', params: { selector: '#a' } },
        { tool: 'browser_press_key', params: { key: 'Tab' } },
      ],
    });
    const texts = res.content.map((c) => (c.type === 'text' ? c.text : ''));
    expect(texts.some((t) => /^\[1\/2\] browser_click ok \d+ ms$/.test(t))).toBe(true);
    expect(texts.some((t) => /^\[2\/2\] browser_press_key ok \d+ ms$/.test(t))).toBe(true);
    expect(texts[texts.length - 1]).toMatch(/^2 steps, \d+ ms$/);
    expect(texts.some((t) => t.startsWith('timing:'))).toBe(false);
    expect(texts[0]).toBe('batch: 2/2 steps ok');
  });

  it('adds no per-step line for steps that output:last does not show', async () => {
    const { host } = fakeHost();
    const actions = Array.from({ length: 100 }, () => ({ tool: 'browser_press_key', params: { key: 'Tab' } }));
    const res = await run(host, { tabId: 1, output: 'last', actions });
    const texts = res.content.map((c) => (c.type === 'text' ? c.text : ''));
    expect(texts.filter((t) => /^\[\d+\/100\] /.test(t))).toHaveLength(1);
    expect(texts.some((t) => /^\[100\/100\] browser_press_key ok \d+ ms$/.test(t))).toBe(true);
    expect(texts[texts.length - 1]).toMatch(/^100 steps, \d+ ms$/);
  });

  it('accepts at most 100 steps', () => {
    const step = { tool: 'browser_click', params: { selector: '#a' } };
    expect(batch.inputSchema.safeParse({ actions: Array(100).fill(step) }).success).toBe(true);
    expect(batch.inputSchema.safeParse({ actions: Array(101).fill(step) }).success).toBe(false);
  });

  it('never gives the default tabId to browser_tabs, and never overrides a step tabId', async () => {
    const { host, calls } = fakeHost();
    const res = await run(host, {
      tabId: 9,
      actions: [
        { tool: 'browser_tabs', params: { action: 'list' } },
        { tool: 'browser_tabs', params: { action: 'close', tabId: 4 } },
        { tool: 'browser_click', params: { selector: '#a' } },
      ],
    });
    expect(res.isError).toBeUndefined();
    expect(calls[0]!.params).not.toHaveProperty('tabId');
    expect(calls[1]!.params.tabId).toBe(4);
    expect(calls[2]!.params.tabId).toBe(9);
  });

  it('a browser_tabs close without its own tabId fails instead of closing the batch tab', async () => {
    const { host, calls } = fakeHost();
    const res = await run(host, { tabId: 9, actions: [{ tool: 'browser_tabs', params: { action: 'close' } }] });
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toMatch(/Invalid tool arguments for browser_tabs/);
    expect(calls).toHaveLength(0);
  });

  it('caps a delay step at 10 s and says so', async () => {
    vi.useFakeTimers();
    try {
      const { host } = fakeHost();
      const pending = run(host, { tabId: 1, actions: [{ tool: 'browser_wait', params: { delay: 60_000 } }] });
      await vi.advanceTimersByTimeAsync(10_000);
      const res = await pending;
      const text = res.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');
      expect(res.isError).toBeUndefined();
      expect(text).toContain('"waited":10000');
      expect(text).toContain('delay clamped to 10000 ms (requested 60000 ms)');
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops starting new steps once the 50 s batch budget is spent', async () => {
    vi.useFakeTimers();
    try {
      const host: ToolHost = {
        async callTool(tool) {
          await new Promise((resolve) => setTimeout(resolve, 30_000));
          return { success: true, tool };
        },
      };
      const pending = run(host, {
        tabId: 1,
        actions: [
          { tool: 'browser_click', params: { selector: '#a' } },
          { tool: 'browser_click', params: { selector: '#b' } },
          { tool: 'browser_click', params: { selector: '#c' } },
        ],
      });
      await vi.advanceTimersByTimeAsync(60_000);
      const res = await pending;
      const texts = res.content.map((c) => (c.type === 'text' ? c.text : ''));
      expect(res.isError).toBe(true);
      expect(texts[0]).toBe('batch: 2/3 steps ok');
      expect(texts).toContain('step 3/3: TIMEOUT; 1 skipped (batch budget 50 s)');
      expect(texts[texts.length - 1]).toMatch(/^2 steps, \d+ ms$/);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not sleep out a rate limit that would pass the batch budget', async () => {
    const calls: string[] = [];
    const host: ToolHost = {
      async callTool(tool) {
        calls.push(tool);
        throw new Error('Rate limit exceeded (120 calls/min). Retry in ~60s.');
      },
    };
    const res = await run(host, { tabId: 1, actions: [{ tool: 'browser_click', params: { selector: '#a' } }] });
    expect(res.isError).toBe(true);
    expect(calls).toHaveLength(1); // a 61 s wait is past the 50 s budget, so no retry
  });
});
