import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { VaultRedactionRegistry, secretVariants } from '../mcp-server/src/vault/redaction.js';

const scope = 'c'.repeat(64);
const secret = 'p@ss w/rd+"x"\\é&=?#-' + crypto.randomBytes(4).toString('hex');
const utf8 = Buffer.from(secret, 'utf8');
const forms: Record<string, string> = {
  json: JSON.stringify(secret).slice(1, -1),
  uri: encodeURIComponent(secret),
  form: encodeURIComponent(secret).replace(/%20/g, '+'),
  base64: utf8.toString('base64'),
  'base64 unpadded': utf8.toString('base64').replace(/=+$/, ''),
  base64url: utf8.toString('base64url'),
  'base64url padded': utf8.toString('base64').replace(/\+/g, '-').replace(/\//g, '_'),
};

describe('encoded secret forms', () => {
  it.each(Object.entries(forms))('scrubs the %s form', (_name, form) => {
    const registry = new VaultRedactionRegistry();
    registry.register(scope, secret, 'doc');
    const out = JSON.stringify(registry.sanitize(scope, { result: `before ${form} after`, [form]: 1 }));
    expect(out.includes(form)).toBe(false);
    expect(out).toContain('before');
    expect(out).toContain('after');
  });

  it('exercises forms that really differ from the plain secret', () => {
    for (const form of Object.values(forms)) expect(form).not.toBe(secret);
    const variants = secretVariants(secret);
    for (const form of Object.values(forms)) expect(variants).toContain(form);
  });

  it('adds no encoded variants for a short secret', () => {
    const registry = new VaultRedactionRegistry();
    registry.register(scope, 'pw', 'doc');
    expect(secretVariants('pw')).not.toContain(Buffer.from('pw').toString('base64'));
    // 'cHc=' / 'cHc' must stay readable
    expect(registry.sanitize(scope, 'see cHc= and cHc')).toBe('see cHc= and cHc');
  });

  it('does not duplicate variants when forms equal the plain value', () => {
    const plain = secretVariants('abcdefghij');
    expect(new Set(plain).size).toBe(plain.length);
    expect(plain).not.toContain('abcdefghij'.replace('a', ''));
  });

  it('keeps the variant count bounded', () => {
    expect(secretVariants(secret + 'é\r\n').length).toBeLessThanOrEqual(24);
  });
});
