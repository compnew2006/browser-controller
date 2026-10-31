/**
 * The shared JSON-store engine's rules that the two stores depend on.
 *
 * The stores are two profiles over one engine (`core/json-store.ts`), so the
 * rules that decide whether a file is "gone" or "unreadable" live here and
 * are tested once, here, instead of twice in the stores.
 */
import { describe, expect, it } from 'vitest';
import { errorCode, isVanished } from '../mcp-server/src/core/json-store.js';

const withCode = (code: string): NodeJS.ErrnoException => Object.assign(new Error(`failed with ${code}`), { code });

describe('the errno code of a failure', () => {
  it('is the code the system reported', () => {
    expect(errorCode(withCode('ENOENT'))).toBe('ENOENT');
  });

  it('is undefined for something that is not an error', () => {
    expect(errorCode(undefined)).toBeUndefined();
    expect(errorCode(new Error('no code'))).toBeUndefined();
  });
});

describe('is the file gone, rather than unreadable?', () => {
  it('treats a missing file as gone on every platform', () => {
    expect(isVanished(withCode('ENOENT'))).toBe(true);
  });

  it('fails closed on ambiguous access or sharing errors on every platform', () => {
    expect(isVanished(withCode('EPERM'))).toBe(false);
    expect(isVanished(withCode('EACCES'))).toBe(false);
    expect(isVanished(withCode('EBUSY'))).toBe(false);
  });

  it('keeps failing closed on any other failure', () => {
    expect(isVanished(withCode('EIO'))).toBe(false);
    expect(isVanished(withCode('ENOSPC'))).toBe(false);
  });
});
