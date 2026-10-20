import { describe, expect, it } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { registerTools } from '../mcp-server/src/register-tools.js';
import type { ToolHost } from '../mcp-server/src/tools/types.js';

/**
 * browser_screenshot on the wire: the agent gets the picture plus its one text
 * line (the extension's `text`), and a failed capture is isError with CODE: message.
 */
async function clientWith(host: ToolHost) {
  const server = new McpServer({ name: 'test-server', version: '0.0.0' });
  registerTools(server, host);
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

describe('browser_screenshot on the wire', () => {
  it('sends the image and its one text line, nothing else', async () => {
    const client = await clientWith({
      callTool: async () => ({
        success: true,
        text: '1280x800 jpeg, viewport',
        image: { data: 'AAAA', mimeType: 'image/jpeg' },
      }),
    });
    const result = await client.callTool({ name: 'browser_screenshot', arguments: { tabId: 1 } });
    expect(result.isError).toBeFalsy();
    expect(result.content).toEqual([
      { type: 'image', data: 'AAAA', mimeType: 'image/jpeg' },
      { type: 'text', text: '1280x800 jpeg, viewport' },
    ]);
  });

  it('a failed capture is an isError result whose text is the CODE: message string', async () => {
    const client = await clientWith({
      callTool: async () => ({ success: false, error: 'NOT_FOUND: no element for e9' }),
    });
    const result = await client.callTool({ name: 'browser_screenshot', arguments: { tabId: 1, target: 'e9' } });
    expect(result.isError).toBe(true);
    expect(result.content).toEqual([{ type: 'text', text: 'NOT_FOUND: no element for e9' }]);
  });
});
