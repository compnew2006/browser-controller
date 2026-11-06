import { describe, expect, it } from 'vitest';
import { clickTool } from '../mcp-server/src/tools/click.js';
import { setSafetySettings } from '../mcp-server/src/tools/action-support.js';
import type { ToolHost } from '../mcp-server/src/tools/types.js';

type Visibility = 'absent' | 'visible' | 'unknown';
function hostFor(before: Visibility, after: Visibility, options: { blocked?: boolean; actionFails?: boolean } = {}) {
  let dispatched = false;
  const calls: string[] = [];
  const host: ToolHost = {
    async callTool(tool, params) {
      calls.push(tool);
      if (tool === 'browser_classify_action') return { success: true, site: 'example.test', categories: ['submit'] };
      if (tool === 'browser_wait') {
        const state = dispatched ? after : before;
        if ((state === 'absent' && params.gone === true) || (state === 'visible' && params.gone === false)) return { success: true, text: 'secret dialog contents' };
        throw new Error('sensitive browser error');
      }
      if (tool === 'browser_evaluate') return { success: true, text: 'settled' };
      if (tool === 'browser_snapshot') return { success: true, text: 'expected', url: 'https://example.test/' };
      if (tool === 'browser_click') {
        dispatched = true;
        return options.actionFails ? { success: false, error: 'CLICK_MISSED: missed' } : { success: true, text: 'clicked' };
      }
      throw new Error('unexpected call');
    },
  };
  if (options.blocked) setSafetySettings(host, { enabled: true, defaultAction: 'block', siteRules: [] });
  return { host, calls };
}

describe('explicit application rejection indicator', () => {
  it('flags only a newly visible indicator and warns against repeating the dispatched action', async () => {
    const { host, calls } = hostFor('absent', 'visible');
    const params = clickTool.inputSchema.parse({ tabId: 1, target: '#go', rejectTarget: '#error' });
    const result = await clickTool.handler(host, params);
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain('APPLICATION_REJECTED');
    expect(result.structuredContent).toMatchObject({ success: false, receipt: { status: 'application_rejected', applicationRejection: { status: 'observed' } } });
    expect(JSON.stringify(result)).toContain('check the page before retrying');
    expect(JSON.stringify(result)).not.toContain('secret dialog contents');
    expect(JSON.stringify(result)).not.toContain('sensitive browser error');
    expect(calls.filter((tool) => tool === 'browser_click')).toHaveLength(1);
  });

  it('does not attribute a pre-existing indicator to the click', async () => {
    const { host } = hostFor('visible', 'visible');
    const result = await clickTool.handler(host, { tabId: 1, target: '#go', rejectTarget: '#error' });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ receipt: { status: 'completed', applicationRejection: { status: 'preexisting' } } });
  });

  it('reports unavailable observations without claiming a rejection or repeating the click', async () => {
    const { host, calls } = hostFor('unknown', 'unknown');
    const result = await clickTool.handler(host, { tabId: 1, target: '#go', rejectTarget: '#error' });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ receipt: { applicationRejection: { status: 'unavailable' } } });
    expect(calls.filter((tool) => tool === 'browser_click')).toHaveLength(1);
  });

  it('leaves expectations intact when the indicator is absent', async () => {
    const { host } = hostFor('absent', 'absent');
    const result = await clickTool.handler(host, { tabId: 1, target: '#go', rejectTarget: '#error', expect: { textIncludes: 'expected' } });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ receipt: { expect: { passed: true }, applicationRejection: { status: 'not_observed' } } });
  });

  it('does not probe the indicator or dispatch an action when the safety policy blocks it', async () => {
    const { host, calls } = hostFor('absent', 'visible', { blocked: true });
    const result = await clickTool.handler(host, { tabId: 1, target: '#go', rejectTarget: '#error' });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ receipt: { status: 'not_dispatched' } });
    expect(calls).not.toContain('browser_wait');
    expect(calls).not.toContain('browser_click');
  });

  it('reports unavailable when the click itself fails', async () => {
    const { host, calls } = hostFor('absent', 'visible', { actionFails: true });
    const result = await clickTool.handler(host, { tabId: 1, target: '#go', rejectTarget: '#error' });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ receipt: { status: 'error', applicationRejection: { status: 'unavailable' } } });
    expect(calls.filter((tool) => tool === 'browser_click')).toHaveLength(1);
  });
});
