import { describe, expect, it } from 'vitest';
import { decideScope, MEMORY_SCOPE_UNKNOWN, type ScopeInput } from '../mcp-server/src/memory/scope.js';
import { defaultPolicy, enablePolicy, excludeOrigin } from '../mcp-server/src/memory/policy.js';

const NOW = '2026-10-27T10:00:00.000Z';
const enabled = enablePolicy(defaultPolicy(), NOW);

function input(overrides: Partial<ScopeInput> = {}): ScopeInput {
  return {
    purpose: 'capture',
    policy: enabled,
    browserId: 'browser-a',
    liveConnectionsForBrowserId: 1,
    connectionIdBefore: 'conn-1',
    connectionIdAfter: 'conn-1',
    extensionCapabilities: ['site-context'],
    vault: 'clear',
    siteContext: {
      url: 'https://example.com/account/login',
      incognito: false,
      topLevel: true,
      stable: true,
      anonymous: true,
      anonymityReason: 'ok',
    },
    sanitizedUnchanged: true,
    ...overrides,
  };
}

function unknown(overrides: Partial<ScopeInput>, reason: string): void {
  const decision = decideScope(input(overrides));
  expect(decision).toEqual({ in: false, outcome: 'unknown', code: MEMORY_SCOPE_UNKNOWN, reason });
}

describe('decideScope: the in case', () => {
  it('returns browserId, origin, path and the anonymity verdict', () => {
    const decision = decideScope(input());
    expect(decision).toEqual({
      in: true,
      scope: { browserId: 'browser-a', origin: 'https://example.com', path: '/account/login', anonymous: true },
    });
  });

  it('keeps anonymous null when the extension could not verify it', () => {
    const decision = decideScope(input({
      siteContext: { url: 'https://example.com/', incognito: false, topLevel: true, stable: true, anonymous: null, anonymityReason: 'no_permission' },
    }));
    expect(decision).toMatchObject({ in: true, scope: { anonymous: null } });
  });

  it('treats a different port as a different origin', () => {
    const a = decideScope(input({ siteContext: { ...input().siteContext!, url: 'http://127.0.0.1:4101/public.html' } }));
    const b = decideScope(input({ siteContext: { ...input().siteContext!, url: 'http://127.0.0.1:4102/public.html' } }));
    expect(a).toMatchObject({ in: true, scope: { origin: 'http://127.0.0.1:4101' } });
    expect(b).toMatchObject({ in: true, scope: { origin: 'http://127.0.0.1:4102' } });
  });

  it('never lets userinfo, query or fragment reach the scope', () => {
    const decision = decideScope(input({
      siteContext: { ...input().siteContext!, url: 'https://user:secret@example.com/search?q=token123#frag' },
    }));
    expect(decision).toMatchObject({ in: true, scope: { origin: 'https://example.com', path: '/search' } });
    const text = JSON.stringify(decision);
    for (const leak of ['user', 'secret', 'token123', 'frag', 'q=']) expect(text).not.toContain(leak);
  });
});

describe('decideScope: policy', () => {
  it('is out(disabled) when memory is off, even if everything else is fine', () => {
    expect(decideScope(input({ policy: defaultPolicy() }))).toEqual({ in: false, outcome: 'disabled', reason: 'disabled' });
  });

  it('is out(excluded) for an excluded origin only', () => {
    const policy = excludeOrigin(enabled, 'https://example.com', NOW);
    expect(decideScope(input({ policy }))).toEqual({ in: false, outcome: 'excluded', reason: 'excluded' });
    const other = decideScope(input({ policy, siteContext: { ...input().siteContext!, url: 'https://other.example/' } }));
    expect(other).toMatchObject({ in: true });
  });

  it('does not exclude a different port of an excluded origin', () => {
    const policy = excludeOrigin(enabled, 'http://127.0.0.1:4101', NOW);
    const decision = decideScope(input({ policy, siteContext: { ...input().siteContext!, url: 'http://127.0.0.1:4102/' } }));
    expect(decision).toMatchObject({ in: true });
  });
});

describe('decideScope: MEMORY_SCOPE_UNKNOWN fails closed (AC-08, AC-09)', () => {
  it('browserId is "default"', () => unknown({ browserId: 'default' }, 'default_browser_id'));
  it('browserId is empty', () => unknown({ browserId: '' }, 'default_browser_id'));
  it('two live connections carry one id', () => unknown({ liveConnectionsForBrowserId: 2 }, 'duplicate_identity'));
  it('no live connection carries the id', () => unknown({ liveConnectionsForBrowserId: 0 }, 'duplicate_identity'));
  it('the connectionId changed during the call', () => unknown({ connectionIdAfter: 'conn-2' }, 'connection_changed'));
  it('the connectionId is missing', () => unknown({ connectionIdBefore: undefined }, 'connection_changed'));
  it('the extension lacks site-context', () => unknown({ extensionCapabilities: ['batch'] }, 'no_site_context_capability'));
  it('the result carries no siteContext', () => unknown({ siteContext: null }, 'no_site_context'));
  it('an incognito tab', () => {
    unknown({ siteContext: { ...input().siteContext!, incognito: true } }, 'incognito');
  });
  it('vault state is protected', () => unknown({ vault: 'protected' }, 'vault_protected'));
  it('vault state is unknown', () => unknown({ vault: 'unknown' }, 'vault_unknown'));
  it('stable is false', () => {
    unknown({ siteContext: { ...input().siteContext!, stable: false, anonymous: null, anonymityReason: 'unstable' } }, 'unstable');
  });
  it('topLevel is false', () => {
    unknown({ siteContext: { ...input().siteContext!, topLevel: false } }, 'not_top_level');
  });
  it.each(['chrome://settings/', 'file:///etc/hosts', 'about:blank', 'ftp://example.com/', 'not a url', ''])(
    'a non-http(s) origin: %s',
    (url) => unknown({ siteContext: { ...input().siteContext!, url } }, 'non_http_origin'),
  );
  it('sanitizing changed the result', () => unknown({ sanitizedUnchanged: false }, 'sanitized_changed'));

  it('disabled policy wins over every unknown reason (no noise while off)', () => {
    const decision = decideScope(input({ policy: defaultPolicy(), browserId: 'default', vault: 'protected' }));
    expect(decision).toMatchObject({ in: false, outcome: 'disabled' });
  });

  it('identity problems win over vault and siteContext problems', () => {
    const decision = decideScope(input({ browserId: 'default', vault: 'protected', siteContext: null }));
    expect(decision).toMatchObject({ in: false, outcome: 'unknown', reason: 'default_browser_id' });
  });
});

describe('decideScope: reminders', () => {
  it('ignore a sanitized-result change (data-model.md Scope decision)', () => {
    const decision = decideScope(input({ purpose: 'reminder', sanitizedUnchanged: false }));
    expect(decision).toMatchObject({ in: true, scope: { origin: 'https://example.com' } });
  });

  it('still fail closed on every other condition', () => {
    expect(decideScope(input({ purpose: 'reminder', vault: 'protected' }))).toMatchObject({ in: false, reason: 'vault_protected' });
    expect(decideScope(input({ purpose: 'reminder', browserId: 'default' }))).toMatchObject({ in: false, reason: 'default_browser_id' });
  });
});
