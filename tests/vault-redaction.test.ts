import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { TRUSTED_TOOL_RESULT_FIELDS, VaultRedactionRegistry } from '../mcp-server/src/vault/redaction.js';
import { allTools } from '../mcp-server/src/tools/index.js';

const scopeA = 'a'.repeat(64);
const scopeB = 'b'.repeat(64);

describe('VaultRedactionRegistry', () => {
  it('has an exact root response schema entry for every registered public tool', () => {
    expect(Object.keys(TRUSTED_TOOL_RESULT_FIELDS).sort()).toEqual(allTools.map((tool) => tool.name).sort());
  });

  it('redacts nested text and errors recursively while keeping browser scopes separate', () => {
    const registry = new VaultRedactionRegistry();
    const secret = `sentinel-${crypto.randomBytes(16).toString('hex')}`;
    registry.register(scopeA, secret, 'doc-a');
    const value = {
      content: [{ type: 'text', text: `page text contains ${secret}` }],
      error: Object.assign(new Error(`page error contains ${secret}`), { code: 'PAGE_ERROR' }),
      nested: { echoed: [secret] },
    };
    const sanitized = registry.sanitize(scopeA, value);
    expect(JSON.stringify(sanitized).includes(secret)).toBe(false);
    expect(JSON.stringify(registry.sanitize(scopeB, value)).includes(secret)).toBe(true);
  });

  it('redacts Unicode normalization and newline forms without regex interpretation', () => {
    const registry = new VaultRedactionRegistry();
    const secret = `e\u0301\r\n-${crypto.randomBytes(12).toString('hex')}.*`;
    registry.register(scopeA, secret, 'doc-a');
    const naturalForm = secret.normalize('NFC').replace(/\r\n/g, '\n');
    const sanitized = registry.sanitize(scopeA, `first ${secret} second ${naturalForm}`);
    expect(JSON.stringify(sanitized).includes(secret)).toBe(false);
    expect(JSON.stringify(sanitized).includes(secret.normalize('NFC'))).toBe(false);
  });

  it('handles overlapping values and very short values without returning them in the marker', () => {
    const registry = new VaultRedactionRegistry();
    registry.register(scopeA, 'x', 'doc-a');
    registry.register(scopeA, 'xyxy', 'doc-a');
    registry.register(scopeA, 'z', 'doc-a');
    const sanitized = String(registry.sanitize(scopeA, 'x xyxy xylophone'));
    expect(sanitized.includes('x')).toBe(false);
    expect(sanitized.includes('xyxy')).toBe(false);
    expect(sanitized.includes('z')).toBe(false);
  });

  it('scrubs page-authored values even when they use protocol-looking field names', () => {
    const registry = new VaultRedactionRegistry();
    const secret = `sentinel-${crypto.randomBytes(16).toString('hex')}`;
    registry.register(scopeA, secret, 'doc-a');
    const imageBytes = crypto.randomBytes(32).toString('base64');
    const sanitized = registry.sanitize(scopeA, {
      id: secret,
      requestId: secret,
      success: true,
      result: {
        status: secret,
        code: secret,
        identifier: secret,
        content: [{ type: 'image', mimeType: 'image/jpeg', data: secret }],
      },
      pageImage: imageBytes,
    });
    expect(JSON.stringify(sanitized).includes(secret)).toBe(false);
    expect(JSON.stringify(sanitized).includes(imageBytes)).toBe(true);
  });

  it('preserves the raw screenshot wire image only at its trusted root image path', () => {
    const registry = new VaultRedactionRegistry();
    registry.register(scopeA, 'a', 'doc-a');
    const imageBytes = crypto.randomBytes(32).toString('base64');
    const screenshot = {
      success: true,
      text: 'a screenshot',
      image: { data: imageBytes, mimeType: 'image/jpeg' },
      width: 128,
      height: 64,
      via: 'cdp',
    };
    const trusted = registry.sanitize(scopeA, screenshot, { toolName: 'browser_screenshot' }) as Record<string, any>;
    expect(trusted.success).toBe(true);
    expect(trusted.text).not.toContain('a');
    expect(trusted.image.data).toBe(imageBytes);
    expect(trusted.image.mimeType).toBe('image/jpeg');
    expect(trusted.width).toBe(128);

    const spoofRegistry = new VaultRedactionRegistry();
    spoofRegistry.register(scopeA, 'spoof-secret', 'doc-a');
    const pageSpoof = spoofRegistry.sanitize(scopeA, {
      success: true,
      result: screenshot,
    }, { toolName: 'browser_evaluate' }) as Record<string, any>;
    expect(JSON.stringify(pageSpoof).includes('spoof-secret')).toBe(false);
    const nestedSpoof = spoofRegistry.sanitize(scopeA, {
      success: true,
      result: { image: { data: 'spoof-secret', mimeType: 'image/jpeg' }, content: [{ type: 'image', data: 'spoof-secret', mimeType: 'image/jpeg' }] },
    }, { toolName: 'browser_screenshot' }) as Record<string, any>;
    expect(JSON.stringify(nestedSpoof).includes('spoof-secret')).toBe(false);
  });

  it('preserves tool-root schema keys while scrubbing page-authored nested keys and values', () => {
    const registry = new VaultRedactionRegistry();
    registry.register(scopeA, 'status', 'doc-a');
    const sanitized = registry.sanitize(scopeA, {
      success: true,
      text: 'safe status summary',
      filled: 1,
      result: { status: 'status', code: 'status', identifier: 'status' },
    }, { toolName: 'browser_fill' }) as Record<string, any>;
    expect(sanitized.success).toBe(true);
    expect(Object.keys(sanitized)).toEqual(['success', 'text', 'filled', 'result']);
    expect(sanitized.filled).toBe(1);
    expect(sanitized.text).not.toContain('status');
    expect(Object.keys(sanitized.result)).not.toContain('status');
    expect(Object.keys(sanitized.result)).toContain('code');
    expect(Object.keys(sanitized.result)).toContain('identifier');
    expect(JSON.stringify(sanitized.result)).not.toContain('status');
  });

  it('keeps daemon-owned schema keys but never returns a colliding enum or error value', () => {
    const registry = new VaultRedactionRegistry();
    registry.register(scopeA, 'filled', 'doc-a');
    const raw = {
      success: false,
      status: 'filled',
      code: 'VAULT_PERMISSION_DENIED',
      error: 'VAULT_PERMISSION_DENIED: filled access is no longer authorized',
      message: 'filled access is no longer authorized',
    };
    const sanitized = registry.sanitize(scopeA, raw, { toolName: 'browser_vault' }) as Record<string, any>;
    expect(sanitized.success).toBe(false);
    expect(sanitized).not.toHaveProperty('status');
    expect(sanitized.code).toBe('VAULT_PERMISSION_DENIED');
    expect(sanitized.error).toMatch(/^VAULT_PERMISSION_DENIED: /);
    expect(sanitized.error).not.toContain('filled access');
    expect(sanitized.message).not.toContain('filled');
  });

  it('redacts colliding success text and suppresses a coded error when its code is the password', () => {
    const registry = new VaultRedactionRegistry();
    registry.register(scopeA, 'success', 'doc-success');
    registry.register(scopeA, 'VAULT_PERMISSION_DENIED', 'doc-code');
    const sanitized = registry.sanitize(scopeA, {
      success: false,
      status: 'failed',
      code: 'VAULT_PERMISSION_DENIED',
      error: 'VAULT_PERMISSION_DENIED: success was denied',
      message: 'success was denied',
      text: 'success',
    }, { toolName: 'browser_vault' }) as Record<string, unknown>;
    expect(sanitized.success).toBe(false);
    expect(sanitized).not.toHaveProperty('code');
    expect(sanitized.error).not.toContain('VAULT_PERMISSION_DENIED');
    expect(sanitized.text).not.toBe('success');
    expect(sanitized.message).not.toContain('success');
    expect(sanitized.error).not.toContain('success');
  });

  it('preserves success and tool-output fields for one-character passwords', () => {
    const registry = new VaultRedactionRegistry();
    registry.register(scopeA, 'a', 'doc-a');
    const raw = { success: true, text: 'a was entered', filled: 1, result: { status: 'a' } };
    const sanitized = registry.sanitize(scopeA, raw, { toolName: 'browser_fill' }) as Record<string, any>;
    expect(sanitized.success).toBe(true);
    expect(sanitized.filled).toBe(1);
    expect(Object.hasOwn(sanitized, 'text')).toBe(true);
    expect(sanitized.text).not.toContain('a');
    expect(sanitized.result.status).not.toBe('a');
  });

  it('keeps the redaction registry from corrupting a trusted short-secret screenshot payload', () => {
    const registry = new VaultRedactionRegistry();
    registry.register(scopeA, 'a', 'doc-a');
    const imageBytes = crypto.randomBytes(32).toString('base64');
    const sanitized = registry.sanitize(scopeA, {
      success: true,
      text: 'a screenshot',
      image: { data: imageBytes, mimeType: 'image/jpeg' },
      width: 32,
      height: 32,
    }, { toolName: 'browser_screenshot' }) as Record<string, any>;
    expect(sanitized.image.data).toBe(imageBytes);
    expect(sanitized.success).toBe(true);
    expect(sanitized.text).not.toContain('a');
  });

  it('retains redaction while any protected document references a value, then releases it explicitly', () => {
    const registry = new VaultRedactionRegistry();
    const secret = `retained-${crypto.randomBytes(12).toString('hex')}`;
    registry.register(scopeA, secret, 'doc-a');
    registry.register(scopeA, secret, 'doc-b');
    registry.removeDocument(scopeA, 'doc-a');
    expect(JSON.stringify(registry.sanitize(scopeA, secret)).includes(secret)).toBe(false);
    expect(registry.hasSecretForDocument(scopeA, 'doc-b')).toBe(true);
    registry.removeDocument(scopeA, 'doc-b');
    expect(registry.hasSecrets(scopeA)).toBe(false);
    expect(registry.sanitize(scopeA, secret)).toBe(secret);
  });
});
