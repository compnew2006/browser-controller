import { describe, it, expect } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
import { parseToolParams, registerTools } from '../mcp-server/src/register-tools.js';
import { allTools } from '../mcp-server/src/tools/index.js';
import type { ToolDefinition, ToolHost } from '../mcp-server/src/tools/types.js';

/**
 * Registration wiring (register-tools.ts), driven through a REAL McpServer +
 * Client over InMemoryTransport: the same code path index.ts uses, minus the
 * daemon. Every tool is listed and callable at once; a call is validated before
 * it reaches the host.
 */

// Fake daemon host: records calls, answers with an empty success payload.
function makeFakeHost(): ToolHost & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async callTool(tool: string) {
      calls.push(tool);
      return { success: true, text: 'ok' };
    },
  };
}

async function setup(host: ToolHost = makeFakeHost()) {
  const server = new McpServer({ name: 'test-server', version: '0.0.0' });
  registerTools(server, host);
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { server, client, host };
}

const textOf = (result: { content: unknown }) =>
  ((result.content as Array<{ type: string; text?: string }>).find((c) => c.type === 'text') as { text: string }).text;

describe('registerTools', () => {
  it('lists every tool, in contract order, and no meta tool', async () => {
    const { client } = await setup();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(allTools.map((t) => t.name));
    expect(tools).toHaveLength(22);
    expect(tools.map((t) => t.name)).not.toContain('browser_tools');
  });

  it('tools are callable directly', async () => {
    const host = makeFakeHost();
    const { client } = await setup(host);
    const result = await client.callTool({ name: 'browser_click', arguments: { tabId: 1, target: '#btn' } });
    expect(result.isError).toBeFalsy();
    expect(host.calls).toEqual(['browser_click']);
  });

  it('validates the schema before forwarding (click needs a target)', async () => {
    const host = makeFakeHost();
    const { client } = await setup(host);
    const result = await client.callTool({ name: 'browser_click', arguments: { tabId: 1 } });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('target');
    expect(host.calls).toHaveLength(0);
  });

  it('rejects a tabId that is not a number before it reaches the host', async () => {
    const host = makeFakeHost();
    const { client } = await setup(host);
    const result = await client.callTool({ name: 'browser_click', arguments: { tabId: 'not-a-number', target: '#btn' } });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/Invalid tool arguments|Expected number|number/i);
    expect(host.calls).toHaveLength(0);
  });

  it('exports the same schema validation helper used by registration', () => {
    const click = allTools.find((t) => t.name === 'browser_click')!;
    expect(parseToolParams(click, { tabId: 1, target: '#btn' })).toEqual({ tabId: 1, target: '#btn' });
    expect(() => parseToolParams(click, { tabId: 'bad', target: '#btn' })).toThrow();
  });

  it('rejects oversized argument payloads before reaching the host', async () => {
    const host = makeFakeHost();
    const { client } = await setup(host);
    const result = await client.callTool({
      name: 'browser_type',
      arguments: { tabId: 1, target: '#in', text: 'x'.repeat(1_100_000) },
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/exceed|too_big|too large/i);
    expect(host.calls).toHaveLength(0);
  });

  it('a failure reaches the client as isError with the CODE: message text', async () => {
    const host: ToolHost = {
      async callTool() {
        throw Object.assign(new Error('TAB_LOCKED: tab 3 belongs to another session'), {
          result: { success: false, error: 'TAB_LOCKED: tab 3 belongs to another session' },
        });
      },
    };
    const { client } = await setup(host);
    const result = await client.callTool({ name: 'browser_text', arguments: { tabId: 3 } });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe('TAB_LOCKED: tab 3 belongs to another session');
  });

  it('a missing required parameter is INVALID_ARGUMENT: field is required (the SDK text never reaches the agent)', async () => {
    const host = makeFakeHost();
    const { client } = await setup(host);
    const result = await client.callTool({ name: 'browser_click', arguments: { tabId: 1 } });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe('INVALID_ARGUMENT: target is required');
    expect(host.calls).toHaveLength(0);
  });

  it('a missing tabId says how to get one', async () => {
    const { client } = await setup();
    const result = await client.callTool({ name: 'browser_text', arguments: {} });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe('INVALID_ARGUMENT: tabId is required. Call browser_tabs {action:"list"} first.');
  });

  it('a wrong type names the field and the reason, without a JSON dump', async () => {
    const { client } = await setup();
    const result = await client.callTool({ name: 'browser_click', arguments: { tabId: 'x', target: '#a' } });
    expect(textOf(result)).toBe('INVALID_ARGUMENT: tabId: expected number, received string');
  });

  it('an unknown tool is INVALID_ARGUMENT and never reaches the host', async () => {
    const host = makeFakeHost();
    const { client } = await setup(host);
    const result = await client.callTool({ name: 'browser_nope', arguments: {} });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe('INVALID_ARGUMENT: unknown tool browser_nope');
    expect(host.calls).toHaveLength(0);
  });

  it('a host error without a code is INTERNAL_ERROR: its message', async () => {
    const host: ToolHost = { async callTool() { throw new Error('boom'); } };
    const { client } = await setup(host);
    const result = await client.callTool({ name: 'browser_text', arguments: { tabId: 3 } });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe('INTERNAL_ERROR: boom');
  });

  it('an extension failure without a code is coded INTERNAL_ERROR; one with a code is kept', async () => {
    const plain: ToolHost = { async callTool() { return { success: false, error: 'plain failure' }; } };
    const { client } = await setup(plain);
    expect(textOf(await client.callTool({ name: 'browser_text', arguments: { tabId: 3 } }))).toBe('INTERNAL_ERROR: plain failure');
    const coded: ToolHost = { async callTool() { return { success: false, error: 'NOT_FOUND: no element' }; } };
    const second = await setup(coded);
    expect(textOf(await second.client.callTool({ name: 'browser_text', arguments: { tabId: 3 } }))).toBe('NOT_FOUND: no element');
  });

  it('parseToolParams: an unknown key is INVALID_ARGUMENT: unknown parameter, with the 3.0 name for a 2.x one', () => {
    const strictTool = { name: 'browser_x', inputSchema: z.object({ tabId: z.number(), target: z.string() }).strict() } as unknown as ToolDefinition;
    expect(() => parseToolParams(strictTool, { tabId: 1, target: 'x', fullPage: true })).toThrow('INVALID_ARGUMENT: unknown parameter fullPage');
    expect(() => parseToolParams(strictTool, { tabId: 1, target: 'x', ref: 'e1' })).toThrow('INVALID_ARGUMENT: unknown parameter ref (use target with the ref from browser_snapshot)');
  });

  it('the thin client says NOT_CONNECTED when the daemon link is down (index.ts cannot be imported: its main() runs)', () => {
    const source = fs.readFileSync(path.join(ROOT, 'mcp-server/src/index.ts'), 'utf8');
    expect(source).toContain("reject(new Error('NOT_CONNECTED: Not connected to daemon'));");
    expect(source).toContain("this.failAll('NOT_CONNECTED: daemon connection closed');");
  });

  it('tools/list advertises the strict schemas: no extra parameter is listed as allowed', async () => {
    const { client } = await setup();
    const { tools } = await client.listTools();
    const click = tools.find((t) => t.name === 'browser_click')!;
    expect(click.inputSchema.additionalProperties).toBe(false);
  });

  it('only the target-less fields of a tool are optional in its schema (click button is optional)', async () => {
    const { client } = await setup();
    const { tools } = await client.listTools();
    const click = tools.find((t) => t.name === 'browser_click')!;
    expect(click.inputSchema.required ?? []).toEqual(expect.arrayContaining(['tabId', 'target']));
    expect(click.inputSchema.required ?? []).not.toContain('button');
  });
});
