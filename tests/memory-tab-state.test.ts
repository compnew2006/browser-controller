import { describe, expect, it } from 'vitest';
import {
  TAB_ATTRIBUTION_MS,
  TAB_CACHE_ENTRIES,
  TabStateCache,
  snapshotRoles,
} from '../mcp-server/src/memory/tab-state.js';

const NOW = Date.parse('2026-10-31T10:00:00.000Z');

describe('snapshotRoles', () => {
  it('keeps the role and the ref of every line, and never a name', () => {
    const roles = snapshotRoles(['- button "Accept all" [e3]', '  - link "Sign in" [e2]', '- textbox "Search" [e1]'].join('\n'));
    expect([...roles.entries()]).toEqual([['e3', 'button'], ['e2', 'link'], ['e1', 'textbox']]);
    expect(JSON.stringify([...roles.entries()])).not.toMatch(/accept|sign|search/iu);
  });

  it('reads a line without a ref as no role', () => {
    expect(snapshotRoles('- button "Accept all"').size).toBe(0);
  });

  it('is empty for text that is not a snapshot', () => {
    expect(snapshotRoles(null).size).toBe(0);
    expect(snapshotRoles('').size).toBe(0);
  });
});

describe('the tab cache', () => {
  it('returns the last observed read of a tab', () => {
    const cache = new TabStateCache();
    cache.remember('conn-1', 7, { url: 'https://example.com/login', origin: 'https://example.com', path: '/login', anonymous: true }, NOW);
    const entry = cache.lookup('conn-1', 7, NOW + 1000);
    expect(entry?.origin).toBe('https://example.com');
    expect(entry?.path).toBe('/login');
    expect(entry?.anonymous).toBe(true);
  });

  it('forgets a read that is older than the attribution window', () => {
    const cache = new TabStateCache();
    cache.remember('conn-1', 7, { url: 'https://example.com/', origin: 'https://example.com', path: '/', anonymous: true }, NOW);
    expect(cache.lookup('conn-1', 7, NOW + TAB_ATTRIBUTION_MS)).not.toBeNull();
    expect(cache.lookup('conn-1', 7, NOW + TAB_ATTRIBUTION_MS + 1)).toBeNull();
  });

  it('keeps the tabs of one connection from evicting another', () => {
    const cache = new TabStateCache();
    for (let tab = 1; tab <= TAB_CACHE_ENTRIES + 10; tab += 1) {
      cache.remember('conn-1', tab, { url: 'https://example.com/', origin: 'https://example.com', path: '/', anonymous: true }, NOW);
    }
    cache.remember('conn-2', 1, { url: 'https://other.test/', origin: 'https://other.test', path: '/', anonymous: true }, NOW);
    expect(cache.lookup('conn-2', 1, NOW)?.origin).toBe('https://other.test');
    expect(cache.lookup('conn-1', TAB_CACHE_ENTRIES + 10, NOW)).not.toBeNull();
    expect(cache.lookup('conn-1', 1, NOW)).toBeNull();
  });

  it('reads the role of a ref from the last snapshot of that tab', () => {
    const cache = new TabStateCache();
    cache.remember('conn-1', 7, { url: 'https://example.com/', origin: 'https://example.com', path: '/', anonymous: true, roles: new Map([['e3', 'button']]) }, NOW);
    expect(cache.roleOf('conn-1', 7, 'e3', NOW)).toBe('button');
    expect(cache.roleOf('conn-1', 7, 'e9', NOW)).toBeNull();
    expect(cache.roleOf('conn-1', 7, undefined, NOW)).toBeNull();
  });

  it('holds a commit mode for a path and gives it once', () => {
    const cache = new TabStateCache();
    cache.setCommitMode('conn-1', 'https://example.com', '/login', 'enter', NOW);
    expect(cache.takeCommitMode('conn-1', 'https://example.com', '/login', NOW + 1000)).toBe('enter');
    expect(cache.takeCommitMode('conn-1', 'https://example.com', '/login', NOW + 2000)).toBeNull();
  });

  it('keeps a commit mode for its own path only', () => {
    const cache = new TabStateCache();
    cache.setCommitMode('conn-1', 'https://example.com', '/login', 'enter', NOW);
    expect(cache.takeCommitMode('conn-1', 'https://example.com', '/signup', NOW + 1000)).toBeNull();
    expect(cache.takeCommitMode('conn-2', 'https://example.com', '/login', NOW + 1000)).toBeNull();
  });

  it('drops a commit mode that waited longer than the window', () => {
    const cache = new TabStateCache();
    cache.setCommitMode('conn-1', 'https://example.com', '/login', 'enter', NOW);
    expect(cache.takeCommitMode('conn-1', 'https://example.com', '/login', NOW + TAB_ATTRIBUTION_MS + 1)).toBeNull();
  });

  it('forgets a connection and everything it held', () => {
    const cache = new TabStateCache();
    cache.remember('conn-1', 7, { url: 'https://example.com/', origin: 'https://example.com', path: '/', anonymous: true }, NOW);
    cache.setCommitMode('conn-1', 'https://example.com', '/', 'enter', NOW);
    cache.forgetConnection('conn-1');
    expect(cache.lookup('conn-1', 7, NOW)).toBeNull();
    expect(cache.takeCommitMode('conn-1', 'https://example.com', '/', NOW)).toBeNull();
  });
});
