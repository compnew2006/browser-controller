import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseSync } from '@babel/core';
import { ERROR_CODES, formatError, isCodedMessage, isKnownErrorCode, type ErrorCode } from '../mcp-server/src/core/error-codes.js';
import { ERROR_CODES as BROWSER_ERROR_CODES } from '../extension/lib/generated-contract.js';

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

/** Read literal error-code properties and assignments from executable JS, not comments. */
function assignedCodes(source: string): string[] {
  const ast = parseSync(source, { sourceType: 'unambiguous', babelrc: false, configFile: false });
  const codes: string[] = [];
  function visit(value: unknown): void {
    if (Array.isArray(value)) { value.forEach(visit); return; }
    if (!value || typeof value !== 'object') return;
    const node = value as Record<string, unknown>;
    const name = (key: unknown, computed: unknown): boolean => {
      if (!key || typeof key !== 'object') return false;
      const property = key as Record<string, unknown>;
      return (!computed && property.name === 'code') || property.value === 'code';
    };
    let candidate: unknown;
    if (node.type === 'ObjectProperty' && name(node.key, node.computed)) candidate = node.value;
    if (node.type === 'AssignmentExpression' && node.operator === '=' && node.left && typeof node.left === 'object') {
      const left = node.left as Record<string, unknown>;
      if (left.type === 'MemberExpression' && name(left.property, left.computed)) candidate = node.right;
    }
    if (candidate && typeof candidate === 'object') {
      const literal = candidate as Record<string, unknown>;
      if (literal.type === 'StringLiteral' && typeof literal.value === 'string' && /^[A-Z][A-Z0-9_]+$/u.test(literal.value)) codes.push(literal.value);
    }
    for (const [key, child] of Object.entries(node)) {
      if (key !== 'loc' && key !== 'comments' && key !== 'tokens') visit(child);
    }
  }
  visit(ast?.program);
  return codes;
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
    const extensionText = sourceFiles(EXTENSION_SRC, ['.js', '.ts'])
      .filter((file) => !file.endsWith(path.join('lib', 'generated-contract.js')))
      .map((file) => fs.readFileSync(file, 'utf8')).join('\n');
    const unused = Object.keys(ERROR_CODES).filter((code) => {
      if (serverText.includes(`ERROR_CODES.${code}`)) return false;
      return !new RegExp(`['"\`]${code}[:'"\`]`).test(extensionText);
    });
    expect(unused).toEqual([]);
  });
});

describe('extension error codes', () => {
  it('generates the browser registry from the server registry', () => {
    expect(BROWSER_ERROR_CODES).toEqual(ERROR_CODES);
    expect(Object.isFrozen(BROWSER_ERROR_CODES)).toBe(true);
  });

  it('detects code assignments and object properties without treating comments as code', () => {
    expect(assignedCodes("// err.code = 'COMMENT'\nerr.code = 'TAB_OWNED'; err['code'] = 'TIMEOUT'; err[code] = 'NOT_A_PROPERTY'; ({ code: 'TAB_NOT_OWNED' });"))
      .toEqual(['TAB_OWNED', 'TIMEOUT', 'TAB_NOT_OWNED']);
  });

  it('registers literal codes assigned to error objects', () => {
    const unknown: string[] = [];
    for (const file of sourceFiles(EXTENSION_SRC, ['.js'])) {
      for (const code of assignedCodes(fs.readFileSync(file, 'utf8'))) {
        if (!isKnownErrorCode(code)) unknown.push(`${path.relative(ROOT, file)}: ${code}`);
      }
    }
    expect(unknown).toEqual([]);
  });

  it('registers every coded string literal produced by the extension', () => {
    const unknown: string[] = [];
    for (const file of sourceFiles(EXTENSION_SRC, ['.js', '.ts'])) {
      for (const literal of stringLiterals(fs.readFileSync(file, 'utf8'))) {
        const match = /^([A-Z][A-Z0-9_]+): /.exec(literal);
        if (match && match[1] !== PLACEHOLDER && !isKnownErrorCode(match[1])) unknown.push(`${path.relative(ROOT, file)}: ${match[1]}`);
      }
    }
    expect(unknown).toEqual([]);
  });
});
