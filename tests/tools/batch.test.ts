import { describe, it, expect } from 'vitest';
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

  it('reports elapsed time for each step and for the whole batch', async () => {
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
    expect(texts[texts.length - 1]).toMatch(/^timing: total \d+ ms; steps \d+, \d+ ms$/);
    expect(texts[0]).toBe('batch: 2/2 steps ok');
  });
});
