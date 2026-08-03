import { describe, it, expect } from 'vitest';
import { isHashOnlyChange } from '../extension/utils/navigation.js';

/**
 * Navigation helper tests. `isHashOnlyChange` decides whether handleNavigate
 * can skip the `chrome.tabs.onUpdated` `complete` wait. A wrong answer here
 * means either a 55s hang (false negative on hash nav) or a missed settle on a
 * real navigation (false positive). Both are user-visible regressions, so the
 * table below pins the exact contract.
 */
describe('isHashOnlyChange', () => {
  it('returns true when only the hash differs', () => {
    expect(isHashOnlyChange('http://app.com/page', 'http://app.com/page#section')).toBe(true);
    expect(isHashOnlyChange('http://app.com/page#old', 'http://app.com/page#new')).toBe(true);
    expect(isHashOnlyChange('https://app.com:3000/#/users', 'https://app.com:3000/#/settings')).toBe(true);
  });

  it('returns false when the pathname differs (real navigation)', () => {
    expect(isHashOnlyChange('http://app.com/users', 'http://app.com/settings#x')).toBe(false);
    expect(isHashOnlyChange('http://app.com/a', 'http://app.com/b')).toBe(false);
  });

  it('returns false when the query string differs', () => {
    expect(isHashOnlyChange('http://app.com/x?a=1', 'http://app.com/x?a=1#h')).toBe(true); // same query + hash change
    expect(isHashOnlyChange('http://app.com/x?a=1', 'http://app.com/x?a=2#h')).toBe(false); // query changed
    expect(isHashOnlyChange('http://app.com/x', 'http://app.com/x?_=1#h')).toBe(false);
  });

  it('returns false when host/port/protocol differ', () => {
    expect(isHashOnlyChange('http://app.com/x', 'https://app.com/x#h')).toBe(false);
    expect(isHashOnlyChange('http://app.com:3000/x', 'http://app.com:4000/x#h')).toBe(false);
    expect(isHashOnlyChange('http://app.com/x', 'http://other.com/x#h')).toBe(false);
  });

  it('returns false for identical URLs (no change)', () => {
    expect(isHashOnlyChange('http://app.com/x#h', 'http://app.com/x#h')).toBe(false);
    expect(isHashOnlyChange('http://app.com/x', 'http://app.com/x')).toBe(false);
  });

  it('returns false for invalid/undefined/relative input (safe default)', () => {
    expect(isHashOnlyChange(undefined, 'http://app.com/x#h')).toBe(false);
    expect(isHashOnlyChange('http://app.com/x', undefined)).toBe(false);
    expect(isHashOnlyChange('', '')).toBe(false);
    // Relative URLs throw inside `new URL()` without a base → caught → false,
    // so the caller falls back to the safe full-navigation wait.
    expect(isHashOnlyChange('/page', '/page#h')).toBe(false);
  });
});
