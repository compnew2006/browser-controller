import { describe, expect, it } from 'vitest';
import { waitTool } from '../../mcp-server/src/tools/wait.js';
import type { ToolHost, ToolResult } from '../../mcp-server/src/tools/types.js';

/**
 * browser_wait {until:'stable'}: wait for the page to stop changing.
 *
 * The page is fingerprinted every 100 ms; two identical readings mean the page
 * settled. A page that never settles reaches the deadline and is reported as
 * still changing, so the agent knows the wait did not buy it anything.
 */

const text = (res: ToolResult) => (res.content.find((c) => c.type === 'text') as { text: string }).text;

/** A host whose page readings are the fingerprints it is given, in order. */
function fingerprintHost(fingerprints: string[]) {
  const calls: Array<{ tool: string; params: Record<string, unknown> }> = [];
  let reads = 0;
  const host: ToolHost = {
    async callTool(tool, params) {
      calls.push({ tool, params });
      if (tool === 'browser_evaluate') {
        const value = fingerprints[Math.min(reads, fingerprints.length - 1)];
        reads += 1;
        return { success: true, text: value, result: value };
      }
      return { success: true, text: 'ok' };
    },
  };
  return { host, calls };
}

const run = (host: ToolHost, params: Record<string, unknown>) =>
  waitTool.handler(host, waitTool.inputSchema.parse(params) as Record<string, unknown>);

describe('browser_wait until:stable', () => {
  it('returns once two readings of the page agree', async () => {
    const { host, calls } = fingerprintHost(['10:a', '10:a']);
    const res = await run(host, { tabId: 1, until: 'stable' });
    expect(res.isError).toBeFalsy();
    expect(text(res)).toMatch(/^page settled after \d+ ms$/);
    expect(calls.filter((call) => call.tool === 'browser_evaluate').length).toBe(2);
  });

  it('reports a page that never settles as still changing', async () => {
    let reads = 0;
    const host: ToolHost = {
      async callTool(tool) {
        if (tool === 'browser_evaluate') {
          reads += 1;
          return { success: true, text: `${reads}:x`, result: `${reads}:x` };
        }
        return { success: true, text: 'ok' };
      },
    };
    const res = await run(host, { tabId: 1, until: 'stable', timeout: 400 });
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/^TIMEOUT: the page was still changing after \d+ ms/);
  });

  it('a page that cannot be read does not wait forever', async () => {
    const host: ToolHost = {
      async callTool() { return { success: false, error: 'TAB_NOT_FOUND: tab 1 is closed or was never opened.' }; },
    };
    const res = await run(host, { tabId: 1, until: 'stable', timeout: 400 });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain('TIMEOUT');
  });

  it('a tab that is gone ends the wait at once', async () => {
    let reads = 0;
    const host: ToolHost = {
      async callTool(tool) {
        if (tool === 'browser_evaluate') {
          reads += 1;
          // The extension's own code for a tab that is gone (extension/lib/page-exec.js).
          return { success: false, error: 'TAB_NOT_FOUND: tab 1 is closed or was never opened.' };
        }
        return { success: true, text: 'ok' };
      },
    };
    const res = await run(host, { tabId: 1, until: 'stable', timeout: 5000 });
    expect(res.isError).toBe(true);
    // A tab that is gone never comes back, so the wait does not retry it.
    expect(reads).toBe(1);
  });

  it('a tab that was replaced ends the wait at once', async () => {
    let reads = 0;
    const host: ToolHost = {
      async callTool(tool) {
        if (tool === 'browser_evaluate') {
          reads += 1;
          return { success: false, error: 'TAB_REPLACED: tab 1 was replaced by tab 2.' };
        }
        return { success: true, text: 'ok' };
      },
    };
    const res = await run(host, { tabId: 1, until: 'stable', timeout: 5000 });
    expect(res.isError).toBe(true);
    expect(reads).toBe(1);
  });

  it('a transient read failure is retried, so a settled page still settles', async () => {
    // The debugger detached for one read: the extension says the next call
    // reattaches on its own, so the wait must read again rather than report a
    // page that had already settled as one that never settled.
    let reads = 0;
    const host: ToolHost = {
      async callTool(tool) {
        if (tool === 'browser_evaluate') {
          reads += 1;
          if (reads === 1) {
            return { success: false, error: 'DEBUGGER_UNAVAILABLE: the debugger session failed; the next call reattaches' };
          }
          return { success: true, text: '10:a', result: '10:a' };
        }
        return { success: true, text: 'ok' };
      },
    };
    const res = await run(host, { tabId: 1, until: 'stable', timeout: 2000 });
    expect(res.isError).toBeFalsy();
    expect(text(res)).toMatch(/^page settled after \d+ ms$/);
    expect(reads).toBe(3);
  });

  it('a page that stays unreadable ends the wait instead of looping', async () => {
    let reads = 0;
    const host: ToolHost = {
      async callTool(tool) {
        if (tool === 'browser_evaluate') {
          reads += 1;
          return { success: false, error: 'DEBUGGER_UNAVAILABLE: the debugger session failed' };
        }
        return { success: true, text: 'ok' };
      },
    };
    const res = await run(host, { tabId: 1, until: 'stable', timeout: 5000 });
    expect(res.isError).toBe(true);
    // Three consecutive failures end it: the wait does not spend its whole budget.
    expect(reads).toBe(3);
  });

  it('a thrown call is treated as transient, not as an unreadable page', async () => {
    let reads = 0;
    const host: ToolHost = {
      async callTool(tool) {
        if (tool === 'browser_evaluate') {
          reads += 1;
          if (reads === 1) throw new Error('bridge went away');
          return { success: true, text: '10:a', result: '10:a' };
        }
        return { success: true, text: 'ok' };
      },
    };
    const res = await run(host, { tabId: 1, until: 'stable', timeout: 2000 });
    expect(res.isError).toBeFalsy();
    expect(text(res)).toMatch(/^page settled after \d+ ms$/);
  });

  it('the other waits still go to the extension', async () => {
    const { host, calls } = fingerprintHost(['1:a']);
    const res = await run(host, { tabId: 1, url: 'https://x.test/' });
    expect(res.isError).toBeFalsy();
    expect(calls).toEqual([{ tool: 'browser_wait', params: { tabId: 1, url: 'https://x.test/' } }]);
  });

  it('it is one wait, not two: exactly one of target, url, ms or until', () => {
    expect(waitTool.inputSchema.safeParse({ tabId: 1, until: 'stable' }).success).toBe(true);
    expect(waitTool.inputSchema.safeParse({ tabId: 1 }).success).toBe(false);
    expect(waitTool.inputSchema.safeParse({ tabId: 1, until: 'stable', ms: 10 }).success).toBe(false);
    expect(waitTool.inputSchema.safeParse({ tabId: 1, until: 'settled' }).success).toBe(false);
  });
});
