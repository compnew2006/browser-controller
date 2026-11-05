import { describe, expect, it } from 'vitest';
import { decideKnowledgeScope, type KnowledgeScopeInput } from '../mcp-server/src/memory/knowledge-scope.js';
import { defaultPolicy, enablePolicy } from '../mcp-server/src/memory/policy.js';

const policy = enablePolicy(defaultPolicy(), '2026-11-05T00:00:00.000Z');

function input(overrides: Partial<KnowledgeScopeInput> = {}): KnowledgeScopeInput {
  return {
    purpose: 'reminder', policy, browserId: 'profile-a', liveConnectionsForBrowserId: 1,
    connectionIdBefore: 'connection-a', connectionIdAfter: 'connection-a',
    sessionIdBefore: 'session-a', sessionIdAfter: 'session-a',
    originBefore: 'https://example.invalid',
    extensionCapabilities: ['site-context'], vault: 'clear', sanitizedUnchanged: true,
    siteContext: { url: 'https://example.invalid/path?x=1', incognito: false, topLevel: true, stable: true, anonymous: true },
    ...overrides,
  };
}

describe('site knowledge scope', () => {
  it('binds the canonical origin, browser, connection and session from the trusted context', () => {
    expect(decideKnowledgeScope(input())).toEqual({
      in: true,
      scope: { browserId: 'profile-a', origin: 'https://example.invalid', connectionId: 'connection-a', sessionId: 'session-a' },
    });
  });

  it.each([
    ['default profile', { browserId: 'default' }],
    ['duplicate profile', { liveConnectionsForBrowserId: 2 }],
    ['changed connection', { connectionIdAfter: 'connection-b' }],
    ['changed session', { sessionIdAfter: 'session-b' }],
    ['missing session', { sessionIdBefore: '' }],
    ['changed origin', { originBefore: 'https://other.invalid' }],
    ['missing origin', { originBefore: undefined }],
    ['incognito', { siteContext: { ...input().siteContext!, incognito: true } }],
    ['protected vault', { vault: 'protected' }],
    ['unknown vault', { vault: 'unknown' }],
  ] as Array<[string, Partial<KnowledgeScopeInput>]>)('rejects %s', (_name, overrides) => {
    expect(decideKnowledgeScope(input(overrides)).in).toBe(false);
  });

  it('keeps two profiles separate even at the same origin', () => {
    const first = decideKnowledgeScope(input());
    const second = decideKnowledgeScope(input({ browserId: 'profile-b' }));
    expect(first.in && second.in && first.scope.browserId !== second.scope.browserId).toBe(true);
    expect(first.in && second.in && first.scope.origin === second.scope.origin).toBe(true);
  });
});
