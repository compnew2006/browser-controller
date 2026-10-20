import { describe, it, expect } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { parseToolParams, registerTools } from '../mcp-server/src/register-tools.js';
import { allTools } from '../mcp-server/src/tools/index.js';
import type { ToolHost } from '../mcp-server/src/tools/types.js';

/**
 * Tool registration (register-tools.ts) driven through a REAL McpServer +
 * Client over InMemoryTransport — the same code path index.ts uses, minus the
 * daemon.
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

async function setup() {
  const server = new McpServer({ name: 'test-server', version: '0.0.0' });
  const host = makeFakeHost();
  registerTools(server, host);
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { server, client, host };
}

describe('registerTools', () => {
  it('exposes every browser tool', async () => {
    const { client } = await setup();
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toHaveLength(allTools.length);
    for (const tool of allTools) expect(names).toContain(tool.name);
  });

  it('tools are callable directly', async () => {
    const { client, host } = await setup();
    await client.callTool({ name: 'browser_click', arguments: { tabId: 1, selector: '#btn' } });
    expect(host.calls).toContain('browser_click');
  });

  it('validates the full tool schema before forwarding to the host', async () => {
    const { client, host } = await setup();
    const result = await client.callTool({ name: 'browser_click', arguments: { tabId: 1 } });
    expect(result.isError).toBe(true);
    expect((result.content as Array<{ text: string }>)[0].text).toContain('ref, selector or text');
    expect(host.calls).toHaveLength(0);
  });

  it('validates tool arguments inside the wrapper before reaching the host', async () => {
    const { client, host } = await setup();
    const result = await client.callTool({ name: 'browser_click', arguments: { tabId: 'not-a-number', selector: '#btn' } });
    expect(result.isError).toBe(true);
    expect((result.content as Array<{ text: string }>)[0].text).toMatch(/Invalid tool arguments|Expected number|number/i);
    expect(host.calls).toHaveLength(0);
  });

  it('exports the same schema validation helper used by registration', () => {
    expect(parseToolParams(allTools.find((t) => t.name === 'browser_click')!, { tabId: 1, selector: '#btn' })).toMatchObject({
      tabId: 1,
      selector: '#btn',
    });
    expect(() => parseToolParams(allTools.find((t) => t.name === 'browser_click')!, { tabId: 'bad', selector: '#btn' })).toThrow();
  });

  it('rejects oversized argument payloads before reaching the host', async () => {
    const { client, host } = await setup();
    const result = await client.callTool({
      name: 'browser_type',
      arguments: { tabId: 1, selector: '#in', text: 'x'.repeat(1_100_000) },
    });
    expect(result.isError).toBe(true);
    expect((result.content as Array<{ text: string }>)[0].text).toMatch(/exceed|too_big|too large/i);
    expect(host.calls).toHaveLength(0);
  });
});
