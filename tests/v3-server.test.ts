import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { registerTools } from '../mcp-server/src/register-tools.js';
import { allTools } from '../mcp-server/src/tools/index.js';
import type { ToolHost } from '../mcp-server/src/tools/types.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Tools that Browser Controller 3.0 removed: none may be listed, described or named in the instructions. */
const REMOVED = [
  'browser_find', 'browser_observe', 'browser_act', 'browser_click_text', 'browser_hover', 'browser_drag',
  'browser_press_key', 'browser_select', 'browser_fill_form', 'browser_upload_file', 'browser_run_action',
  'browser_shortcuts', 'browser_gif', 'browser_resize_window', 'browser_list_browsers', 'browser_select_browser',
  'browser_webmcp_list', 'browser_webmcp_call', 'browser_console', 'browser_network', 'browser_intercept',
  'browser_tools',
];

async function listedTools(): Promise<Array<{ name: string; description?: string; inputSchema: unknown }>> {
  const host: ToolHost = { callTool: async () => ({ success: true, text: 'ok' }) };
  const server = new McpServer({ name: 'v3-test', version: '0.0.0' });
  registerTools(server, host);
  const client = new Client({ name: 'v3-test-client', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const { tools } = await client.listTools();
  await client.close();
  return tools;
}

describe('Browser Controller 3.0 server surface', () => {
  it('tools/list shows exactly the 21 contract tools, in order', async () => {
    const tools = await listedTools();
    expect(tools.map((t) => t.name)).toEqual(allTools.map((t) => t.name));
    expect(tools).toHaveLength(21);
    expect(tools.map((tool) => tool.name)).not.toContain('browser_vault_internal_fill');
    const vault = tools.find((tool) => tool.name === 'browser_vault')!;
    expect(JSON.stringify(vault.inputSchema)).not.toMatch(/password|identifier|grantId|credentialId/);
  });

  it('tools/list fits the token budget (all 21 definitions as the SDK sends them, <= 19 000 chars)', async () => {
    const tools = await listedTools();
    const json = JSON.stringify(tools);
    // chars / 4 is the rough o200k estimate: 19 000 chars is about 4 750 tokens (18 000 before browser_memory, T038).
    expect(json.length, `tools/list is ${json.length} chars (~${Math.round(json.length / 4)} tokens)`).toBeLessThanOrEqual(19_000);
  });

  it('no listed tool description names a removed tool', async () => {
    const tools = await listedTools();
    for (const tool of tools) {
      for (const name of REMOVED) {
        expect(tool.description ?? '', `${tool.name} mentions ${name}`).not.toContain(name);
      }
    }
  });

  it('the server instructions carry the target grammar and the error convention, and name no removed tool', () => {
    const source = fs.readFileSync(path.join(ROOT, 'mcp-server/src/index.ts'), 'utf8');
    const instructions = source.slice(source.indexOf('const SERVER_INSTRUCTIONS'), source.indexOf('const DAEMON_STARTUP_MS'));
    expect(instructions).toContain('text=Sign in');
    expect(instructions).toContain('"CODE: message"');
    expect(instructions).toContain('x,y');
    for (const name of REMOVED) expect(instructions, `instructions mention ${name}`).not.toContain(name);
  });

  it('browser_logs caps limit at 200; browser_mock caps rules at 50 and bodies at 20 000 chars', () => {
    const logs = allTools.find((t) => t.name === 'browser_logs')!;
    expect(logs.inputSchema.safeParse({ tabId: 1, limit: 200 }).success).toBe(true);
    expect(logs.inputSchema.safeParse({ tabId: 1, limit: 201 }).success).toBe(false);
    const mock = allTools.find((t) => t.name === 'browser_mock')!;
    const rule = { match: '*/api/*', body: '{}' };
    expect(mock.inputSchema.safeParse({ tabId: 1, rules: Array(50).fill(rule) }).success).toBe(true);
    expect(mock.inputSchema.safeParse({ tabId: 1, rules: Array(51).fill(rule) }).success).toBe(false);
    expect(mock.inputSchema.safeParse({ tabId: 1, rules: [{ match: 'x', body: 'y'.repeat(20_001) }] }).success).toBe(false);
    expect(mock.inputSchema.safeParse({ tabId: 1, rules: [{ match: 'x', body: 'y'.repeat(20_000) }] }).success).toBe(true);
  });

  it('browser_tabs takes only list, close and focus: the removed actions fail at the schema', () => {
    const tabs = allTools.find((t) => t.name === 'browser_tabs')!;
    for (const action of ['list', 'close', 'focus']) expect(tabs.inputSchema.safeParse({ action, tabId: 1 }).success).toBe(true);
    for (const action of ['create', 'reload', 'lock', 'unlock']) {
      expect(tabs.inputSchema.safeParse({ action, tabId: 1 }).success, `browser_tabs ${action}`).toBe(false);
    }
  });

  it('batch and every element tool list both string and structured targets', async () => {
    const tools = await listedTools();
    for (const tool of tools) {
      const props = (tool.inputSchema as { properties?: Record<string, { type?: string; anyOf?: Array<{ type?: string }> }> }).properties ?? {};
      if (props.target) {
        const variants = props.target.anyOf ?? [props.target];
        expect(variants.some((variant) => variant.type === 'string'), `${tool.name}.target string`).toBe(true);
        expect(variants.some((variant) => variant.type === 'object'), `${tool.name}.target object`).toBe(true);
      }
    }
  });
});
