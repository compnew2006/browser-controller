import { describe, expect, it } from 'vitest';
import { clickTool } from '../../mcp-server/src/tools/click.js';
import { navigateTool } from '../../mcp-server/src/tools/navigate.js';
import type { ToolHost, ToolResult } from '../../mcp-server/src/tools/types.js';

/**
 * The page settles before a call returns, and an expectation is polled rather
 * than read once: both keep a read after an action from seeing the state
 * before it.
 */

interface Setup {
  /** The page text each snapshot returns, in order; the last one repeats. */
  pages?: string[];
  /** The page text the settle probe reads; null: the probe fails. */
  probe?: 'ok' | 'fail';
  /** The page cannot be read at all. */
  snapshotFails?: boolean;
  /** The action's own outcome. */
  action?: { success: boolean; error?: string };
}

function setup(opts: Setup = {}) {
  const calls: Array<{ tool: string; params: Record<string, unknown> }> = [];
  const pages = [...(opts.pages ?? ['page text'])];
  let snapshots = 0;
  const host: ToolHost = {
    async callTool(tool, params) {
      calls.push({ tool, params });
      if (tool === 'browser_evaluate') {
        if (opts.probe === 'fail') return { success: false, error: 'SCRIPT_ERROR: blocked by CSP' };
        return { success: true, text: 'settled' };
      }
      if (tool === 'browser_snapshot') {
        if (opts.snapshotFails) return { success: false, error: 'TAB_GONE: the tab is gone' };
        const text = pages[Math.min(snapshots, pages.length - 1)];
        snapshots += 1;
        return { success: true, text, url: 'https://example.test/page' };
      }
      return opts.action ?? { success: true, text: 'clicked' };
    },
  };
  return { host, calls };
}

const text = (res: ToolResult) => (res.content.find((c) => c.type === 'text') as { text: string }).text;
const isProbe = (call: { tool: string; params: Record<string, unknown> }) =>
  call.tool === 'browser_evaluate' && typeof call.params.expression === 'string' && call.params.expression.includes('innerText');

describe('a page that changes in place settles before the call returns', () => {
  it('waits for the page after the action, before anything reads it', async () => {
    const { host, calls } = setup();
    await clickTool.handler(host, { tabId: 1, target: 'e1', expect: { textIncludes: 'page text' } });
    const order = calls.map((call) => (isProbe(call) ? 'probe' : call.tool));
    expect(order.indexOf('probe')).toBeGreaterThan(order.indexOf('browser_click'));
    expect(order.indexOf('probe')).toBeLessThan(order.indexOf('browser_snapshot'));
  });

  it('does not fail the action when the page cannot run the probe', async () => {
    const { host } = setup({ probe: 'fail' });
    const res = await clickTool.handler(host, { tabId: 1, target: 'e1' });
    expect(res.isError).toBeFalsy();
  });
});

describe('an expectation is polled, not read once', () => {
  it('passes when the page meets it a moment later', async () => {
    const { host } = setup({ pages: ['old text', 'new text'] });
    const res = await clickTool.handler(host, { tabId: 1, target: 'e1', expect: { textIncludes: 'new text' } });
    expect(res.isError).toBeFalsy();
    const receipt = res.structuredContent as { receipt: { expect?: { passed: boolean; waitedMs?: number } } };
    expect(receipt.receipt.expect?.passed).toBe(true);
    expect(receipt.receipt.expect?.waitedMs).toBeGreaterThan(0);
  });

  it('fails after the wait, and says how long it waited', async () => {
    const { host } = setup({ pages: ['old text'] });
    const res = await clickTool.handler(host, { tabId: 1, target: 'e1', expect: { textIncludes: 'never appears' } });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain('EXPECTATION_FAILED');
    expect(text(res)).toMatch(/after waiting \d+ ms/);
    const receipt = res.structuredContent as { receipt: { expect?: { passed: boolean; waitedMs?: number } } };
    expect(receipt.receipt.expect?.passed).toBe(false);
    expect(receipt.receipt.expect?.waitedMs).toBeGreaterThan(0);
  });

  it('reports an expectation that could not be checked as unavailable, not as a mismatch', async () => {
    const { host } = setup({ snapshotFails: true });
    const res = await clickTool.handler(host, { tabId: 1, target: 'e1', expect: { textIncludes: 'anything' } });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain('EXPECTATION_UNAVAILABLE');
    expect(text(res)).not.toContain('EXPECTATION_FAILED');
  });
});

describe('a refusal says how to go on', () => {
  it('a hidden element carries the way out', async () => {
    const { host } = setup({ action: { success: false, error: 'ELEMENT_HIDDEN: #toggle matches only hidden elements' } });
    const res = await clickTool.handler(host, { tabId: 1, target: '#toggle' });
    expect(text(res)).toContain('ELEMENT_HIDDEN');
    expect(text(res)).toContain('browser_evaluate');
  });
});

describe('a navigation returns once the page has drawn', () => {
  it('waits for the page after the navigation, before anything reads it', async () => {
    const calls: Array<{ tool: string; params: Record<string, unknown> }> = [];
    const host: ToolHost = {
      async callTool(tool, params) {
        calls.push({ tool, params });
        if (tool === 'browser_evaluate') return { success: true, text: 'drawn' };
        return { success: true, text: 'tabId: 42', tabId: 42 };
      },
    };
    const res = await navigateTool.handler(host, { url: 'https://example.test/' });
    expect(res.isError).toBeFalsy();
    const order = calls.map((call) => (isProbe(call) ? 'probe' : call.tool));
    expect(order).toEqual(['browser_navigate', 'probe']);
  });

  it('a navigation that failed does not wait for a page that never came', async () => {
    const calls: Array<{ tool: string; params: Record<string, unknown> }> = [];
    const host: ToolHost = {
      async callTool(tool, params) {
        calls.push({ tool, params });
        return { success: false, error: 'NAVIGATION_FAILED: net::ERR_NAME_NOT_RESOLVED' };
      },
    };
    const res = await navigateTool.handler(host, { url: 'https://nope.test/' });
    expect(res.isError).toBe(true);
    expect(calls.map((call) => call.tool)).toEqual(['browser_navigate']);
  });
});
