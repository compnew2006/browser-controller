import { describe, it, expect } from 'vitest';
import { forwardHandler } from '../../mcp-server/src/tools/types.js';
import type { ToolHost } from '../../mcp-server/src/tools/types.js';

/**
 * forwardHandler (architecture: unified error channel + DRY audit item #1).
 *
 * Previously every tool file repeated the identical passthrough body and
 * in-band failures ({success:false,...} from the extension) reached the agent
 * as success-shaped JSON text. The factory forwards, and when the bridge
 * rejects with an attached payload (the extension's in-band failure result),
 * returns it as an isError result — uniform failure detection AND the payload
 * (e.g. REF_GONE freshRefs) survive to the agent.
 */

function hostWith(impl: (tool: string, params: Record<string, unknown>) => Promise<unknown>): ToolHost {
  return { callTool: impl };
}

describe('forwardHandler', () => {
  it('returns the tool result as JSON text on success', async () => {
    const handler = forwardHandler('browser_click');
    const host = hostWith(async () => ({ success: true, clicked: true }));
    const result = await handler(host, { ref: 'e1' });
    expect(result.isError).toBeUndefined();
    expect(JSON.parse((result.content[0] as { text: string }).text)).toEqual({ success: true, clicked: true });
  });

  it('converts a payload-carrying rejection into an isError result with the full body', async () => {
    const handler = forwardHandler('browser_click');
    const host = hostWith(async () => {
      const err = new Error('Element e5 is gone from the DOM');
      (err as Error & { result?: unknown }).result = {
        success: false,
        error: 'Element e5 is gone',
        freshRefs: [{ ref: 'x1', role: 'button' }],
      };
      throw err;
    });
    const result = await handler(host, { ref: 'e5' });
    expect(result.isError).toBe(true);
    const body = JSON.parse((result.content[0] as { text: string }).text);
    expect(body.freshRefs).toEqual([{ ref: 'x1', role: 'button' }]);
    expect(body.error).toContain('gone');
  });

  it('re-throws rejections without a payload (transport errors keep their message)', async () => {
    const handler = forwardHandler('browser_click');
    const host = hostWith(async () => {
      throw new Error('Chrome extension not connected');
    });
    await expect(handler(host, {})).rejects.toThrow('Chrome extension not connected');
  });

  it('tags the returned handler with its wire name (registry drift guard)', async () => {
    const handler = forwardHandler('browser_click');
    expect((handler as { toolName?: string }).toolName).toBe('browser_click');
  });
});
