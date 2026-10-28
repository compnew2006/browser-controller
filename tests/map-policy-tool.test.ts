import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { registerTools } from '../mcp-server/src/register-tools.js';
import { routeMemoryPolicyTool } from '../mcp-server/src/memory/policy-tool-route.js';
import { MemoryService, type MemoryConnection } from '../mcp-server/src/memory/service.js';
import { defaultPolicy, enablePolicy, writePolicy } from '../mcp-server/src/memory/policy.js';
import { readMapPolicy } from '../mcp-server/src/memory/map-policy.js';
import { MAP_POLICY_ACTIONS, MEMORY_POLICY_ACTIONS, POLICY_ACTIONS } from '../mcp-server/src/memory/policy-actions.js';
import { memoryPolicyTool } from '../mcp-server/src/tools/memory-policy.js';
import type { ToolHost } from '../mcp-server/src/tools/types.js';
import { ORIGIN, homeText, mkMapDir, navigateWithSnapshot } from './helpers/map-fixtures.js';

/**
 * The map_* actions of browser_memory_policy (specs/004-site-navigation-map R-20, AC-16, AC-17): the MCP-side
 * prompt and the daemon route, driven together over a real MCP client with elicitation and a real MemoryService.
 */

const PROFILE = 'profile-a';
let dir: ReturnType<typeof mkMapDir>;
let conn: MemoryConnection;
let tabUrl: string;
let clock: number;
let service: MemoryService;

function daemonHost(): ToolHost {
  const bridge = {
    callTool: async () => ({ success: true, siteContext: { url: tabUrl, incognito: false, topLevel: true, stable: true, anonymous: true, lang: 'en', dir: 'ltr', passwordField: false } }),
  };
  return {
    async callTool(_tool, params) {
      const routed = await routeMemoryPolicyTool(service, bridge, 's1', 'agent', params, new AbortController().signal);
      if (routed.success) return routed.result;
      const error = new Error(routed.error);
      if (routed.result !== undefined) (error as Error & { result?: unknown }).result = routed.result;
      throw error;
    },
  };
}

type Answer = 'accept' | 'decline' | 'cancel';

async function connect(options: { elicitation?: boolean; answer?: Answer; onAsk?: () => void } = {}) {
  const server = new McpServer({ name: 'map-policy-test', version: '0.0.0' });
  registerTools(server, daemonHost());
  const messages: string[] = [];
  const client = new Client({ name: 'map-policy-client', version: '0.0.0' }, { capabilities: options.elicitation === false ? {} : { elicitation: { form: {} } } });
  if (options.elicitation !== false) {
    client.setRequestHandler(ElicitRequestSchema, async (request) => {
      messages.push((request.params as { message: string }).message);
      options.onAsk?.();
      const answer = options.answer ?? 'accept';
      return answer === 'accept' ? { action: 'accept' as const, content: { confirm: true } } : { action: answer };
    });
  }
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const call = async (args: Record<string, unknown>) => {
    const result = await client.callTool({ name: 'browser_memory_policy', arguments: args });
    const text = ((result.content as Array<{ type: string; text?: string }>).find((c) => c.type === 'text') as { text: string }).text;
    return { isError: result.isError === true, text };
  };
  return { call, messages };
}

beforeEach(async () => {
  dir = mkMapDir('bc-mappol-');
  clock = Date.parse('2026-10-28T09:00:00.000Z');
  conn = { browserId: PROFILE, browserLabel: 'Work', connectionId: 'conn-1', ambiguous: false, supportsSiteContext: true, supportsSiteMap: true };
  tabUrl = `${ORIGIN}/account/orders`;
  service = new MemoryService({ memoryDir: dir.memoryDir, vault: { memoryEligibility: () => 'clear' }, connection: () => ({ ...conn }), now: () => (clock += 1_000) });
  await writePolicy(dir.memoryDir, enablePolicy(defaultPolicy(), new Date(clock).toISOString()));
});

afterEach(async () => {
  await service.flush();
  dir.cleanup();
});

describe('map_* actions: one shared action list (R-20)', () => {
  it('the MCP schema offers exactly the shared list', () => {
    expect(POLICY_ACTIONS).toEqual([...MEMORY_POLICY_ACTIONS, ...MAP_POLICY_ACTIONS]);
    expect(memoryPolicyTool.inputSchema.shape.action.options).toEqual([...POLICY_ACTIONS]);
  });
});

describe('map_* actions: owner confirmation (AC-17)', () => {
  it('map_enable states that signed-in page addresses are recorded, and applies for this profile only', async () => {
    const { call, messages } = await connect();
    const result = await call({ action: 'map_enable' });
    expect(result.isError).toBe(false);
    expect(messages).toEqual(['Allow enabling the site map for browser profile "Work"? The map records the addresses of pages agents visit in this browser profile, including signed-in pages.']);
    expect(readMapPolicy(dir.memoryDir).profiles).toEqual({ [PROFILE]: { enabled: true, enabledAt: expect.any(String) } });
    expect(result.text).toBe('The site map is on for browser profile "Work".');
  });

  it.each<[Answer | 'unavailable', RegExp]>([
    ['decline', /^ACTION_NOT_CONFIRMED:/u],
    ['cancel', /^ACTION_NOT_CONFIRMED:/u],
    ['unavailable', /^CLIENT_CONFIRMATION_UNAVAILABLE:/u],
  ])('%s leaves the map policy unchanged', async (answer, code) => {
    const { call } = await connect(answer === 'unavailable' ? { elicitation: false } : { answer });
    const result = await call({ action: 'map_enable' });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(code);
    expect(readMapPolicy(dir.memoryDir).profiles).toEqual({});
  });

  it('uses the browserId when the connection has no label', async () => {
    conn.browserLabel = '';
    const { call, messages } = await connect();
    await call({ action: 'map_disable' });
    expect(messages).toEqual([`Allow disabling the site map for browser profile "${PROFILE}"? Existing map data is kept until it is deleted.`]);
  });

  it('names the canonical path and the tab origin for path actions', async () => {
    const { call, messages } = await connect();
    expect((await call({ action: 'map_enable' })).isError).toBe(false);
    expect((await call({ action: 'map_exclude_path', tabId: 7, path: '/health/' })).isError).toBe(false);
    expect((await call({ action: 'map_include_path', tabId: 7, path: '/health' })).isError).toBe(false);
    expect((await call({ action: 'map_delete', tabId: 7, path: '/account' })).isError).toBe(false);
    expect((await call({ action: 'map_delete', tabId: 7 })).isError).toBe(false);
    expect((await call({ action: 'map_delete' })).isError).toBe(false);
    expect(messages.slice(1)).toEqual([
      `Allow excluding /health and the pages under it from the site map for ${ORIGIN}? Existing entries under it are deleted.`,
      `Allow including /health in the site map for ${ORIGIN} again?`,
      `Allow deleting the site map entry /account of ${ORIGIN} for browser profile "Work"?`,
      `Allow deleting the site map of ${ORIGIN} for browser profile "Work"?`,
      'Allow deleting the site map of all sites for browser profile "Work"?',
    ]);
    expect(readMapPolicy(dir.memoryDir).excludedPaths).toEqual({});
  });

  it('refuses when the session profile or the tab changed while the owner decided', async () => {
    let { call } = await connect({ onAsk: () => { conn = { ...conn, browserId: 'profile-b' }; } });
    let result = await call({ action: 'map_enable' });
    expect(result.text).toMatch(/^MEMORY_SCOPE_UNKNOWN:/u);
    expect(readMapPolicy(dir.memoryDir).profiles).toEqual({});

    conn = { ...conn, browserId: PROFILE };
    ({ call } = await connect({ onAsk: () => { tabUrl = 'https://other.example/'; } }));
    result = await call({ action: 'map_exclude_path', tabId: 7, path: '/health' });
    expect(result.text).toMatch(/^MEMORY_SCOPE_UNKNOWN:/u);
    expect(readMapPolicy(dir.memoryDir).excludedPaths).toEqual({});
  });

  it('refuses agent-supplied confirmation fields and bad arguments before any prompt', async () => {
    const { call, messages } = await connect({ answer: 'decline' });
    expect((await call({ action: 'map_enable', ownerConfirmed: true, confirmedProfile: PROFILE })).isError).toBe(true);
    expect(readMapPolicy(dir.memoryDir).profiles).toEqual({});
    for (const args of [{ action: 'map_enable', tabId: 7 }, { action: 'map_exclude_path', tabId: 7 }, { action: 'map_delete', path: '/a' }, { action: 'enable', path: '/a' }, { action: 'map_inspect', path: '/a', tabId: 7 }]) {
      expect((await call(args)).isError).toBe(true);
    }
    expect(messages).toEqual([]);
  });

  it('refuses an unverified profile before any prompt', async () => {
    conn.ambiguous = true;
    const { call, messages } = await connect();
    expect((await call({ action: 'map_enable' })).text).toMatch(/^MEMORY_SCOPE_UNKNOWN:/u);
    expect(messages).toEqual([]);
  });

  it('map_inspect shows this profile\'s outline of the tab\'s site after confirmation', async () => {
    const { call, messages } = await connect();
    await call({ action: 'map_enable' });
    clock += 1_000;
    tabUrl = `${ORIGIN}/`;
    const shape = { sessionId: 's1', tool: 'browser_navigate', params: { tabId: 7, url: tabUrl, snapshot: true }, daemonCallId: 'n1', result: { success: true, tabId: 7, url: tabUrl, status: 200, text: navigateWithSnapshot(homeText()) } };
    const begin = service.beginCall('s1', 'browser_navigate');
    service.afterCall(begin, { ...shape, observation: { siteContext: { url: tabUrl, incognito: false, topLevel: true, stable: true, anonymous: true, lang: 'en', dir: 'ltr', passwordField: false }, digestBefore: 'a', digestAfter: 'a', sanitizedUnchanged: true } });
    await service.flush();
    const result = await call({ action: 'map_inspect', tabId: 7 });
    expect(messages.at(-1)).toBe(`Allow showing the site map of ${ORIGIN} for browser profile "Work"?`);
    expect(result.text).toContain(`site map for ${ORIGIN}`);
    expect(result.text).toContain('1. / "Shop home"');
    // map_export gives the agent the same outline it can read, and points the owner at the CLI for the JSON (RV-15).
    const exported = await call({ action: 'map_export', tabId: 7 });
    expect(exported.text).toContain('1. / "Shop home"');
    expect(exported.text).toContain('npm run memory -- map export');
    expect(exported.text).not.toContain('"controls"');
  });
});
