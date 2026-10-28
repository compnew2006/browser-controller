import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CONTEXT_ACTION } from '../mcp-server/src/memory/tool-route.js';
import { isMemoryTool, routeMemoryToolCall } from '../mcp-server/src/memory/policy-tool-route.js';
import { originCandidates } from '../mcp-server/src/memory/map-service.js';
import { MemoryService, type MemoryConnection } from '../mcp-server/src/memory/service.js';
import { defaultPolicy, enablePolicy, writePolicy } from '../mcp-server/src/memory/policy.js';
import { defaultMapPolicy, enableMapProfile, writeMapPolicy } from '../mcp-server/src/memory/map-policy.js';
import { siteMapTool } from '../mcp-server/src/tools/site-map.js';
import { toolMap } from '../mcp-server/src/tools/index.js';
import { TRUSTED_TOOL_RESULT_FIELDS } from '../mcp-server/src/vault/redaction.js';
import type { ToolHost } from '../mcp-server/src/tools/types.js';
import { ORIGIN, homeText, mkMapDir, navigateWithSnapshot } from './helpers/map-fixtures.js';

const PROFILE = 'profile-a';
let dir: ReturnType<typeof mkMapDir>;
let conn: MemoryConnection;
let clock: number;
let service: MemoryService;
let tabUrl: string;
let bridgeError: string | null;
const bridge = {
  callTool: vi.fn(async (_tool: string, _params: Record<string, unknown>) => {
    if (bridgeError) throw new Error(bridgeError);
    return { success: true, siteContext: { url: tabUrl, incognito: false, topLevel: true, stable: true, anonymous: true, lang: 'en', dir: 'ltr', passwordField: false } };
  }),
};

const route = (params: Record<string, unknown>) => routeMemoryToolCall('browser_site_map', service, bridge, 's1', 'agent', params, new AbortController().signal);

async function enableAll(): Promise<void> {
  const at = new Date(clock).toISOString();
  await writePolicy(dir.memoryDir, enablePolicy(defaultPolicy(), at));
  await writeMapPolicy(dir.memoryDir, enableMapProfile(defaultMapPolicy(), PROFILE, at));
  clock += 1_000;
}

async function learnRoot(): Promise<void> {
  clock += 1_000;
  const call = service.beginCall('s1', 'browser_navigate');
  service.afterCall(call, {
    sessionId: 's1',
    tool: 'browser_navigate',
    params: { tabId: 7, url: `${ORIGIN}/`, snapshot: true },
    daemonCallId: `n${clock}`,
    result: { success: true, tabId: 7, url: `${ORIGIN}/`, status: 200, text: navigateWithSnapshot(homeText()) },
    observation: { siteContext: { url: `${ORIGIN}/`, incognito: false, topLevel: true, stable: true, anonymous: true, lang: 'en', dir: 'ltr', passwordField: false }, digestBefore: 'a', digestAfter: 'a', sanitizedUnchanged: true },
  });
  await service.flush();
}

beforeEach(() => {
  dir = mkMapDir('bc-maptool-');
  clock = Date.parse('2026-10-28T09:00:00.000Z');
  conn = { browserId: PROFILE, browserLabel: 'Work', connectionId: 'conn-1', ambiguous: false, supportsSiteContext: true, supportsSiteMap: true };
  tabUrl = `${ORIGIN}/`;
  bridgeError = null;
  bridge.callTool.mockClear();
  service = new MemoryService({ memoryDir: dir.memoryDir, vault: { memoryEligibility: () => 'clear' }, connection: () => ({ ...conn }), now: () => clock });
});

afterEach(async () => {
  await service.flush();
  dir.cleanup();
});

describe('browser_site_map tool definition (T020)', () => {
  it('is daemon-owned, read-only and retry-safe, with tabId or origin, query and cursor', () => {
    expect(toolMap.get('browser_site_map')).toBe(siteMapTool);
    expect(isMemoryTool('browser_site_map')).toBe(true);
    expect(siteMapTool.idempotent).toBe(true);
    expect(Object.keys(siteMapTool.inputSchema.shape).sort()).toEqual(['cursor', 'origin', 'query', 'tabId']);
    expect(siteMapTool.inputSchema.safeParse({ tabId: 1, query: 'x'.repeat(101) }).success).toBe(false);
    expect(siteMapTool.inputSchema.safeParse({ origin: ORIGIN, cursor: 'p12' }).success).toBe(true);
    expect(siteMapTool.inputSchema.safeParse({ origin: ORIGIN, cursor: 'next' }).success).toBe(false);
    expect(siteMapTool.inputSchema.safeParse({ tabId: 1, extra: 1 }).success).toBe(false);
    expect(TRUSTED_TOOL_RESULT_FIELDS.browser_site_map).toEqual(['origin', 'label', 'outline', 'knownPages', 'pages', 'next']);
  });

  it('a batch step that names an origin gets no default tabId', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const host: ToolHost = { async callTool(_tool, params) { calls.push(params); return { success: true, text: 'ok' }; } };
    const batch = toolMap.get('browser_batch')!;
    await batch.handler(host, batch.inputSchema.parse({ tabId: 9, actions: [{ tool: 'browser_site_map', params: { origin: ORIGIN } }, { tool: 'browser_site_map', params: {} }] }) as Record<string, unknown>);
    expect(calls[0]).toEqual({ origin: ORIGIN });
    expect(calls[1]).toEqual({ tabId: 9 });
  });
});

describe('browser_site_map routing (T019, R-16)', () => {
  it('a tab lookup reads the tab context under the tab lock, then answers for the tab origin', async () => {
    await enableAll();
    await learnRoot();
    const answer = await route({ tabId: 7, query: 'help' });
    expect(answer).toMatchObject({ success: true, result: { success: true, origin: ORIGIN, outline: false } });
    expect(bridge.callTool).toHaveBeenCalledWith(CONTEXT_ACTION, { tabId: 7 }, 's1', expect.anything(), 'agent');
  });

  it('a named-origin lookup never reads the browser (AC-05)', async () => {
    await enableAll();
    await learnRoot();
    const answer = await route({ origin: 'shop.example' });
    expect(answer).toMatchObject({ success: true, result: { origin: ORIGIN, outline: true, knownPages: 1 } });
    expect(bridge.callTool).not.toHaveBeenCalled();
  });

  it('refuses before any tab read while memory is off or the extension lacks site-context', async () => {
    expect(await route({ tabId: 7 })).toMatchObject({ success: false, error: expect.stringMatching(/^MEMORY_DISABLED:/u) });
    await enableAll();
    conn.supportsSiteContext = false;
    expect(await route({ tabId: 7 })).toMatchObject({ success: false, error: expect.stringMatching(/^MEMORY_NOT_SUPPORTED:/u) });
    expect(await route({ origin: ORIGIN })).toMatchObject({ success: false, error: expect.stringMatching(/^MEMORY_NOT_SUPPORTED:/u) });
    expect(bridge.callTool).not.toHaveBeenCalled();
  });

  it('passes TAB_LOCKED through and refuses bad arguments without a tab read', async () => {
    await enableAll();
    bridgeError = 'TAB_LOCKED: tab 7 belongs to another session';
    expect(await route({ tabId: 7 })).toMatchObject({ success: false, error: expect.stringMatching(/^TAB_LOCKED:/u) });
    bridge.callTool.mockClear();
    for (const params of [{}, { tabId: 7, origin: ORIGIN }, { tabId: -1 }, { origin: ORIGIN, cursor: 'zz' }, { origin: ORIGIN, extra: true }]) {
      expect(await route(params)).toMatchObject({ success: false, error: expect.stringMatching(/^INVALID_ARGUMENT:/u) });
    }
    expect(bridge.callTool).not.toHaveBeenCalled();
  });

  it('a private tab or an unverified profile gives MEMORY_SCOPE_UNKNOWN', async () => {
    await enableAll();
    bridge.callTool.mockImplementationOnce(async () => ({ success: true, siteContext: { url: tabUrl, incognito: true, topLevel: true, stable: true, anonymous: true } }));
    expect(await route({ tabId: 7 })).toMatchObject({ success: false, error: expect.stringMatching(/^MEMORY_SCOPE_UNKNOWN:/u) });
    conn.ambiguous = true;
    expect(await route({ origin: ORIGIN })).toMatchObject({ success: false, error: expect.stringMatching(/^MEMORY_SCOPE_UNKNOWN:/u) });
  });
});

describe('originCandidates (CHK015)', () => {
  it('turns a host into https forms and keeps an origin as given', () => {
    expect(originCandidates('shop.example')).toEqual(['https://shop.example', 'https://www.shop.example']);
    expect(originCandidates('www.shop.example')).toEqual(['https://www.shop.example', 'https://shop.example']);
    expect(originCandidates('http://shop.example:8080')).toEqual(['http://shop.example:8080']);
    expect(originCandidates('https://shop.example/')).toEqual(['https://shop.example']);
    for (const bad of ['https://shop.example/a', 'ftp://shop.example', 'localhost', 'shop example', 'https://u:p@shop.example']) expect(originCandidates(bad)).toBeNull();
  });
});
