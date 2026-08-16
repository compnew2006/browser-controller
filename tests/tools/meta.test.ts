import { describe, it, expect } from 'vitest';
import { createMetaTool } from '../../mcp-server/src/tools/meta.js';
import { allTools } from '../../mcp-server/src/tools/index.js';
import type { ToolHost } from '../../mcp-server/src/tools/types.js';

/**
 * Progressive disclosure meta tool tests.
 * Verifies search/details/list actions work correctly and that the
 * activation callback fires when an agent requests tool details.
 */

// Minimal fake host (the meta tool doesn't actually call the daemon — it reads
// the registry in-process).
const fakeHost: ToolHost = {
  async callTool() { return {}; },
};

describe('browser_tools meta tool (progressive disclosure)', () => {
  // Track activations for assertion
  const activated: string[] = [];
  const activeSet = new Set<string>();
  const metaTool = createMetaTool({
    onActivate: (name) => { activated.push(name); activeSet.add(name); },
    isActive: (name) => activeSet.has(name),
  });

  it('is named browser_tools', () => {
    expect(metaTool.name).toBe('browser_tools');
  });

  it('action "list" returns all tools with name + summary + active flag', async () => {
    const result = await metaTool.handler(fakeHost, { action: 'list' });
    const text = (result.content[0] as { text: string }).text;
    const data = JSON.parse(text);
    expect(data.tools).toBeInstanceOf(Array);
    expect(data.tools.length).toBe(allTools.length); // all browser tools (meta excluded)
    // each entry has the progressive-disclosure shape
    for (const t of data.tools) {
      expect(t.name).toBeTruthy();
      expect(t.summary).toBeTruthy();
      expect(typeof t.active).toBe('boolean');
    }
    // browser_tools itself should NOT appear in the list
    expect(data.tools.find((t: any) => t.name === 'browser_tools')).toBeUndefined();
  });

  it('action "search" finds tools by keyword', async () => {
    const result = await metaTool.handler(fakeHost, { action: 'search', query: 'click' });
    const data = JSON.parse((result.content[0] as { text: string }).text);
    expect(data.matches.length).toBeGreaterThanOrEqual(2); // browser_click + browser_click_text
    const names = data.matches.map((m: any) => m.name);
    expect(names).toContain('browser_click');
    expect(names).toContain('browser_click_text');
    expect(data.count).toBe(data.matches.length);
  });

  it('action "search" matches multiple words (OR logic)', async () => {
    const result = await metaTool.handler(fakeHost, { action: 'search', query: 'tab navigate' });
    const data = JSON.parse((result.content[0] as { text: string }).text);
    const names = data.matches.map((m: any) => m.name);
    expect(names).toContain('browser_tabs');
    expect(names).toContain('browser_navigate');
  });

  it('action "search" with no match returns empty array', async () => {
    const result = await metaTool.handler(fakeHost, { action: 'search', query: 'nonexistent_xyz' });
    const data = JSON.parse((result.content[0] as { text: string }).text);
    expect(data.matches).toEqual([]);
    expect(data.count).toBe(0);
  });

  it('action "details" returns full schema + activates the tool', async () => {
    const result = await metaTool.handler(fakeHost, { action: 'details', tool: 'browser_click' });
    const data = JSON.parse((result.content[0] as { text: string }).text);
    expect(data.name).toBe('browser_click');
    expect(data.description).toBeTruthy();
    expect(data.activated).toBe(true);
    expect(data.message).toContain('browser_click');
    // the activation callback should have fired
    expect(activated).toContain('browser_click');
  });

  it('action "details" returns clean JSON Schema, not Zod internals', async () => {
    const result = await metaTool.handler(fakeHost, { action: 'details', tool: 'browser_click' });
    const data = JSON.parse((result.content[0] as { text: string }).text);
    const schema = data.inputSchema;
    // proper JSON Schema shape (z.toJSONSchema output)
    expect(schema.type).toBe('object');
    expect(schema.properties).toBeTruthy();
    expect(schema.properties.tabId).toBeTruthy();
    // .describe() text must survive serialization — the agent needs param docs
    expect(schema.properties.tabId.description).toContain('tab id');
    // regression guard: Zod v4 internals leak as a "def" key per property
    expect(schema.properties.tabId.def).toBeUndefined();
    expect(JSON.stringify(schema)).not.toContain('"checks"');
  });

  it('action "details" with unknown tool returns error + available list', async () => {
    const result = await metaTool.handler(fakeHost, { action: 'details', tool: 'browser_nope' });
    const data = JSON.parse((result.content[0] as { text: string }).text);
    expect(data.error).toContain('Unknown tool');
    expect(data.available).toBeInstanceOf(Array);
    expect(data.available.length).toBe(allTools.length);
  });

  it('action "list" shows active flag correctly after activation', async () => {
    // Self-contained: activate a tool HERE (order-independent — previously this
    // relied on browser_click being activated by an earlier test, which broke
    // when tests were run in isolation or reordered).
    await metaTool.handler(fakeHost, { action: 'details', tool: 'browser_hover' });
    const result = await metaTool.handler(fakeHost, { action: 'list' });
    const data = JSON.parse((result.content[0] as { text: string }).text);
    const hover = data.tools.find((t: any) => t.name === 'browser_hover');
    expect(hover.active).toBe(true);
    // a tool NOT activated in this test should be false
    const navigate = data.tools.find((t: any) => t.name === 'browser_navigate');
    expect(navigate.active).toBe(false);
  });

  it('action "search" without query returns error', async () => {
    const result = await metaTool.handler(fakeHost, { action: 'search' });
    const data = JSON.parse((result.content[0] as { text: string }).text);
    expect(data.error).toContain('query is required');
  });

  it('unknown action returns error with valid options', async () => {
    const result = await metaTool.handler(fakeHost, { action: 'bogus' as any });
    const data = JSON.parse((result.content[0] as { text: string }).text);
    expect(data.error).toContain('Unknown action');
    expect(data.error).toContain('list');
    expect(data.error).toContain('search');
    expect(data.error).toContain('details');
  });

  it('error paths set isError so clients can detect failure (audit: in-band-only errors)', async () => {
    // Regression (critical audit #7): every meta-tool error used to return a
    // success-shaped textResult — clients keying on isError (like wrapHandler)
    // treated failures as successes. Errors must keep the JSON body AND set
    // isError: true.
    const cases: Array<Record<string, unknown>> = [
      { action: 'search' },                      // missing query
      { action: 'details' },                     // missing tool
      { action: 'details', tool: 'browser_nope' }, // unknown tool
      { action: 'bogus' },                       // unknown action
    ];
    for (const params of cases) {
      const result = await metaTool.handler(fakeHost, params);
      expect(result.isError).toBe(true);
      const body = JSON.parse((result.content[0] as { text: string }).text);
      expect(typeof body.error).toBe('string');
      expect(body.error.length).toBeGreaterThan(0);
    }
  });
});
