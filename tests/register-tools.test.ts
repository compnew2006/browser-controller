import { describe, it, expect } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { parseToolParams, registerTools } from '../mcp-server/src/register-tools.js';
import { allTools } from '../mcp-server/src/tools/index.js';
import type { ToolHost } from '../mcp-server/src/tools/types.js';

/**
 * Integration tests for the progressive-disclosure registration wiring
 * (register-tools.ts), driven through a REAL McpServer + Client over
 * InMemoryTransport — the same code path index.ts uses, minus the daemon.
 *
 * Covers the two modes:
 *  - fullMode (default): every browser tool visible immediately; no browser_tools.
 *  - progressive (BROWSER_CONTROLLER_PROGRESSIVE=1): only browser_tools
 *    visible; a call to an inactive tool activates it and runs it; details
 *    activates too; each activation notifies the client.
 */

// Fake daemon host — records calls, returns an empty success payload.
function makeFakeHost(): ToolHost & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async callTool(tool: string) {
      calls.push(tool);
      return { success: true };
    },
  };
}

async function setup(fullMode: boolean) {
  const server = new McpServer({ name: 'test-server', version: '0.0.0' });
  const host = makeFakeHost();
  const registration = registerTools(server, host, fullMode);
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { server, client, host, registration };
}

describe('registerTools — full mode (default)', () => {
  it('exposes every browser tool immediately, and no browser_tools meta tool', async () => {
    const { client } = await setup(true);
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toHaveLength(allTools.length);
    expect(names).not.toContain('browser_tools'); // discovery is progressive-mode only
    for (const tool of allTools) expect(names).toContain(tool.name);
  });

  it('has no browser_tools meta tool to call', async () => {
    const { client } = await setup(true);
    const result = await client.callTool({ name: 'browser_tools', arguments: { action: 'list' } });
    expect(result.isError).toBe(true);
    expect((result.content as Array<{ text: string }>)[0].text).toMatch(/not found/);
  });

  it('tools are callable directly without activation', async () => {
    const { client, host } = await setup(true);
    await client.callTool({ name: 'browser_click', arguments: { tabId: 1, selector: '#btn' } });
    expect(host.calls).toContain('browser_click');
  });

  it('validates the full tool schema before forwarding to the host', async () => {
    const { client, host } = await setup(true);
    const result = await client.callTool({ name: 'browser_click', arguments: { tabId: 1 } });
    expect(result.isError).toBe(true);
    expect((result.content as Array<{ text: string }>)[0].text).toContain('ref or selector');
    expect(host.calls).toHaveLength(0);
  });

  it('validates tool arguments inside the wrapper before reaching the host', async () => {
    const { client, host } = await setup(true);
    const result = await client.callTool({ name: 'browser_click', arguments: { tabId: 'not-a-number', selector: '#btn' } });
    expect(result.isError).toBe(true);
    expect((result.content as Array<{ text: string }>)[0].text).toMatch(/Invalid tool arguments|Expected number|number/i);
    expect(host.calls).toHaveLength(0);
  });

  it('exports the same schema validation helper used by registration', () => {
    expect(parseToolParams(allTools.find((t) => t.name === 'browser_click')!, { tabId: 1, selector: '#btn' })).toEqual({
      tabId: 1,
      selector: '#btn',
      button: 'left',
      doubleClick: false,
    });
    expect(() => parseToolParams(allTools.find((t) => t.name === 'browser_click')!, { tabId: 'bad', selector: '#btn' })).toThrow();
  });

  it('rejects oversized argument payloads before reaching the host', async () => {
    const { client, host } = await setup(true);
    const result = await client.callTool({
      name: 'browser_type',
      arguments: { tabId: 1, selector: '#in', text: 'x'.repeat(1_100_000) },
    });
    expect(result.isError).toBe(true);
    expect((result.content as Array<{ text: string }>)[0].text).toMatch(/exceed|too_big|too large/i);
    expect(host.calls).toHaveLength(0);
  });

  it('meta tool details returns guidance for the requested tool', async () => {
    const { client } = await setup(false); // progressive mode so details also activates
    const result = await client.callTool({ name: 'browser_tools', arguments: { action: 'details', tool: 'browser_click' } });
    const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    expect(typeof data.guidance).toBe('string');
    expect(data.guidance.length).toBeGreaterThan(0);
    expect(data.activated).toBe(true);
  });
});

describe('registerTools — progressive mode', () => {
  it('only browser_tools is visible in tools/list', async () => {
    const { client } = await setup(false);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(['browser_tools']);
  });

  it('a call to an inactive tool activates it, runs it, and notifies the client', async () => {
    // Regression: the SDK used to reject calls to disabled tools ("Tool X disabled"),
    // so the agent had to call browser_tools details first.
    const { client, host } = await setup(false);
    let listChangedCount = 0;
    client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
      listChangedCount++;
    });
    const result = await client.callTool({ name: 'browser_click', arguments: { tabId: 1, selector: '#btn' } });
    expect(result.isError).toBeFalsy();
    expect(host.calls).toContain('browser_click');
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(['browser_click', 'browser_tools']);
    expect(listChangedCount).toBeGreaterThanOrEqual(1);
  });

  it('a call still validates its arguments before reaching the host', async () => {
    const { client, host } = await setup(false);
    const result = await client.callTool({ name: 'browser_click', arguments: { tabId: 1 } });
    expect(result.isError).toBe(true);
    expect((result.content as Array<{ text: string }>)[0].text).toContain('ref or selector');
    expect(host.calls).toHaveLength(0);
  });

  it('browser_tools list is a task→tool preamble + summaries and activation state; guidance comes with search/details', async () => {
    const { client } = await setup(false);
    await client.callTool({ name: 'browser_tools', arguments: { action: 'details', tool: 'browser_hover' } });
    const result = await client.callTool({ name: 'browser_tools', arguments: { action: 'list' } });
    const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    // preamble is the first-read orientation string for a first-time agent
    expect(typeof data.preamble).toBe('string');
    expect(data.preamble.length).toBeGreaterThan(200);
    // the list stays in the agent's context: no per-tool guidance there
    expect(data.tools.every((t: { guidance?: string }) => t.guidance === undefined)).toBe(true);
    // activation state follows the details call
    expect(data.tools.find((t: { name: string }) => t.name === 'browser_hover').active).toBe(true);
    expect(data.tools.find((t: { name: string }) => t.name === 'browser_click').active).toBe(false);
    // the high-value evaluate↔run_action distinction is surfaced once the agent looks for them
    const found = await client.callTool({ name: 'browser_tools', arguments: { action: 'search', query: 'evaluate run_action' } });
    const { matches } = JSON.parse((found.content as Array<{ text: string }>)[0].text);
    expect(matches.every((t: { guidance?: string }) => typeof t.guidance === 'string' && t.guidance.length > 0)).toBe(true);
    const evalG = matches.find((t: { name: string }) => t.name === 'browser_evaluate');
    const runG = matches.find((t: { name: string }) => t.name === 'browser_run_action');
    expect(/CSP|null/i.test(evalG.guidance)).toBe(true);
    expect(/bypasses CSP|CSP/i.test(runG.guidance)).toBe(true);
    // browser_evaluate runs over CDP by default (mcp-server/src/tools/evaluate.ts):
    // the guidance must not send agents away from it as "CSP-restricted".
    expect(evalG.guidance).toMatch(/cdp/i);
    expect(evalG.guidance).not.toMatch(/CSP-RESTRICTED|may return null/i);
    expect(data.preamble).not.toMatch(/browser_evaluate is the CSP-bound|If browser_evaluate returns null/);
  });

  it('lists schemas as the agent sends them: a field with a default is not required', async () => {
    // Regression: tools/list and browser_tools details used zod's output mode, which
    // marked every defaulted field (browser_click's button, doubleClick) as required.
    const { client } = await setup(false);
    await client.callTool({ name: 'browser_tools', arguments: { action: 'details', tool: 'browser_click' } });
    const { tools } = await client.listTools();
    const click = tools.find((t) => t.name === 'browser_click')!;
    expect(click.inputSchema.required ?? []).toContain('tabId');
    expect(click.inputSchema.required ?? []).not.toContain('button');
    expect(click.inputSchema.required ?? []).not.toContain('doubleClick');
  });

  it('details activates the tool: visible, callable, and list_changed sent', async () => {
    const { client, host } = await setup(false);
    let listChangedCount = 0;
    client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
      listChangedCount++;
    });

    await client.callTool({
      name: 'browser_tools',
      arguments: { action: 'details', tool: 'browser_click' },
    });

    // now visible in tools/list…
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain('browser_click');
    expect(names).toHaveLength(2); // browser_tools + browser_click only

    // …and callable
    await client.callTool({ name: 'browser_click', arguments: { tabId: 1, selector: '#btn' } });
    expect(host.calls).toContain('browser_click');

    // …and the client was notified
    expect(listChangedCount).toBeGreaterThanOrEqual(1);
  });

  it('activating the same tool twice does not re-notify', async () => {
    const { client } = await setup(false);
    let listChangedCount = 0;
    client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
      listChangedCount++;
    });
    const activate = () =>
      client.callTool({ name: 'browser_tools', arguments: { action: 'details', tool: 'browser_snapshot' } });
    await activate();
    const after1 = listChangedCount;
    await activate();
    expect(listChangedCount).toBe(after1); // second activation is a no-op
  });

  it('activation is per tool: other tools stay hidden until they are called or activated', async () => {
    const { client, host } = await setup(false);
    await client.callTool({
      name: 'browser_tools',
      arguments: { action: 'details', tool: 'browser_click' },
    });
    const before = await client.listTools();
    expect(before.tools.map((t) => t.name)).not.toContain('browser_type');
    const result = await client.callTool({ name: 'browser_type', arguments: { tabId: 1, selector: '#in', text: 'x' } });
    expect(result.isError).toBeFalsy();
    expect(host.calls).toContain('browser_type');
    const after = await client.listTools();
    expect(after.tools.map((t) => t.name)).toContain('browser_type');
  });
});
