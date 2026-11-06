import { describe, expect, it, vi } from 'vitest';
import { resolveKnowledgeContext, type KnowledgeContextDependencies } from '../mcp-server/src/memory/knowledge-context.js';
import { defaultPolicy, enablePolicy } from '../mcp-server/src/memory/policy.js';
import { defaultKnowledgePolicy, transitionKnowledgePolicy } from '../mcp-server/src/memory/knowledge-policy.js';

const memory = enablePolicy(defaultPolicy(), '2026-11-05T00:00:00.000Z');
const knowledge = transitionKnowledgePolicy(defaultKnowledgePolicy(), { action: 'enable' });

function fixture() {
  const connection = { browserId: 'profile-a', connectionId: 'connection-a', ambiguous: false, supportsSiteContext: true };
  const siteContext = { url: 'https://example.invalid/page?q=secret', incognito: false, topLevel: true, stable: true, anonymous: true };
  const bridge = vi.fn(async () => ({ siteContext }));
  const deps: KnowledgeContextDependencies = {
    memoryPolicy: () => memory,
    knowledgePolicy: async () => knowledge,
    connection: () => connection,
    vaultEligibility: () => 'clear',
    sessionLive: () => true,
    epoch: () => 0,
    bridge: { callTool: bridge },
  };
  return { deps, bridge, connection, siteContext };
}

const call = (deps: KnowledgeContextDependencies) => resolveKnowledgeContext(deps, 'session-a', 'agent', 7, new AbortController().signal);

describe('trusted site knowledge context', () => {
  it('derives the profile and canonical origin from the active connection and tab', async () => {
    const { deps, bridge } = fixture();
    await expect(call(deps)).resolves.toEqual({ sessionId: 'session-a', connectionId: 'connection-a', browserId: 'profile-a', origin: 'https://example.invalid' });
    expect(bridge).toHaveBeenCalledWith('browser_memory_internal_context', { tabId: 7 }, 'session-a', expect.any(AbortSignal), 'agent');
  });

  it('does not read the tab when either policy is disabled', async () => {
    const f = fixture();
    f.deps.memoryPolicy = () => defaultPolicy();
    await expect(call(f.deps)).rejects.toThrow();
    expect(f.bridge).not.toHaveBeenCalled();
    const g = fixture();
    g.deps.knowledgePolicy = async () => defaultKnowledgePolicy();
    await expect(call(g.deps)).rejects.toThrow();
    expect(g.bridge).not.toHaveBeenCalled();
  });

  it.each([
    ['default profile', (f: ReturnType<typeof fixture>) => { f.connection.browserId = 'default'; }],
    ['duplicate profile', (f: ReturnType<typeof fixture>) => { f.connection.ambiguous = true; }],
    ['unsupported extension', (f: ReturnType<typeof fixture>) => { f.connection.supportsSiteContext = false; }],
    ['incognito', (f: ReturnType<typeof fixture>) => { f.siteContext.incognito = true; }],
    ['subframe', (f: ReturnType<typeof fixture>) => { f.siteContext.topLevel = false; }],
    ['unstable page', (f: ReturnType<typeof fixture>) => { f.siteContext.stable = false; }],
    ['non-http page', (f: ReturnType<typeof fixture>) => { f.siteContext.url = 'file:///tmp/example'; }],
  ])('rejects %s', async (_name, mutate) => {
    const f = fixture(); mutate(f);
    await expect(call(f.deps)).rejects.toThrow();
  });

  it.each(['unknown', 'protected'] as const)('rejects vault eligibility %s before tab access', async (state) => {
    const f = fixture(); f.deps.vaultEligibility = () => state;
    await expect(call(f.deps)).rejects.toThrow();
    expect(f.bridge).not.toHaveBeenCalled();
  });

  it('rejects a connection or profile that changes while reading the tab', async () => {
    const f = fixture();
    f.deps.bridge.callTool = async () => { f.connection.connectionId = 'connection-b'; return { siteContext: f.siteContext }; };
    await expect(call(f.deps)).rejects.toThrow();
  });

  it('rejects a session or policy that changes while reading the tab', async () => {
    const f = fixture(); let live = true;
    f.deps.sessionLive = () => live;
    f.deps.bridge.callTool = async () => { live = false; return { siteContext: f.siteContext }; };
    await expect(call(f.deps)).rejects.toThrow();
    const g = fixture(); let policy = knowledge;
    g.deps.knowledgePolicy = async () => policy;
    g.deps.bridge.callTool = async () => { policy = transitionKnowledgePolicy(policy, { action: 'disable' }); return { siteContext: g.siteContext }; };
    await expect(call(g.deps)).rejects.toThrow();
  });

  it('detects in-place policy generation changes and epoch changes', async () => {
    const f = fixture();
    const mutable = { ...knowledge, excluded: [...knowledge.excluded] };
    f.deps.knowledgePolicy = async () => mutable;
    f.deps.bridge.callTool = async () => { mutable.generation += 1; return { siteContext: f.siteContext }; };
    await expect(call(f.deps)).rejects.toThrow();

    const g = fixture();
    let epoch = 0; g.deps.epoch = () => epoch;
    g.deps.bridge.callTool = async () => { epoch += 1; return { siteContext: g.siteContext }; };
    await expect(call(g.deps)).rejects.toThrow();
  });
});
