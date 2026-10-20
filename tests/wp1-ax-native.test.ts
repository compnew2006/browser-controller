import { describe, expect, it } from 'vitest';
import { applyBindings, capTree, shapeAxTree, SECRET_MASK } from '../extension/lib/ax-native.js';

/** Flat CDP-style AX forest: one root (RootWebArea) with the given leaf nodes under it. */
function forest(leaves: Array<{ role: string; name: string; backendDOMNodeId?: number; value?: string; props?: Record<string, unknown> }>) {
  const nodes: any[] = [{ nodeId: '0', role: { value: 'RootWebArea' }, name: { value: '' }, childIds: leaves.map((_, i) => String(i + 1)) }];
  leaves.forEach((leaf, i) => {
    nodes.push({
      nodeId: String(i + 1), parentId: '0', childIds: [],
      role: { value: leaf.role }, name: { value: leaf.name },
      ...(leaf.backendDOMNodeId != null ? { backendDOMNodeId: leaf.backendDOMNodeId } : {}),
      ...(leaf.value !== undefined ? { value: { type: 'string', value: leaf.value } } : {}),
      properties: Object.entries(leaf.props ?? {}).map(([name, value]) => ({ name, value: { value } })),
    });
  });
  return nodes;
}

const jsonLength = (tree: unknown) => JSON.stringify(tree ?? null).length;

describe('native snapshot: the output cap holds after bindings', () => {
  it('links get an href only when bound, and capTree keeps the final tree inside maxChars', () => {
    const leaves = Array.from({ length: 120 }, (_, i) => ({
      role: 'link', name: `Article number ${i} with a long descriptive name`, backendDOMNodeId: 1000 + i,
    }));
    const shaped = shapeAxTree(forest(leaves), { compact: true, maxChars: 100_000, refPrefix: 'sab1' });
    const bound: Record<string, { href: string }> = {};
    for (const e of shaped.entries) bound[e.ref] = { href: `/articles/${e.ref}/with/a/long/path/segment` };
    const bindTree = applyBindings(shaped.tree, bound, { dropUnbound: true });
    expect(jsonLength(bindTree)).toBeGreaterThan(6000); // the hrefs really did grow the tree

    const maxChars = 4000;
    const { tree, truncated } = capTree(bindTree, maxChars);
    expect(truncated).toBe(true);
    expect(jsonLength(tree)).toBeLessThanOrEqual(maxChars);
    expect(JSON.stringify(tree)).toContain('Article number 0 ');
  });

  it('a tree that already fits is returned unchanged and not flagged', () => {
    const tree = { role: 'button', name: 'Save', ref: 'sab1-0' };
    expect(capTree(tree, 500)).toEqual({ tree, truncated: false });
  });
});

describe('native snapshot: password values', () => {
  it('a bound password field shows the mask, never the AX value', () => {
    const shaped = shapeAxTree(forest([{ role: 'textbox', name: 'Password', backendDOMNodeId: 7, value: 'hunter2-secret' }]), { compact: true, refPrefix: 'sab1' });
    const ref = shaped.entries[0].ref;
    const tree = applyBindings(shaped.tree, { [ref]: { secret: true, filled: true } }, { dropUnbound: false });
    expect(tree).toMatchObject({ role: 'textbox', name: 'Password', value: SECRET_MASK });
    expect(JSON.stringify(tree)).not.toContain('hunter2');
  });

  it('an empty bound password field reports no value at all', () => {
    const shaped = shapeAxTree(forest([{ role: 'textbox', name: 'Password', backendDOMNodeId: 7, value: '' }]), { compact: true, refPrefix: 'sab1' });
    const tree = applyBindings(shaped.tree, { [shaped.entries[0].ref]: { secret: true, filled: false } }, { dropUnbound: false });
    expect(tree).not.toHaveProperty('value');
  });

  it('a DOM node we could not bind (no ref left) never carries its value', () => {
    const shaped = shapeAxTree(forest([{ role: 'textbox', name: 'Token', backendDOMNodeId: 9, value: 'sk-live-123' }]), { compact: true, refPrefix: 'sab1' });
    const tree = applyBindings(shaped.tree, {}, { dropUnbound: false });
    expect(JSON.stringify(tree)).not.toContain('sk-live-123');
  });

  it('a field past the ref limit (refLimited) does not report its value either', () => {
    const leaves = Array.from({ length: 1501 }, (_, i) => ({ role: 'button', name: `B${i}`, backendDOMNodeId: 5000 + i }));
    leaves.push({ role: 'textbox', name: 'Late password', backendDOMNodeId: 9999, value: 'late-secret' } as any);
    const shaped = shapeAxTree(forest(leaves), { compact: false, refPrefix: 'sab1', maxChars: 10_000_000 });
    expect(shaped.refLimited).toBe(true);
    expect(JSON.stringify(shaped.tree)).not.toContain('late-secret');
  });
});
