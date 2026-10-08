import { describe, expect, it } from 'vitest';
import {
  AX_INTERACTIVE_ROLES,
  MAX_NATIVE_REFS,
  applyBindings,
  axProps,
  backendIdAtPath,
  mergeFrameTrees,
  shapeAxTree,
} from '../extension/lib/ax-native.js';

type Spec = {
  role: string;
  name?: string;
  value?: string;
  description?: string;
  ignored?: boolean;
  backend?: number | null;
  props?: Record<string, unknown>;
  kids?: Spec[];
};

/** Build a flat CDP-style node list from a nested spec (ids are "1", "2", … in document order). */
function forest(root: Spec, firstId = 1): any[] {
  const nodes: any[] = [];
  let id = firstId;
  let backend = 100;
  const visit = (spec: Spec, parentId?: string): string => {
    const nodeId = String(id++);
    const node: any = {
      nodeId,
      ignored: !!spec.ignored,
      role: { type: 'role', value: spec.role },
      name: { type: 'computedString', value: spec.name ?? '' },
      childIds: [],
      ...(spec.backend === null ? {} : { backendDOMNodeId: spec.backend ?? backend++ }),
      ...(parentId ? { parentId } : {}),
      ...(spec.value !== undefined ? { value: { type: 'string', value: spec.value } } : {}),
      ...(spec.description ? { description: { type: 'computedString', value: spec.description } } : {}),
      properties: Object.entries(spec.props ?? {}).map(([name, value]) => ({ name, value: { type: 'boolean', value } })),
    };
    nodes.push(node);
    for (const kid of spec.kids ?? []) node.childIds.push(visit(kid, nodeId));
    return nodeId;
  };
  visit(root);
  return nodes;
}

const page = (...kids: Spec[]): Spec => ({ role: 'RootWebArea', name: 'Page', backend: 1, kids });
const flat = (tree: any): any[] => {
  const out: any[] = [];
  const visit = (n: any) => {
    if (!n) return;
    if (Array.isArray(n)) { n.forEach(visit); return; }
    out.push(n);
    visit(n.children);
  };
  visit(tree);
  return out;
};

describe('shapeAxTree — compact', () => {
  it('keeps interactive nodes, landmarks and headings; promotes everything else', () => {
    const nodes = forest(page(
      { role: 'generic', kids: [
        { role: 'navigation', name: 'Main', kids: [{ role: 'link', name: 'Docs' }] },
        { role: 'paragraph', kids: [{ role: 'StaticText', name: 'plain text' }] },
        { role: 'heading', name: 'Title', props: { level: 2 } },
        { role: 'button', name: 'Save' },
      ] },
    ));
    const { tree } = shapeAxTree(nodes, { refPrefix: 'p-' });
    expect(tree).toEqual([
      { role: 'navigation', name: 'Main', ref: 'p-0', children: [{ role: 'link', name: 'Docs', ref: 'p-1' }] },
      { role: 'heading', name: 'Title', ref: 'p-2', level: 2 },
      { role: 'button', name: 'Save', ref: 'p-3' },
    ]);
  });

  it('reports value and native states, and omits false/absent ones', () => {
    const nodes = forest(page(
      { role: 'textbox', name: 'Email', value: 'a@b.c', props: { required: true, focused: true, invalid: 'true' } },
      { role: 'checkbox', name: 'Agree', props: { checked: 'true' } },
      { role: 'checkbox', name: 'Maybe', props: { checked: 'mixed' } },
      { role: 'checkbox', name: 'Off', props: { checked: 'false' } },
      { role: 'button', name: 'Menu', props: { expanded: false, disabled: true } },
      { role: 'tab', name: 'One', props: { selected: true } },
    ));
    const byName = Object.fromEntries(flat(shapeAxTree(nodes).tree).map((n) => [n.name, n]));
    expect(byName.Email).toMatchObject({ value: 'a@b.c', required: true, focused: true, invalid: true });
    expect(flat(shapeAxTree(forest(page({ role: 'textbox', name: 'Spell', props: { invalid: 'spelling' } }))).tree)[0].invalid).toBe('spelling');
    expect(byName.Agree.checked).toBe(true);
    expect(byName.Maybe.checked).toBe('mixed');
    expect(byName.Off.checked).toBe(false);
    expect(byName.Menu).toMatchObject({ expanded: false, disabled: true });
    expect(byName.One.selected).toBe(true);
    expect(byName.Agree).not.toHaveProperty('value'); // checkbox state is `checked`, not a value
    expect(byName.Save).toBeUndefined();
  });

  it('drops ignored nodes but still walks their children', () => {
    const nodes = forest(page(
      { role: 'none', ignored: true, kids: [{ role: 'button', name: 'Inside ignored wrapper' }] },
      { role: 'button', name: 'Gone', ignored: true },
    ));
    expect(flat(shapeAxTree(nodes).tree).map((n) => n.name)).toEqual(['Inside ignored wrapper']);
  });

  it('keeps a named focusable generic (a clickable <div tabindex>) as interactive', () => {
    const nodes = forest(page(
      { role: 'generic', name: 'Clickable card', props: { focusable: true } },
      { role: 'generic', name: '', props: { focusable: true } },
      { role: 'generic', name: 'Not focusable' },
    ));
    const out = flat(shapeAxTree(nodes).tree);
    expect(out).toEqual([{ role: 'generic', name: 'Clickable card', ref: 'n0' }]);
  });

  it('lists the Chrome-specific widget roles it was observed to report', () => {
    // Observed from Accessibility.getFullAXTree in Chromium for native controls.
    for (const role of ['ColorWell', 'Date', 'DateTime', 'InputTime', 'DisclosureTriangle', 'spinbutton', 'searchbox', 'combobox', 'listbox']) {
      expect(AX_INTERACTIVE_ROLES.has(role), role).toBe(true);
    }
    const { tree } = shapeAxTree(forest(page(
      { role: 'Date', name: 'Birthday' }, { role: 'InputTime', name: 'Start' }, { role: 'ColorWell', name: 'Colour' },
    )));
    expect(flat(tree).map((n) => n.role)).toEqual(['Date', 'InputTime', 'ColorWell']);
  });

  it('skips list markers and text boxes, and gives no ref to nodes with no DOM node', () => {
    const nodes = forest(page(
      { role: 'listitem', kids: [{ role: 'ListMarker', name: '• ' }, { role: 'StaticText', name: 'item' }] },
      { role: 'DisclosureTriangle', name: 'Details' },
      { role: 'button', name: 'Virtual', backend: null },
    ));
    const { tree, entries } = shapeAxTree(nodes);
    expect(flat(tree).map((n) => [n.name, n.ref])).toEqual([['Details', 'n0'], ['Virtual', undefined]]);
    expect(entries.map((e) => e.ref)).toEqual(['n0']);
    expect(flat(shapeAxTree(nodes, { compact: false }).tree).some((n) => n.name === '• ')).toBe(false);
  });

  it('returns null for a page with nothing actionable', () => {
    expect(shapeAxTree(forest(page({ role: 'paragraph', kids: [{ role: 'StaticText', name: 'hi' }] }))).tree).toBeNull();
  });
});

describe('shapeAxTree — full tree', () => {
  it('keeps structure and text, promotes wrappers, and drops text repeating its parent name', () => {
    const nodes = forest(page(
      { role: 'generic', kids: [
        { role: 'paragraph', kids: [
          { role: 'StaticText', name: 'Read the ' },
          { role: 'link', name: 'docs', kids: [{ role: 'StaticText', name: 'docs' }, { role: 'InlineTextBox', name: 'docs' }] },
        ] },
        { role: 'button', name: 'Close dialog', kids: [{ role: 'StaticText', name: 'x' }] },
      ] },
    ));
    const { tree } = shapeAxTree(nodes, { compact: false });
    expect(tree).toEqual([
      {
        role: 'paragraph',
        ref: 'n0',
        children: [
          { role: 'text', name: 'Read the' },
          { role: 'link', name: 'docs', ref: 'n1' }, // its StaticText child repeats the name: dropped
        ],
      },
      // the visible text "x" is not part of the aria-label name, so it stays
      { role: 'button', name: 'Close dialog', ref: 'n2', children: [{ role: 'text', name: 'x' }] },
    ]);
  });

  it('adds descriptions only in full mode', () => {
    const nodes = forest(page({ role: 'button', name: 'Pay', description: 'Charges your card' }));
    expect(flat(shapeAxTree(nodes, { compact: false }).tree)[0].description).toBe('Charges your card');
    expect(flat(shapeAxTree(nodes, { compact: true }).tree)[0]).not.toHaveProperty('description');
  });
});

describe('shapeAxTree — limits, scope and bookkeeping', () => {
  const many = (count: number) => forest(page(...Array.from({ length: count }, (_, i): Spec => ({ role: 'button', name: `B${i}` }))));

  it('stops at maxChars and says so', () => {
    const { tree, truncated } = shapeAxTree(many(200), { maxChars: 600 });
    expect(truncated).toBe(true);
    expect(flat(tree).length).toBeGreaterThan(0);
    expect(flat(tree).length).toBeLessThan(200);
  });

  it('honours depth (0 = top level only) and flags truncation', () => {
    const nodes = forest(page({ role: 'navigation', name: 'Nav', kids: [{ role: 'link', name: 'In' }] }));
    const { tree, truncated } = shapeAxTree(nodes, { depth: 0 });
    expect(tree).toEqual({ role: 'navigation', name: 'Nav', ref: 'n0' });
    expect(truncated).toBe(true);
  });

  it('caps nodes that get a ref and reports refLimited', () => {
    const { entries, refLimited, tree } = shapeAxTree(many(MAX_NATIVE_REFS + 25), { maxChars: 10_000_000 });
    expect(entries).toHaveLength(MAX_NATIVE_REFS);
    expect(refLimited).toBe(true);
    expect(flat(tree).filter((n) => !n.ref)).toHaveLength(25); // still listed, just not actionable
  });

  it('scopes to the subtree of a DOM node (ignored wrapper included) and reports a missing root', () => {
    const nodes = forest(page(
      { role: 'button', name: 'Outside' },
      { role: 'generic', ignored: true, backend: 777, kids: [{ role: 'button', name: 'Inside' }] },
    ));
    const scoped = shapeAxTree(nodes, { rootBackendNodeId: 777 });
    expect(flat(scoped.tree).map((n) => n.name)).toEqual(['Inside']);
    expect(scoped.rootFound).toBe(true);
    expect(shapeAxTree(nodes, { rootBackendNodeId: 424242 })).toMatchObject({ rootFound: false, tree: null });
  });

  it('marks nodes absent from the previous fingerprints as new', () => {
    const nodes = forest(page({ role: 'button', name: 'Old' }, { role: 'button', name: 'Fresh' }));
    const first = shapeAxTree(nodes);
    expect(first.fingerprints).toEqual(['button|Old', 'button|Fresh']);
    expect(flat(first.tree).some((n) => n.isNew)).toBe(false);
    const next = shapeAxTree(nodes.concat([]), { prevFingerprints: new Set(['button|Old']) });
    expect(flat(next.tree).filter((n) => n.isNew).map((n) => n.name)).toEqual(['Fresh']);
  });

  it('truncates long names and collapses whitespace', () => {
    const nodes = forest(page({ role: 'button', name: `  ${'word '.repeat(60)} ` }));
    const [btn] = flat(shapeAxTree(nodes).tree);
    expect(btn.name.length).toBeLessThanOrEqual(80);
    expect(btn.name).not.toMatch(/\s{2,}/);
  });
});

describe('mergeFrameTrees', () => {
  const mainNodes = () => forest(page({ role: 'Iframe', backend: 50 }, { role: 'button', name: 'Top' }));
  const frameNodes = () => forest({ role: 'RootWebArea', name: 'Frame', backend: 60, kids: [{ role: 'button', name: 'In frame', backend: 61 }] });

  it('grafts a child frame under its owner node and namespaces its ids', () => {
    const merged = mergeFrameTrees(mainNodes(), [{ nodes: frameNodes(), ownerBackendNodeId: 50 }]);
    // Same numeric ids in both frames must not collide.
    expect(new Set(merged.map((n) => n.nodeId)).size).toBe(merged.length);
    const { tree } = shapeAxTree(merged);
    expect(flat(tree).map((n) => n.name)).toEqual(['In frame', 'Top']);
  });

  it('tags nodes with the frame they came from (the bridge batches per frame)', () => {
    const merged = mergeFrameTrees(mainNodes(), [{ nodes: frameNodes(), ownerBackendNodeId: 50 }]);
    const { entries } = shapeAxTree(merged);
    expect(entries.map((e) => [e.backendNodeId, e.frame])).toEqual([[61, 1], [100, 0]]);
  });

  it('ignores a frame whose owner is not in the tree and never mutates its input', () => {
    const main = mainNodes();
    const before = JSON.stringify(main);
    const merged = mergeFrameTrees(main, [{ nodes: frameNodes(), ownerBackendNodeId: 9999 }]);
    expect(JSON.stringify(main)).toBe(before);
    expect(flat(shapeAxTree(merged).tree).map((n) => n.name)).toEqual(['Top']);
  });
});

describe('applyBindings', () => {
  const sample = () => [
    { role: 'link', name: 'A', ref: 'r0' },
    { role: 'navigation', ref: 'r1', children: [{ role: 'button', name: 'B', ref: 'r2' }] },
  ];

  it('removes refs the page could not bind and attaches hrefs', () => {
    expect(applyBindings(sample(), { r0: { href: '/a' }, r2: {} })).toEqual([
      { role: 'link', name: 'A', ref: 'r0', href: '/a' },
      { role: 'navigation', children: [{ role: 'button', name: 'B', ref: 'r2' }] },
    ]);
  });

  it('with dropUnbound omits interactive nodes it could not bind (browser-internal controls) and promotes their children', () => {
    // A date input: the field binds, its sub-fields and picker button live in a user-agent shadow root.
    const tree = [{ role: 'Date', name: 'Birthday', ref: 'd', children: [
      { role: 'spinbutton', name: 'Month Month', ref: 'm' },
      { role: 'spinbutton', name: 'Day Day', ref: 'y' },
      { role: 'button', name: 'Show date picker', ref: 'p' },
    ] }];
    expect(applyBindings(tree, { d: {} }, { dropUnbound: true })).toEqual({ role: 'Date', name: 'Birthday', ref: 'd' });
    // Landmarks that did not bind stay (without a ref): their bound children are still actionable.
    expect(applyBindings(sample(), { r2: {} }, { dropUnbound: true })).toEqual(
      { role: 'navigation', children: [{ role: 'button', name: 'B', ref: 'r2' }] },
    );
  });

  it('keeps unbound nodes (ref-less) in the full tree', () => {
    const tree = [{ role: 'button', name: 'Gone', ref: 'x' }];
    expect(applyBindings(tree, {})).toEqual({ role: 'button', name: 'Gone' });
  });

  it('copes with a null tree', () => {
    expect(applyBindings(null, {})).toBeNull();
    expect(applyBindings([{ role: 'button', ref: 'x' }], {}, { dropUnbound: true })).toBeNull();
  });
});

describe('axProps', () => {
  it('flattens the property list', () => {
    expect(axProps({ properties: [{ name: 'focusable', value: { value: true } }, { name: 'level', value: { value: 3 } }] }))
      .toEqual({ focusable: true, level: 3 });
    expect(axProps({})).toEqual({});
  });
});

describe('backendIdAtPath (CDP DOM.getDocument dump)', () => {
  const el = (name: string, backendNodeId: number, extra: Record<string, unknown> = {}) => ({ nodeType: 1, nodeName: name, backendNodeId, ...extra });
  const text = (backendNodeId: number) => ({ nodeType: 3, nodeName: '#text', backendNodeId });

  // document > html > body > [text, div#a, comment, x-host{closed shadow > section > button, UA shadow}, iframe{#document > html > body > b}]
  const dump = {
    nodeType: 9, nodeName: '#document', backendNodeId: 1,
    children: [
      { nodeType: 10, nodeName: 'html', backendNodeId: 2 },
      el('HTML', 3, { children: [
        el('HEAD', 4),
        el('BODY', 5, { children: [
          text(6),
          el('DIV', 7),
          { nodeType: 8, nodeName: '#comment', backendNodeId: 8 },
          el('X-HOST', 9, { shadowRoots: [
            { nodeType: 11, nodeName: '#document-fragment', shadowRootType: 'user-agent', backendNodeId: 10, children: [el('DIV', 11)] },
            { nodeType: 11, nodeName: '#document-fragment', shadowRootType: 'closed', backendNodeId: 12, children: [el('SECTION', 13, { children: [el('BUTTON', 14)] })] },
          ] }),
          el('IFRAME', 15, { contentDocument: { nodeType: 9, nodeName: '#document', backendNodeId: 16, children: [el('HTML', 17, { children: [el('BODY', 18, { children: [el('B', 19)] })] })] } }),
        ] }),
      ] }),
    ],
  };

  it('counts element children only (text, comments and doctype do not shift indexes)', () => {
    expect(backendIdAtPath(dump, [0], 'HTML')).toBe(3);
    expect(backendIdAtPath(dump, [0, 1, 0], 'DIV')).toBe(7);
  });

  it('enters the author shadow root, never the user-agent one', () => {
    expect(backendIdAtPath(dump, [0, 1, 1, -1, 0, 0], 'BUTTON')).toBe(14);
  });

  it('enters iframe content documents', () => {
    expect(backendIdAtPath(dump, [0, 1, 2, -2, 0, 0, 0], 'B')).toBe(19);
  });

  it('rejects a path that ends on the wrong tag, off the tree, or on a non-element', () => {
    expect(backendIdAtPath(dump, [0, 1, 0], 'SPAN')).toBeNull();
    expect(backendIdAtPath(dump, [0, 9], 'DIV')).toBeNull();
    expect(backendIdAtPath(dump, [0, 1, 0, -1], 'DIV')).toBeNull();
    expect(backendIdAtPath(dump, [], 'DIV')).toBeNull(); // the document itself
  });
});
