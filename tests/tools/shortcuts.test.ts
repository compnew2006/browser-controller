import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-shortcuts-'));
process.env.BC_SHORTCUTS_FILE = path.join(dir, 'shortcuts.json');
const { shortcutsTool, substitute, variablesOf } = await import('../../mcp-server/src/tools/shortcuts.js');

const calls: Array<{ tool: string; params: Record<string, unknown> }> = [];
const host = {
  callTool: async (tool: string, params: Record<string, unknown>) => {
    calls.push({ tool, params });
    return { success: true, tool };
  },
};
const run = (params: Record<string, unknown>) => shortcutsTool.handler(host, params);
const body = (r: { content: Array<{ type: string; text?: string }> }) => JSON.parse(r.content.find((c) => c.type === 'text')!.text!);

describe('browser_shortcuts', () => {
  beforeEach(() => { calls.length = 0; fs.rmSync(process.env.BC_SHORTCUTS_FILE!, { force: true }); });
  afterEach(() => { calls.length = 0; });

  it('finds and substitutes {{variables}}, keeping the value type for whole-string placeholders', () => {
    const actions = [{ tool: 'browser_type', params: { selector: '#q', text: 'find {{term}} now' } }, { tool: 'browser_wait', params: { delay: '{{ms}}' } }];
    expect(variablesOf(actions)).toEqual(['ms', 'term']);
    expect(substitute(actions, { term: 'webgpu', ms: 500 })).toEqual([
      { tool: 'browser_type', params: { selector: '#q', text: 'find webgpu now' } },
      { tool: 'browser_wait', params: { delay: 500 } },
    ]);
  });

  it('save → list → show → run (as a batch, with vars and a default tab) → delete', async () => {
    const saved = body(await run({
      action: 'save', name: 'search-docs', description: 'Search the docs',
      actions: [
        { tool: 'browser_click', params: { selector: 'input[name=q]' } },
        { tool: 'browser_type', params: { selector: 'input[name=q]', text: '{{term}}' } },
        { tool: 'browser_press_key', params: { key: 'Enter' } },
      ],
    }));
    expect(saved.saved).toMatchObject({ name: 'search-docs', steps: 3, variables: ['term'] });
    expect(body(await run({ action: 'list' })).shortcuts).toHaveLength(1);
    expect(body(await run({ action: 'show', name: 'search-docs' })).shortcut.description).toBe('Search the docs');

    const missing = await run({ action: 'run', name: 'search-docs', tabId: 9 });
    expect(missing.isError).toBe(true);
    expect(body(missing).error).toMatch(/Missing vars: term/);

    const res = await run({ action: 'run', name: 'search-docs', tabId: 9, vars: { term: 'sys.monitoring' } });
    expect(res.isError).toBeFalsy();
    expect(calls.map((c) => c.tool)).toEqual(['browser_click', 'browser_type', 'browser_press_key']);
    expect(calls[1]!.params).toMatchObject({ tabId: 9, text: 'sys.monitoring' });

    expect(body(await run({ action: 'delete', name: 'search-docs' })).deleted).toBe('search-docs');
    expect(body(await run({ action: 'list' })).shortcuts).toHaveLength(0);
  });

  it('rejects nesting and bad names', async () => {
    expect((await run({ action: 'save', name: 'x', actions: [{ tool: 'browser_batch', params: {} }] })).isError).toBe(true);
    expect((await run({ action: 'save', name: 'bad name!', actions: [{ tool: 'browser_click' }] })).isError).toBe(true);
  });

  it('refuses to save a standing WebMCP approval, but a {{confirm}} placeholder is decided per run', async () => {
    const saved = await run({ action: 'save', name: 'order', actions: [{ tool: 'browser_webmcp_call', params: { tabId: 1, name: 'place_order', confirm: true } }] });
    expect(saved.isError).toBe(true);
    expect(body(saved).error).toMatch(/cannot save confirm:true/);

    const ok = await run({ action: 'save', name: 'order', actions: [{ tool: 'browser_webmcp_call', params: { tabId: 1, name: 'place_order', confirm: '{{confirm}}' } }] });
    expect(ok.isError).toBeFalsy();
    expect(body(ok).saved.variables).toEqual(['confirm']);
    await run({ action: 'run', name: 'order', vars: { confirm: true } });
    expect(calls.at(-1)).toMatchObject({ tool: 'browser_webmcp_call', params: { confirm: true } });
  });

  it('refuses a templated tool name that resolves to browser_webmcp_call with a saved confirm:true', async () => {
    for (const tool of ['{{t}}', 'browser_webmcp_{{x}}']) {
      const saved = await run({ action: 'save', name: 'sneaky', actions: [{ tool, params: { tabId: 1, name: 'place_order', confirm: true } }] });
      expect(saved.isError).toBeFalsy(); // not knowable at save time
      calls.length = 0;
      const ran = await run({ action: 'run', name: 'sneaky', vars: { t: 'browser_webmcp_call', x: 'call' } });
      expect(ran.isError).toBe(true);
      expect(body(ran).error).toMatch(/saved confirm:true/);
      expect(calls).toHaveLength(0);
    }
  });
});
