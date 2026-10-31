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
    expect(isVanished(withCode('ENOENT'), 'win32')).toBe(true);
    expect(isVanished(withCode('ENOENT'), 'linux')).toBe(true);
  });

  it('treats a file that is being deleted as gone on Windows', () => {
    // Windows refuses the open of a file that is on its way out, with
    // EPERM/EACCES/EBUSY instead of ENOENT. The record is gone either way.
    expect(isVanished(withCode('EPERM'), 'win32')).toBe(true);
    expect(isVanished(withCode('EACCES'), 'win32')).toBe(true);
    expect(isVanished(withCode('EBUSY'), 'win32')).toBe(true);
  });

  it('keeps failing closed on a permission problem elsewhere', () => {
    // On POSIX, EACCES means the file is there and this process may not read
    // it. That must not be mistaken for "no record".
    expect(isVanished(withCode('EACCES'), 'linux')).toBe(false);
    expect(isVanished(withCode('EPERM'), 'linux')).toBe(false);
    expect(isVanished(withCode('EBUSY'), 'linux')).toBe(false);
  });

  it('keeps failing closed on any other failure', () => {
    expect(isVanished(withCode('EIO'), 'win32')).toBe(false);
    expect(isVanished(withCode('EIO'), 'linux')).toBe(false);
    expect(isVanished(withCode('ENOSPC'), 'win32')).toBe(false);
  });
});
