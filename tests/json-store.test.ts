/**
 * The shared JSON-store engine's rules that the two stores depend on.
 *
 * The stores are two profiles over one engine (`core/json-store.ts`), so the
 * rules that decide whether a file is "gone" or "unreadable" live here and
 * are tested once, here, instead of twice in the stores.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { errorCode, isGoneAfterError, isVanished } from '../mcp-server/src/core/json-store.js';

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

describe('is the file gone after an ambiguous Windows error?', () => {
  // The readers ask the filesystem instead of trusting the error code, so both
  // arms of that decision are exercised against real paths: a file that is gone
  // now (the pending deletion) and a file that is still there (the denied read).
  let dir = '';
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'json-store-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it('short-circuits to gone when the code is already ENOENT', async () => {
    expect(await isGoneAfterError(withCode('ENOENT'), join(dir, 'missing.json'), 'win32')).toBe(true);
  });

  it('never asks the filesystem off Windows — the ambiguous error stays fail-closed', async () => {
    const present = join(dir, 'here.json');
    await writeFile(present, '{}');
    expect(await isGoneAfterError(withCode('EACCES'), present, 'linux')).toBe(false);
  });

  it('reads a pending deletion as gone when lstat finds nothing behind the error', async () => {
    for (const code of ['EPERM', 'EACCES', 'EBUSY']) {
      expect(await isGoneAfterError(withCode(code), join(dir, 'already-gone.json'), 'win32')).toBe(true);
    }
  });

  it('fails closed when the file is still there and only the read was denied', async () => {
    const present = join(dir, 'still-there.json');
    await writeFile(present, '{}');
    for (const code of ['EPERM', 'EACCES', 'EBUSY']) {
      expect(await isGoneAfterError(withCode(code), present, 'win32')).toBe(false);
    }
  });
});
