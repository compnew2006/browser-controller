import { describe, expect, it } from 'vitest';
import { clickTool } from '../mcp-server/src/tools/click.js';
import type { ToolHost } from '../mcp-server/src/tools/types.js';

describe('opt-in click timings', () => {
  it('forwards only finite numeric phase data and excludes page-supplied text', async () => {
    const host: ToolHost = {
      async callTool(tool) {
        if (tool === 'browser_evaluate') return { success: true, text: 'settled' };
        return { success: true, text: 'clicked', timings: { connection_state: 2, connection_ms: 3, input_dispatch_ms: 5, target_resolution_ms: NaN, unexpected: 'secret' } };
      },
    };
    const params = clickTool.inputSchema.parse({ tabId: 1, target: '#button', timings: true });
    const result = await clickTool.handler(host, params);
    expect(result.structuredContent).toMatchObject({ receipt: { timings: { connection_state: 2, connection_ms: 3, input_dispatch_ms: 5 } } });
    expect(JSON.stringify(result)).not.toContain('secret');
    expect(JSON.stringify(result)).not.toContain('target_resolution_ms');
  });

  it('does not expose timing metadata unless explicitly requested', async () => {
    const host: ToolHost = { async callTool(tool) { return tool === 'browser_evaluate' ? { success: true, text: 'settled' } : { success: true, text: 'clicked', timings: { connection_ms: 1 } }; } };
    const result = await clickTool.handler(host, { tabId: 1, target: '#button' });
    expect(result.structuredContent).not.toHaveProperty('receipt.timings');
  });
});
