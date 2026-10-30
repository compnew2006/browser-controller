import { describe, expect, it } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { registerTools } from '../../mcp-server/src/register-tools.js';
import { tabsTool } from '../../mcp-server/src/tools/tabs.js';
import { sessionGate } from '../../mcp-server/src/tools/session-mode.js';
import { batchTool } from '../../mcp-server/src/tools/batch.js';
import type { ToolHost, ToolResult } from '../../mcp-server/src/tools/types.js';

/**
 * The session policy: read-only and isolated.
 *
 * Read-only refuses the tools that change something; isolated refuses every
 * tab the session does not own. Both are opt-in: the default policy is a
 * trusted, writable session, because the user's own logged-in tabs are what
 * most work needs.
 */

/** A host that answers the tab list the way the extension does. */
function tabHost(owned: number[] = [], others: number[] = []) {
  const calls: Array<{ tool: string; params: Record<string, unknown> }> = [];
  const host: ToolHost = {
    async callTool(tool, params) {
      calls.push({ tool, params });
      if (tool === 'browser_tabs') {
        return {
          success: true,
          text: [
            ...owned.map((id) => `${id} [own] "own tab" own.test`),
            ...others.map((id) => `${id} [user, focused] "user tab" user.test`),
          ].join('\n'),
          tabs: [
            ...owned.map((tabId) => ({ tabId, role: 'own' })),
            ...others.map((tabId) => ({ tabId, role: 'user' })),
          ],
        };
      }
      if (tool === 'browser_evaluate') return { success: true, text: 'settled' };
      return { success: true, text: 'ok' };
    },
  };
  return { host, calls };
}

const text = (res: ToolResult) => (res.content.find((c) => c.type === 'text') as { text: string }).text;

/** The same path the MCP server uses: register, then call over a transport. */
async function clientFor(host: ToolHost) {
  const server = new McpServer({ name: 'test-server', version: '0.0.0' });
  registerTools(server, host);
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

describe('the session policy is read and set through browser_tabs', () => {
  it('reports the policy it holds, and the one it is given', async () => {
    const { host } = tabHost();
    const current = await tabsTool.handler(host, { action: 'session' });
    expect(text(current)).toBe('session policy: isolation=trusted; access=full');
    const changed = await tabsTool.handler(host, { action: 'session', isolation: 'isolated', access: 'read-only' });
    expect(text(changed)).toBe('session policy: isolation=isolated; access=read-only');
    expect((changed.structuredContent as { session: Record<string, unknown> }).session).toEqual({
      isolation: 'isolated',
      access: 'read-only',
    });
  });

  it('a session with no tabId is not a policy change', async () => {
    const { host } = tabHost();
    await tabsTool.handler(host, { action: 'session', isolation: 'isolated' });
    expect(text(await tabsTool.handler(host, { action: 'session' }))).toBe('session policy: isolation=isolated; access=full');
  });
});

describe('read-only refuses what changes something, and reads as usual', () => {
  it('refuses a click and says how to open a write session', async () => {
    const { host, calls } = tabHost();
    await tabsTool.handler(host, { action: 'session', access: 'read-only' });
    const client = await clientFor(host);
    const result = await client.callTool({ name: 'browser_click', arguments: { tabId: 1, target: '#a' } });
    expect(result.isError).toBe(true);
    expect(text(result as unknown as ToolResult)).toContain('READ_ONLY');
    expect(text(result as unknown as ToolResult)).toContain('browser_tabs {action:"session", access:"full"}');
    // The click never reached the extension.
    expect(calls.filter((call) => call.tool === 'browser_click')).toHaveLength(0);
  });

  it('lets a read through', async () => {
    const { host } = tabHost();
    await tabsTool.handler(host, { action: 'session', access: 'read-only' });
    const client = await clientFor(host);
    const result = await client.callTool({ name: 'browser_text', arguments: { tabId: 1 } });
    expect(result.isError).toBeFalsy();
  });

  it('refuses page code too: it can change anything', async () => {
    const { host } = tabHost();
    await tabsTool.handler(host, { action: 'session', access: 'read-only' });
    const gate = await sessionGate('browser_evaluate', { tabId: 1, expression: '1' }, host);
    expect(gate?.isError).toBe(true);
    expect(text(gate!)).toContain('READ_ONLY');
  });

  it('lets navigation through: opening a page changes no data', async () => {
    const { host } = tabHost();
    await tabsTool.handler(host, { action: 'session', access: 'read-only' });
    expect(await sessionGate('browser_navigate', { url: 'https://x.test/' }, host)).toBeNull();
    expect(await sessionGate('browser_scroll', { tabId: 1, dy: 100 }, host)).toBeNull();
  });
});

describe('an isolated session touches its own tabs only', () => {
  it('refuses a tab the session does not own, and says how to go on', async () => {
    const { host } = tabHost([7], [8]);
    await tabsTool.handler(host, { action: 'session', isolation: 'isolated' });
    const gate = await sessionGate('browser_click', { tabId: 8, target: '#a' }, host);
    expect(gate?.isError).toBe(true);
    expect(text(gate!)).toContain('TAB_NOT_OWNED');
    expect(text(gate!)).toContain('isolation:"trusted"');
  });

  it('lets a tab the session owns through', async () => {
    const { host } = tabHost([7], [8]);
    await tabsTool.handler(host, { action: 'session', isolation: 'isolated' });
    expect(await sessionGate('browser_click', { tabId: 7, target: '#a' }, host)).toBeNull();
  });

  it('a trusted session may act in any tab', async () => {
    const { host } = tabHost([7], [8]);
    expect(await sessionGate('browser_click', { tabId: 8, target: '#a' }, host)).toBeNull();
  });

  it('hides the user\'s tabs from an isolated listing', async () => {
    const { host } = tabHost([7], [8]);
    await tabsTool.handler(host, { action: 'session', isolation: 'isolated' });
    const listed = await tabsTool.handler(host, { action: 'list' });
    const body = text(listed);
    expect(body).toContain('7 [own]');
    expect(body).not.toContain('8 [user, focused]');
    expect(body).toContain('1 tab(s) hidden');
  });

  it('shows every tab in a trusted listing', async () => {
    const { host } = tabHost([7], [8]);
    const listed = await tabsTool.handler(host, { action: 'list' });
    expect(text(listed)).toContain('8 [user, focused]');
  });
});

describe('a batch runs its steps through the same gate', () => {
  it('refuses a writing step of a read-only session', async () => {
    const { host } = tabHost();
    await tabsTool.handler(host, { action: 'session', access: 'read-only' });
    const res = await batchTool.handler(host, batchTool.inputSchema.parse({
      tabId: 1,
      actions: [{ tool: 'browser_click', params: { target: '#a' } }],
    }) as Record<string, unknown>);
    expect(res.isError).toBe(true);
    expect(text(res)).toContain('READ_ONLY');
  });

  it('refuses a foreign tab of an isolated session', async () => {
    const { host } = tabHost([7], [8]);
    await tabsTool.handler(host, { action: 'session', isolation: 'isolated' });
    const res = await batchTool.handler(host, batchTool.inputSchema.parse({
      tabId: 8,
      actions: [{ tool: 'browser_text', params: {} }],
    }) as Record<string, unknown>);
    expect(res.isError).toBe(true);
    expect(text(res)).toContain('TAB_NOT_OWNED');
  });
});
