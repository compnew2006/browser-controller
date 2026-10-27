import { describe, it, expect, vi } from 'vitest';
import { toolMap } from '../../mcp-server/src/tools/index.js';
import { BATCH_BUDGET_MS } from '../../mcp-server/src/tools/batch-limits.js';
import type { ToolHost } from '../../mcp-server/src/tools/types.js';

const batch = toolMap.get('browser_batch')!;

/** Answers every call with success; `failOn` replies with a CODE: message failure (as the bridge rejects it). */
function fakeHost(failOn?: string, failText = 'ELEMENT_HIDDEN: #a is hidden') {
  const calls: Array<{ tool: string; params: Record<string, unknown> }> = [];
  const host: ToolHost = {
    async callTool(tool, params) {
      calls.push({ tool, params });
      if (tool === failOn) throw Object.assign(new Error(failText), { result: { success: false, error: failText } });
      return { success: true, text: `${tool} done` };
    },
  };
  return { host, calls };
}

const run = (host: ToolHost, params: Record<string, unknown>) =>
  batch.handler(host, batch.inputSchema.parse(params) as Record<string, unknown>);
const textOf = (res: { content: Array<{ type: string; text?: string }> }) =>
  res.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');

describe('browser_batch', () => {
  it('its registry timeoutMs is the batch budget, the one bound the handler enforces', () => {
    expect(batch.timeoutMs).toBe(BATCH_BUDGET_MS);
    expect('timeoutMs' in batch.inputSchema.shape).toBe(false);
  });

  it('runs steps in order, applies the default tabId, and returns the last step', async () => {
    const { host, calls } = fakeHost();
    const res = await run(host, {
      tabId: 9,
      actions: [
        { tool: 'browser_click', params: { target: '#a' } },
        { tool: 'browser_type', params: { target: '#a', text: 'x', tabId: 3 } },
        { tool: 'browser_type', params: { text: 'Tab', key: 'Tab' } },
      ],
    });
    expect(res.isError).toBeUndefined();
    expect(calls.map((c) => [c.tool, c.params.tabId])).toEqual([
      ['browser_click', 9], ['browser_type', 3], ['browser_type', 9],
    ]);
    expect(res.content).toEqual([{ type: 'text', text: 'browser_type done' }]);
  });

  it('stops at the first failing step: step i/n, the CODE: message, and the skipped count', async () => {
    const { host, calls } = fakeHost('browser_type');
    const res = await run(host, {
      tabId: 1,
      actions: [
        { tool: 'browser_click', params: { target: '#a' } },
        { tool: 'browser_type', params: { target: '#a', text: 'x' } },
        { tool: 'browser_type', params: { text: 'x', key: 'Tab' } },
      ],
    });
    expect(res.isError).toBe(true);
    expect(calls.map((c) => c.tool)).toEqual(['browser_click', 'browser_type']);
    expect(res.content).toEqual([{ type: 'text', text: 'step 2/3 browser_type: ELEMENT_HIDDEN: #a is hidden; 1 skipped' }]);
  });

  it('a failure message that ends with a full stop is joined without it (no ".;")', async () => {
    const { host } = fakeHost('browser_type', 'ELEMENT_DISABLED: input is disabled; nothing was typed.');
    const res = await run(host, { tabId: 1, actions: [{ tool: 'browser_type', params: { target: '#a', text: 'x' } }] });
    expect(textOf(res)).toBe('step 1/1 browser_type: ELEMENT_DISABLED: input is disabled; nothing was typed; 0 skipped');
  });

  it('a failing last step reports zero skipped', async () => {
    const { host } = fakeHost('browser_click', 'NOT_FOUND: no element for #a');
    const res = await run(host, { tabId: 1, actions: [{ tool: 'browser_click', params: { target: '#a' } }] });
    expect(textOf(res)).toBe('step 1/1 browser_click: NOT_FOUND: no element for #a; 0 skipped');
  });

  it('validates each step with its own schema and rejects nesting / unknown tools', async () => {
    const { host, calls } = fakeHost();
    const bad = await run(host, { tabId: 1, actions: [{ tool: 'browser_click', params: {} }] });
    expect(bad.isError).toBe(true);
    expect(textOf(bad)).toMatch(/^step 1\/1 browser_click: INVALID_ARGUMENT: /);
    const nested = await run(host, { actions: [{ tool: 'browser_batch', params: {} }] });
    expect(textOf(nested)).toBe('step 1/1 browser_batch: INVALID_ARGUMENT: browser_batch cannot be used inside a batch; 0 skipped');
    const unknown = await run(host, { actions: [{ tool: 'browser_nope' }] });
    expect(textOf(unknown)).toBe('step 1/1 browser_nope: INVALID_ARGUMENT: unknown tool browser_nope; 0 skipped');
    expect(calls).toHaveLength(0);
  });

  it('a 2.x parameter inside a step is an unknown parameter of that step, as at top level', async () => {
    const { host, calls } = fakeHost();
    const res = await run(host, { tabId: 1, actions: [{ tool: 'browser_screenshot', params: { fullPage: true } }] });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/^step 1\/1 browser_screenshot: INVALID_ARGUMENT: unknown parameter fullPage/);
    expect(calls).toHaveLength(0);
  });

  it('a step that throws something that is not a CODE: message is INTERNAL_ERROR, never a bare text', async () => {
    const host: ToolHost = { async callTool() { throw new Error('boom'); } };
    const res = await run(host, { tabId: 1, actions: [{ tool: 'browser_click', params: { target: '#a' } }] });
    expect(textOf(res)).toBe('step 1/1 browser_click: INTERNAL_ERROR: boom; 0 skipped');
  });

  it('never gives the default tabId to browser_tabs, and never overrides a step tabId', async () => {
    const { host, calls } = fakeHost();
    const res = await run(host, {
      tabId: 9,
      actions: [
        { tool: 'browser_tabs', params: { action: 'list' } },
        { tool: 'browser_tabs', params: { action: 'close', tabId: 4 } },
        { tool: 'browser_click', params: { target: '#a' } },
      ],
    });
    expect(res.isError).toBeUndefined();
    expect(calls[0]!.params).not.toHaveProperty('tabId');
    expect(calls[1]!.params.tabId).toBe(4);
    expect(calls[2]!.params.tabId).toBe(9);
  });

  it('a navigate without tabId opens a tab; its tabId becomes the default for the later steps', async () => {
    const calls: Array<{ tool: string; params: Record<string, unknown> }> = [];
    const host: ToolHost = {
      async callTool(tool, params) {
        calls.push({ tool, params });
        if (tool === 'browser_navigate') return { success: true, text: 'tabId: 77\nurl: https://x.test/', tabId: 77 };
        return { success: true, text: 'ok' };
      },
    };
    const res = await run(host, {
      actions: [
        { tool: 'browser_navigate', params: { url: 'https://x.test/' } },
        { tool: 'browser_click', params: { target: '#go' } },
        { tool: 'browser_navigate', params: { url: 'https://x.test/next' } },
      ],
    });
    expect(res.isError).toBeUndefined();
    expect(calls[0]!.params).not.toHaveProperty('tabId');
    expect(calls[1]!.params.tabId).toBe(77);
    expect(calls[2]!.params.tabId).toBe(77);
  });

  it('a batch tabId wins over a tab a navigate step opened', async () => {
    const calls: Array<{ tool: string; params: Record<string, unknown> }> = [];
    const host: ToolHost = {
      async callTool(tool, params) {
        calls.push({ tool, params });
        return tool === 'browser_navigate' ? { success: true, text: 'tabId: 88', tabId: 88 } : { success: true, text: 'ok' };
      },
    };
    await run(host, {
      tabId: 5,
      actions: [
        { tool: 'browser_navigate', params: { url: 'https://x.test/' } },
        { tool: 'browser_click', params: { target: '#go' } },
      ],
    });
    expect(calls[1]!.params.tabId).toBe(5);
  });

  it('a delay step (ms) sleeps locally, and is capped at 10 s with a note', async () => {
    vi.useFakeTimers();
    try {
      const { host, calls } = fakeHost();
      const pending = run(host, { tabId: 1, actions: [{ tool: 'browser_wait', params: { ms: 20_000 } }] });
      await vi.advanceTimersByTimeAsync(10_000);
      const res = await pending;
      expect(res.isError).toBeUndefined();
      expect(textOf(res)).toBe('waited 10000 ms (delay clamped to 10000 ms, requested 20000 ms)');
      expect(calls).toHaveLength(0); // no daemon call for a plain delay
    } finally {
      vi.useRealTimers();
    }
  });

  it('retries a rate-limited step after the window', async () => {
    const calls: string[] = [];
    let limited = 1;
    const host: ToolHost = {
      async callTool(tool) {
        calls.push(tool);
        if (tool === 'browser_click' && limited-- > 0) throw new Error('Rate limit exceeded (120 calls/min). Retry in ~0s.');
        return { success: true, text: 'ok' };
      },
    };
    const res = await run(host, { tabId: 1, actions: [{ tool: 'browser_click', params: { target: '#a' } }] });
    expect(res.isError).toBeUndefined();
    expect(calls).toEqual(['browser_click', 'browser_click']);
  });

  it('accepts at most 50 steps', () => {
    const step = { tool: 'browser_click', params: { target: '#a' } };
    expect(batch.inputSchema.safeParse({ actions: Array(50).fill(step) }).success).toBe(true);
    expect(batch.inputSchema.safeParse({ actions: Array(51).fill(step) }).success).toBe(false);
  });

  it('a step that outlives the 50 s batch budget is cut at the budget: TIMEOUT, the rest skipped', async () => {
    vi.useFakeTimers();
    try {
      const calls: string[] = [];
      const host: ToolHost = {
        async callTool(tool) {
          calls.push(tool);
          await new Promise((resolve) => setTimeout(resolve, 30_000));
          return { success: true, text: `${tool} done` };
        },
      };
      const pending = run(host, {
        tabId: 1,
        actions: [
          { tool: 'browser_click', params: { target: '#a' } },
          { tool: 'browser_click', params: { target: '#b' } },
          { tool: 'browser_click', params: { target: '#c' } },
        ],
      });
      await vi.advanceTimersByTimeAsync(60_000);
      const res = await pending;
      expect(res.isError).toBe(true);
      // Step 2 starts at 30 s with 20 s of budget left: it is cut at 50 s, and step 3 never starts.
      // browser_click is a write step, so AC-C3 adds the outcome-unknown note (read steps keep the plain text, see below).
      expect(textOf(res)).toBe('step 2/3 browser_click: TIMEOUT: batch budget used; outcome unknown, the step may have completed: check the page before retrying; 1 skipped');
      expect(calls).toEqual(['browser_click', 'browser_click']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a write step cut by the budget reports an unknown outcome and says to check the page', async () => {
    vi.useFakeTimers();
    try {
      const host: ToolHost = {
        async callTool() {
          await new Promise((resolve) => setTimeout(resolve, 60_000));
          return { success: true, text: 'done' };
        },
      };
      const pending = run(host, { tabId: 1, actions: [{ tool: 'browser_click', params: { target: '#a' } }, { tool: 'browser_click', params: { target: '#b' } }] });
      await vi.advanceTimersByTimeAsync(60_000);
      const text = textOf(await pending);
      expect(text).toMatch(/^step 1\/2 browser_click: TIMEOUT: batch budget used; outcome unknown/);
      expect(text).toMatch(/check the page before retrying/);
      expect(text).toMatch(/1 skipped$/);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a read step cut by the budget keeps the plain TIMEOUT message', async () => {
    vi.useFakeTimers();
    try {
      const host: ToolHost = {
        async callTool() {
          await new Promise((resolve) => setTimeout(resolve, 60_000));
          return { success: true, text: 'done' };
        },
      };
      const pending = run(host, { tabId: 1, actions: [{ tool: 'browser_snapshot', params: {} }] });
      await vi.advanceTimersByTimeAsync(60_000);
      expect(textOf(await pending)).toBe('step 1/1 browser_snapshot: TIMEOUT: batch budget used; 0 skipped');
    } finally {
      vi.useRealTimers();
    }
  });

  it('a step that finishes inside the budget returns its result and the batch goes on', async () => {
    vi.useFakeTimers();
    try {
      const { host, calls } = fakeHost();
      const pending = run(host, {
        tabId: 1,
        actions: [
          { tool: 'browser_wait', params: { ms: 20_000 } },
          { tool: 'browser_click', params: { target: '#a' } },
        ],
      });
      await vi.advanceTimersByTimeAsync(20_000);
      const res = await pending;
      expect(res.isError).toBeUndefined();
      expect(calls.map((c) => c.tool)).toEqual(['browser_click']);
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
    const res = await run(host, { tabId: 1, actions: [{ tool: 'browser_click', params: { target: '#a' } }] });
    expect(res.isError).toBe(true);
    expect(calls).toHaveLength(1); // a 61 s wait is past the 50 s budget, so no retry
  });
});
