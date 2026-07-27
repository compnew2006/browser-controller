import { describe, it, expect } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { registerTools } from '../mcp-server/src/register-tools.js';
import { allTools } from '../mcp-server/src/tools/index.js';
import type { ToolHost } from '../mcp-server/src/tools/types.js';

/**
 * Integration tests for the progressive-disclosure registration wiring
 * (register-tools.ts), driven through a REAL McpServer + Client over
 * InMemoryTransport — the same code path index.ts uses, minus the daemon.
 *
 * Covers the two modes:
 *  - fullMode (default): all 22 tools + browser_tools visible immediately.
 *  - progressive (BROWSER_CONTROLLER_PROGRESSIVE=1): only browser_tools
 *    visible; disabled tools reject calls; details activates + notifies.
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
  it('exposes all browser tools + browser_tools immediately', async () => {
    const { client } = await setup(true);
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toHaveLength(allTools.length + 1); // 22 + meta
    expect(names).toContain('browser_tools');
    for (const tool of allTools) expect(names).toContain(tool.name);
  });

  it('tools are callable directly without activation', async () => {
    const { client, host } = await setup(true);
    await client.callTool({ name: 'browser_click', arguments: { tabId: 1, selector: '#btn' } });
    expect(host.calls).toContain('browser_click');
  });

  it('meta tool reports every tool as active', async () => {
    const { client } = await setup(true);
    const result = await client.callTool({ name: 'browser_tools', arguments: { action: 'list' } });
    const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    expect(data.tools.every((t: { active: boolean }) => t.active)).toBe(true);
  });
});

describe('registerTools — progressive mode', () => {
  it('only browser_tools is visible in tools/list', async () => {
    const { client } = await setup(false);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(['browser_tools']);
  });

  it('calling a disabled tool is rejected by the SDK', async () => {
    const { client, host } = await setup(false);
    // The SDK surfaces the McpError as an isError tool result, not a rejection.
    const result = await client.callTool({ name: 'browser_click', arguments: { tabId: 1, selector: '#btn' } });
    expect(result.isError).toBe(true);
    expect((result.content as Array<{ text: string }>)[0].text).toContain('disabled');
    expect(host.calls).toHaveLength(0); // never reached the daemon
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

  it('other tools stay disabled after one activation', async () => {
    const { client, host } = await setup(false);
    await client.callTool({
      name: 'browser_tools',
      arguments: { action: 'details', tool: 'browser_click' },
    });
    const result = await client.callTool({ name: 'browser_type', arguments: { tabId: 1, selector: '#in', text: 'x' } });
    expect(result.isError).toBe(true);
    expect((result.content as Array<{ text: string }>)[0].text).toContain('disabled');
    expect(host.calls).not.toContain('browser_type');
  });
});
