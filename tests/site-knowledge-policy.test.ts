import { describe, expect, it } from 'vitest';
import { defaultKnowledgePolicy, transitionKnowledgePolicy, permitsKnowledge } from '../mcp-server/src/memory/knowledge-policy.js';
import { defaultPolicy, enablePolicy, excludeOrigin } from '../mcp-server/src/memory/policy.js';

const now = '2026-11-05T00:00:00.000Z';
const site = 'https://example.invalid';
const memory = enablePolicy(defaultPolicy(), now);

describe('site knowledge policy', () => {
  it('starts disabled even if existing website memory is enabled', () => {
    expect(permitsKnowledge(defaultKnowledgePolicy(), memory, site)).toBe(false);
  });

  it('requires both policies and allows independent exclusion and reinclusion', () => {
    const enabled = transitionKnowledgePolicy(defaultKnowledgePolicy(), { action: 'enable' });
    expect(permitsKnowledge(enabled, memory, site)).toBe(true);
    expect(permitsKnowledge(enabled, defaultPolicy(), site)).toBe(false);
    expect(permitsKnowledge(enabled, excludeOrigin(memory, site, now), site)).toBe(false);
    const excluded = transitionKnowledgePolicy(enabled, { action: 'exclude', origin: site });
    expect(permitsKnowledge(excluded, memory, site)).toBe(false);
    expect(permitsKnowledge(transitionKnowledgePolicy(excluded, { action: 'include', origin: site }), memory, site)).toBe(true);
  });

  it('invalidates earlier drafts on policy transitions without mutating the original', () => {
    const initial = defaultKnowledgePolicy();
    const enabled = transitionKnowledgePolicy(initial, { action: 'enable' });
    const excluded = transitionKnowledgePolicy(enabled, { action: 'exclude', origin: site });
    const disabled = transitionKnowledgePolicy(excluded, { action: 'disable' });
    expect([initial.generation, enabled.generation, excluded.generation, disabled.generation]).toEqual([0, 1, 2, 3]);
    expect(initial.enabled).toBe(false);
    expect(enabled.excluded).toEqual([]);
    expect(permitsKnowledge(disabled, memory, site)).toBe(false);
  });

  it('refuses noncanonical or unsafe site origins', () => {
    for (const origin of ['https://example.invalid/path', 'file:///secret', 'https://user:pass@example.invalid']) {
      expect(() => transitionKnowledgePolicy(defaultKnowledgePolicy(), { action: 'exclude', origin })).toThrow();
    }
  });

  it('refuses an unknown policy action at runtime', () => {
    expect(() => transitionKnowledgePolicy(defaultKnowledgePolicy(), { action: 'unexpected' } as never)).toThrow();
  });
});
