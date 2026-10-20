import { describe, expect, it } from 'vitest';

const { shapeMatchedStyles, shapeListeners, listenerTypes, describeNode, nodesAtPath } = await import('../extension/lib/inspect-element.js');

/** A CDP CSSProperty: declared (in the source text) or an implicit longhand expansion. */
const decl = (name: string, value: string, extra: object = {}) => ({ name, value, text: `${name}: ${value}`, range: { startLine: 0, startColumn: 0, endLine: 0, endColumn: 1 }, ...extra });
const implicit = (name: string, value: string, extra: object = {}) => ({ name, value, ...extra });
const rule = (selector: string, props: object[], { origin = 'regular', sheet = 's1', line = 0, media = undefined as string[] | undefined } = {}) => ({
  rule: {
    origin, styleSheetId: origin === 'regular' ? sheet : undefined,
    selectorList: { selectors: [{ text: selector }], text: selector },
    style: { cssProperties: props, ...(origin === 'regular' ? { range: { startLine: line, startColumn: 0, endLine: line, endColumn: 9 } } : {}) },
    ...(media ? { media: media.map((text) => ({ text })) } : {}),
  },
  matchingSelectors: [0],
});
const sheets = new Map([['s1', { url: 'https://app.test/', startLine: 4 }], ['s2', { url: 'https://app.test/site.css', startLine: 0 }]]);

describe('shapeMatchedStyles (CSS.getMatchedStylesForNode → compact cascade)', () => {
  const matched = {
    inlineStyle: { cssProperties: [decl('margin-left', '3px'), implicit('margin-left', '3px')] },
    matchedCSSRules: [
      rule('button', [implicit('color', 'buttontext'), implicit('cursor', 'default')], { origin: 'user-agent' }),
      rule('.btn', [
        decl('color', 'red'), decl('margin', '0', { longhandProperties: [{ name: 'margin-top' }, { name: 'margin-right' }, { name: 'margin-bottom' }, { name: 'margin-left' }] }),
        implicit('color', 'red'), implicit('margin-top', '0px'), implicit('margin-right', '0px'), implicit('margin-bottom', '0px'), implicit('margin-left', '0px'),
      ], { line: 1 }),
      rule('.btn', [decl('cursor', 'pointer'), decl('colr', 'blue', { parsedOk: false }), implicit('cursor', 'pointer')], { sheet: 's2', line: 0, media: ['(min-width: 100px)'] }),
      rule('#go.btn', [decl('color', 'blue !important', { important: true }), implicit('color', 'blue', { important: true })], { line: 2 }),
    ],
    inherited: [
      {
        matchedCSSRules: [rule('.wrap', [decl('font-size', '20px'), decl('color', 'purple'), decl('display', 'flex'), implicit('font-size', '20px'), implicit('color', 'purple'), implicit('display', 'flex')], { line: 3 })],
      },
      {
        inlineStyle: { cssProperties: [decl('font-size', '12px'), decl('letter-spacing', '1px'), implicit('font-size', '12px'), implicit('letter-spacing', '1px')] },
        matchedCSSRules: [],
      },
    ],
    pseudoElements: [{ pseudoType: 'before', matches: [rule('.btn::before', [decl('content', '"*"'), implicit('content', '"*"')], { line: 5 })] }],
  };
  const shaped = shapeMatchedStyles(matched, { sheets, ancestors: ['div.wrap', 'body'] });

  it('lists author rules highest priority first, element.style on top, with source lines and media', () => {
    expect(shaped.rules.map((r: any) => r.selector)).toEqual(['element.style', '#go.btn', '.btn', '.btn']);
    expect(shaped.rules[1]).toEqual({ selector: '#go.btn', source: 'https://app.test/:7', style: 'color: blue !important' });
    expect(shaped.rules[2]).toMatchObject({ source: 'https://app.test/site.css:1', media: '(min-width: 100px)', style: 'cursor: pointer; colr: blue', invalid: ['colr'] });
    expect(shaped.rules[0]).toEqual({ selector: 'element.style', style: 'margin-left: 3px' });
  });

  it('marks what lost the cascade: later rules, the inline style and !important win', () => {
    const btn = shaped.rules[3];
    expect(btn).toMatchObject({ selector: '.btn', source: 'https://app.test/:6', style: 'color: red; margin: 0' });
    expect(btn.overridden).toEqual(['color']); // #go.btn !important; margin keeps 3 of 4 sides, so it still applies
    expect(shaped.rules[1].overridden).toBeUndefined();
  });

  it('keeps only inherited properties from ancestors, nearest first, and marks what the element or a nearer ancestor sets', () => {
    expect(shaped.inherited).toEqual([
      { from: 'div.wrap', selector: '.wrap', source: 'https://app.test/:8', style: 'font-size: 20px; color: purple', overridden: ['color'] },
      { from: 'body', selector: 'element.style', style: 'font-size: 12px; letter-spacing: 1px', overridden: ['font-size'] },
    ]);
  });

  it('includes author pseudo-element rules', () => {
    expect(shaped.pseudo).toEqual([{ pseudo: '::before', selector: '.btn::before', source: 'https://app.test/:10', style: 'content: "*"' }]);
  });

  it('leaves out empty sections and caps long style text', () => {
    const long = shapeMatchedStyles({
      matchedCSSRules: [rule('.x', Array.from({ length: 80 }, (_, i) => decl(`--v${i}`, 'x'.repeat(20))))],
      inherited: [],
    }, { sheets, ancestors: [] });
    expect(long.inherited).toBeUndefined();
    expect(long.pseudo).toBeUndefined();
    expect(long.rules[0].style.length).toBeLessThanOrEqual(601);
    expect(long.rules[0].style.endsWith('…')).toBe(true);
  });
});

describe('listeners', () => {
  const raw = [
    { type: 'click', useCapture: false, passive: false, once: false, lineNumber: 0, columnNumber: 4, handler: { description: 'function onclick(event) {\nx()\n}' } },
    { type: 'keydown', useCapture: true, passive: true, once: true, lineNumber: 11, columnNumber: 0, handler: { description: `(e) => { ${'y'.repeat(200)} }` } },
  ];

  it('shapes the element\'s own listeners compactly', () => {
    const [click, key] = shapeListeners(raw);
    expect(click).toEqual({ type: 'click', handler: 'function onclick(event) { x() }', line: 1, column: 5 });
    expect(key).toMatchObject({ type: 'keydown', capture: true, passive: true, once: true, line: 12 });
    expect(key.handler.length).toBeLessThanOrEqual(121);
  });

  it('summarizes delegated listeners as unique types', () => {
    expect(listenerTypes([...raw, { ...raw[0] }])).toEqual(['click', 'keydown (capture)']);
    const many = Array.from({ length: 50 }, (_, i) => ({ type: `t${i}`, useCapture: false }));
    const types = listenerTypes(many);
    expect(types).toHaveLength(31);
    expect(types.at(-1)).toBe('…+20 more');
  });
});

describe('DOM helpers', () => {
  const el = (nodeName: string, attributes: string[] = [], extra: object = {}) => ({ nodeType: 1, nodeName, attributes, ...extra });
  it('describes a node as tag#id.classes', () => {
    expect(describeNode(el('BUTTON', ['id', 'go', 'class', 'btn  primary', 'type', 'submit']))).toBe('button#go.btn.primary');
    expect(describeNode(el('DIV'))).toBe('div');
    // An attribute VALUE equal to "class"/"id" must not be mistaken for the attribute.
    expect(describeNode(el('DIV', ['data-role', 'class', 'class', 'btn primary']))).toBe('div.btn.primary');
    expect(describeNode(el('A', ['title', 'id', 'id', 'go']))).toBe('a#go');
  });

  it('flags a flat tree that differs from the DOM chain (slotted light-DOM content)', () => {
    const slotted = el('SPAN', [], { backendNodeId: 3 });
    const host = el('MY-CARD', [], { backendNodeId: 2, children: [slotted], shadowRoots: [{ shadowRootType: 'open', children: [] }] });
    const plain = el('P', [], { backendNodeId: 4 });
    const root = { nodeType: 9, children: [el('BODY', [], { backendNodeId: 1, children: [host, plain] })] };
    expect(nodesAtPath(root, [0, 0, 0], 'span').flatTreeDiffers).toBe(true);
    expect(nodesAtPath(root, [0, 1], 'p').flatTreeDiffers).toBe(false);
  });

  it('walks a structural path to the target and its ancestors within its own document', () => {
    const target = el('SPAN', [], { backendNodeId: 9 });
    const host = el('MY-CARD', [], { backendNodeId: 7, shadowRoots: [{ shadowRootType: 'open', children: [target] }] });
    const frameBody = el('BODY', [], { backendNodeId: 6, children: [host] });
    const frameDoc = { nodeType: 9, children: [el('HTML', [], { backendNodeId: 5, children: [el('HEAD'), frameBody] })] };
    const iframe = el('IFRAME', [], { backendNodeId: 4, contentDocument: frameDoc });
    const root = { nodeType: 9, children: [el('HTML', [], { backendNodeId: 1, children: [el('HEAD'), el('BODY', [], { backendNodeId: 3, children: [iframe] })] })] };
    const found = nodesAtPath(root, [0, 1, 0, -2, 0, 1, 0, -1, 0], 'span');
    expect(found.target.backendNodeId).toBe(9);
    expect(found.ancestors.map((n: any) => n.backendNodeId)).toEqual([7, 6, 5]); // nearest first, stops at the frame
    expect(found.flatTreeDiffers).toBe(true);
    expect(nodesAtPath(root, [0, 1, 0, -2, 0, 1, 0, -1, 0], 'div')).toBeNull();
    expect(nodesAtPath(root, [0, 5], null)).toBeNull();
  });
});
