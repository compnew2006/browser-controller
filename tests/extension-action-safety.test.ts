import { beforeEach, describe, expect, it, vi } from 'vitest';

const execDom = vi.fn();
vi.mock('../extension/lib/page-exec.js', () => ({
  resolveTab: async (tabId: number) => ({ id: tabId, url: 'https://Example.com/path' }),
  execDom: (...args: unknown[]) => execDom(...args),
  getFallback: () => null,
}));

const { handleClassifyAction } = await import('../extension/handlers/action-safety.js');

describe('browser_classify_action: browser_evaluate', () => {
  beforeEach(() => execDom.mockReset());

  it('returns the site with no categories and never probes the page', async () => {
    const res = await handleClassifyAction({ tabId: 3, action: 'browser_evaluate' });
    expect(res).toEqual({ success: true, site: 'example.com', categories: [], fingerprints: [] });
    expect(execDom).not.toHaveBeenCalled();
  });

  it('ignores a target: still no page probe', async () => {
    const res = await handleClassifyAction({ tabId: 3, action: 'browser_evaluate', target: 'e1' });
    expect(res).toMatchObject({ categories: [], fingerprints: [] });
    expect(execDom).not.toHaveBeenCalled();
  });

  it('still rejects an unknown action', async () => {
    await expect(handleClassifyAction({ tabId: 3, action: 'browser_nope' })).rejects.toThrow(/INVALID_ARGUMENT/);
  });
});
