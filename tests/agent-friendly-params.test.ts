import { describe, it, expect } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { registerTools } from '../mcp-server/src/register-tools.js';
import { prepareToolParams } from '../mcp-server/src/tools/params.js';
import { toolMap } from '../mcp-server/src/tools/index.js';
import type { ToolHost } from '../mcp-server/src/tools/types.js';

/**
 * Names an agent brings from other browser tools (Playwright's browser_wait_for text/textGone/time,
 * a screenshot scale) cost a failed call and a retry. browser_wait reads them as their 3.0 form and
 * the screenshot ignores its cosmetic ones, each with a note; any other unknown parameter lists the
 * tool's own parameters, so the first retry is right.
 */
const wait = toolMap.get('browser_wait')!;
const screenshot = toolMap.get('browser_screenshot')!;

function recordingHost() {
  const calls: Array<{ tool: string; params: Record<string, unknown> }> = [];
  const host: ToolHost = {
    async callTool(tool, params) {
      calls.push({ tool, params });
      return { success: true, text: `${tool} done` };
    },
  };
  return { host, calls };
}

async function connect(host: ToolHost) {
  const server = new McpServer({ name: 'test-server', version: '0.0.0' });
  registerTools(server, host);
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

const textOf = (res: unknown) => ((res as { content: Array<{ type: string; text?: string }> }).content)
  .map((c) => (c.type === 'text' ? c.text : '')).join('\n');

describe('browser_wait reads Playwright-style names', () => {
  it('text is a text= target', () => {
    const { params, notes } = prepareToolParams(wait, { tabId: 1, text: 'Orders' });
    expect(params).toEqual({ tabId: 1, target: 'text=Orders' });
    expect(notes).toEqual(['note: text is read as target "text=Orders"']);
  });

  it('textGone is a text= target with gone: true', () => {
    const { params, notes } = prepareToolParams(wait, { tabId: 1, textGone: 'Loading' });
    expect(params).toEqual({ tabId: 1, target: 'text=Loading', gone: true });
    expect(notes).toEqual(['note: textGone is read as target "text=Loading" with gone: true']);
  });

  it('selector is the target', () => {
    const { params } = prepareToolParams(wait, { tabId: 1, selector: '#app' });
    expect(params).toEqual({ tabId: 1, target: '#app' });
  });

  it('time is seconds, read as ms; a delay past the default timeout raises the timeout with it', () => {
    expect(prepareToolParams(wait, { tabId: 1, time: 2 }).params).toEqual({ tabId: 1, ms: 2000 });
    const long = prepareToolParams(wait, { tabId: 1, time: 15 });
    expect(long.params).toEqual({ tabId: 1, ms: 15_000, timeout: 15_000 });
    expect(long.notes).toEqual(['note: time is read as ms: 15000 (seconds to ms)']);
  });

  it('an alias next to the 3.0 name it maps to is still an unknown parameter', () => {
    expect(() => prepareToolParams(wait, { tabId: 1, target: '#a', text: 'x' })).toThrow(/^INVALID_ARGUMENT: unknown parameter text/);
  });
});

describe('browser_screenshot ignores cosmetic options', () => {
  it('scale, format and quality are dropped with one note', () => {
    const { params, notes } = prepareToolParams(screenshot, { tabId: 1, scale: 0.5, format: 'png', quality: 80 });
    expect(params).toEqual({ tabId: 1 });
    expect(notes).toEqual(['note: scale, format, quality ignored: screenshots are JPEG, longest side at most 1568 px']);
  });

  it('fullPage still fails: ignoring it would return something else than asked', () => {
    expect(() => prepareToolParams(screenshot, { tabId: 1, fullPage: true })).toThrow(/unknown parameter fullPage/);
  });
});

describe('an unknown parameter lists the parameters the tool takes', () => {
  it('once per call, after the per-name hints', () => {
    expect(() => prepareToolParams(screenshot, { tabId: 1, fullPage: true, foo: 1 })).toThrow(
      'INVALID_ARGUMENT: unknown parameter fullPage (screenshots cover the viewport, so use region to crop); unknown parameter foo; browser_screenshot takes: tabId, target, region',
    );
  });
});

describe('through the MCP server and a batch', () => {
  it('the call reaches the extension in its 3.0 form and the result carries the note', async () => {
    const { host, calls } = recordingHost();
    const client = await connect(host);
    const res = await client.callTool({ name: 'browser_wait', arguments: { tabId: 4, text: 'Orders' } });
    expect(calls).toEqual([{ tool: 'browser_wait', params: { tabId: 4, target: 'text=Orders' } }]);
    expect(textOf(res)).toBe('browser_wait done\nnote: text is read as target "text=Orders"');
  });

  it('a batch step is read the same way', async () => {
    const { host, calls } = recordingHost();
    const batch = toolMap.get('browser_batch')!;
    const res = await batch.handler(host, batch.inputSchema.parse({
      tabId: 2,
      actions: [{ tool: 'browser_screenshot', params: { scale: 0.5 } }],
    }) as Record<string, unknown>);
    expect(res.isError).toBeFalsy();
    expect(calls).toEqual([{ tool: 'browser_screenshot', params: { tabId: 2 } }]);
    expect(textOf(res)).toContain('step 1/1 browser_screenshot: note: scale ignored: screenshots are JPEG, longest side at most 1568 px');
  });

  it('the note of an earlier step reaches the batch result, which is the last step', async () => {
    const { host } = recordingHost();
    const batch = toolMap.get('browser_batch')!;
    const res = await batch.handler(host, batch.inputSchema.parse({
      tabId: 2,
      actions: [{ tool: 'browser_wait', params: { text: 'Orders' } }, { tool: 'browser_text', params: {} }],
    }) as Record<string, unknown>);
    expect(textOf(res)).toBe('browser_text done\nstep 1/2 browser_wait: note: text is read as target "text=Orders"');
  });
});
