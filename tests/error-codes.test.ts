import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ERROR_CODES, formatError, isCodedMessage, isKnownErrorCode, type ErrorCode } from '../mcp-server/src/core/error-codes.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER_SRC = path.join(ROOT, 'mcp-server', 'src');
const EXTENSION_SRC = path.join(ROOT, 'extension');

/** The code the documentation uses as a placeholder, not a code the product produces. */
const PLACEHOLDER = 'CODE';

function sourceFiles(root: string, extensions: readonly string[]): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (extensions.some((extension) => entry.name.endsWith(extension))) found.push(full);
    }
  };
  walk(root);
  return found;
}

/**
 * The string literals of a source file, skipping the ones inside comments.
 *
 * A comment may name a code in prose ("the text is `CODE: message`"), so the
 * literals are read rather than scraped: only the ones the code can actually
 * produce are counted.
 */
function stringLiterals(source: string): string[] {
  const literals: string[] = [];
  let index = 0;
  while (index < source.length) {
    const char = source[index];
    if (char === '/' && source[index + 1] === '/') {
      while (index < source.length && source[index] !== '\n') index++;
      continue;
    }
    if (char === '/' && source[index + 1] === '*') {
      index += 2;
      while (index < source.length && !(source[index] === '*' && source[index + 1] === '/')) index++;
      index += 2;
      continue;
    }
    if (char === "'" || char === '"' || char === '`') {
      const quote = char;
      const start = index + 1;
      index++;
      while (index < source.length) {
        if (source[index] === '\\') {
          index += 2;
          continue;
        }
        if (source[index] === quote) break;
        if (source[index] === '\n' && quote !== '`') break;
        index++;
      }
      literals.push(source.slice(start, index));
      index++;
      continue;
    }
    index++;
  }
  return literals;
}

describe('the error-code registry', () => {
  it('registers each code under its own name', () => {
    for (const [key, value] of Object.entries(ERROR_CODES)) {
      expect(value).toBe(key);
    }
  });

  it('knows a real code and refuses the typo the audit names', () => {
    expect(isKnownErrorCode('MEMORY_UNAVAILABLE')).toBe(true);
    expect(isKnownErrorCode('TAB_OWNED')).toBe(false);
    expect(isKnownErrorCode('TAB_NOT_OWNED')).toBe(true);
  });

  it('accepts a coded message only when the code is registered', () => {
    expect(isCodedMessage('MEMORY_UNAVAILABLE: x')).toBe(true);
    expect(isCodedMessage('TAB_OWNED: x')).toBe(false);
    expect(isCodedMessage('MEMORY_UNAVAILABLE')).toBe(false);
    expect(isCodedMessage('x MEMORY_UNAVAILABLE: x')).toBe(false);
  });

  it('formats a coded message exactly as the wire reads it', () => {
    expect(formatError('MEMORY_UNAVAILABLE' as ErrorCode, 'x')).toBe('MEMORY_UNAVAILABLE: x');
    expect(formatError('INVALID_ARGUMENT' as ErrorCode, 'target is required')).toBe('INVALID_ARGUMENT: target is required');
  });
});

describe('the coded messages in mcp-server/src', () => {
  const files = sourceFiles(SERVER_SRC, ['.ts']).filter((file) => !file.endsWith(path.join('core', 'error-codes.ts')));

  it('finds the server sources', () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it('has no coded message literal left: every code comes from the registry', () => {
    const found: string[] = [];
    for (const file of files) {
      const source = fs.readFileSync(file, 'utf8');
      for (const literal of stringLiterals(source)) {
        const match = /^([A-Z][A-Z0-9_]+): /.exec(literal);
        if (!match) continue;
        if (match[1] === PLACEHOLDER) continue;
        found.push(`${path.relative(ROOT, file)}: ${match[1]}`);
      }
    }
    expect(found).toEqual([]);
  });

  it('has no dead registry entry: every registered code is produced by the product', () => {
    // The server produces its own codes; the Chrome extension produces the rest,
    // and the server forwards those to the agent unchanged.
    const serverText = files.map((file) => fs.readFileSync(file, 'utf8')).join('\n');
    const extensionText = sourceFiles(EXTENSION_SRC, ['.js', '.ts']).map((file) => fs.readFileSync(file, 'utf8')).join('\n');
    const unused = Object.keys(ERROR_CODES).filter((code) => {
      if (serverText.includes(`ERROR_CODES.${code}`)) return false;
      return !new RegExp(`['"\`]${code}[:'"\`]`).test(extensionText);
    });
    expect(unused).toEqual([]);
  });
});
