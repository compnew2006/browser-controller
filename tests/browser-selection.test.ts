import { describe, expect, it, vi } from 'vitest';
import { connectedBrowsers, explainNoWindow } from '../mcp-server/src/tools/browser-selection.js';
import { tabsTool } from '../mcp-server/src/tools/tabs.js';

describe('browser profile diagnostics', () => {
  it('reports profiles with open tabs through one non-selecting profiles request', async () => {
    const callTool = vi.fn(async (_tool: string, _params: Record<string, unknown>) => ({
      success: true,
      browsers: [
        { browserId: 'work', label: 'Treelancer', hasOpenTabs: true },
        { browserId: 'home', label: 'Home', hasOpenTabs: false },
      ],
    }));
    const host = { callTool };

    const result = await explainNoWindow(host, 'No current window');

    expect(callTool).toHaveBeenCalledTimes(1);
    expect(callTool).toHaveBeenCalledWith('browser_tabs', { action: 'profiles' });
    expect(result).toContain('Connected profiles with open tabs: work "Treelancer"');
    expect(result).not.toContain('Home');
  });

  it('uses the legacy tab list without selecting or probing another profile', async () => {
    const callTool = vi.fn(async (_tool: string, params: Record<string, unknown>) => {
      if (params.action === 'profiles') throw new Error('unknown action');
      return { success: true, text: 'browser work "Work" (default, selected)\n\ntab list' };
    });
    const host = { callTool };

    const browsers = await connectedBrowsers(host);

    expect(browsers).toEqual([{ id: 'work', label: 'Work', hasOpenTabs: null }]);
    expect(callTool.mock.calls.map(([, params]) => params)).toEqual([{ action: 'profiles' }, { action: 'list' }]);
  });

  it('publishes profile metadata as structured content and rejects a selector on profiles', async () => {
    const browsers = [{ browserId: 'work', label: 'Treelancer', default: true, selected: true, hasOpenTabs: true }];
    const host = { callTool: vi.fn(async () => ({ success: true, text: 'browser work "Treelancer" · open tabs: yes', browsers })) };

    const result = await tabsTool.handler(host, { action: 'profiles' });

    expect(result.structuredContent).toEqual({
      success: true,
      browsers,
      defaultBrowserId: null,
      selectedBrowserId: null,
    });
    expect(tabsTool.inputSchema.safeParse({ action: 'profiles', browser: 'work' }).success).toBe(false);
  });
});
