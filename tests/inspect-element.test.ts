import { describe, expect, it } from 'vitest';

const {
  shapeMatchedStyles, shapeListeners, formatRules, formatListeners, formatStyles, renderInspect, describeNode, nodesAtPath,
} = await import('../extension/lib/inspect-element.js');

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
      rule('#go.btn', [decl('color', 'blue', { important: true }), implicit('color', 'blue', { important: true })], { line: 2 }),
    ],
    inherited: [
      { matchedCSSRules: [rule('.wrap', [decl('font-size', '20px'), decl('color', 'purple'), decl('display', 'flex'), implicit('font-size', '20px'), implicit('color', 'purple'), implicit('display', 'flex')], { line: 3 })] },
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
    expect(shaped.rules[1]).toEqual({ selector: '#go.btn', source: 'https://app.test/:7', decls: [{ name: 'color', value: 'blue', important: true }] });
    expect(shaped.rules[2]).toEqual({
      selector: '.btn', source: 'https://app.test/site.css:1', media: '(min-width: 100px)',
      decls: [{ name: 'cursor', value: 'pointer' }, { name: 'colr', value: 'blue', invalid: true }],
    });
    expect(shaped.rules[0]).toEqual({ selector: 'element.style', decls: [{ name: 'margin-left', value: '3px' }] });
  });

  it('marks what lost the cascade: later rules, the inline style and !important win', () => {
    expect(shaped.rules[3]).toEqual({
      selector: '.btn', source: 'https://app.test/:6',
      decls: [{ name: 'color', value: 'red', overridden: true }, { name: 'margin', value: '0' }], // margin keeps 3 of 4 sides, so it still applies
    });
  });

  it('keeps only inherited properties from ancestors, nearest first, and marks what the element or a nearer ancestor sets', () => {
    expect(shaped.inherited).toEqual([
      { from: 'div.wrap', selector: '.wrap', source: 'https://app.test/:8', decls: [{ name: 'font-size', value: '20px' }, { name: 'color', value: 'purple', overridden: true }] },
      { from: 'body', selector: 'element.style', decls: [{ name: 'font-size', value: '12px', overridden: true }, { name: 'letter-spacing', value: '1px' }] },
    ]);
  });

  it('includes author pseudo-element rules', () => {
    expect(shaped.pseudo).toEqual([{ pseudo: '::before', selector: '.btn::before', source: 'https://app.test/:10', decls: [{ name: 'content', value: '"*"' }] }]);
  });

  it('leaves out empty sections', () => {
    const plain = shapeMatchedStyles({ matchedCSSRules: [rule('.x', [decl('color', 'red')])], inherited: [] }, { sheets, ancestors: [] });
    expect(plain.inherited).toBeUndefined();
    expect(plain.pseudo).toBeUndefined();
  });
});

describe('formatRules (text)', () => {
  const shaped = shapeMatchedStyles({
    inlineStyle: { cssProperties: [decl('margin-left', '3px'), implicit('margin-left', '3px')] },
    matchedCSSRules: [
      rule('.btn', [decl('color', 'red'), implicit('color', 'red')], { line: 1 }),
      rule('#go.btn', [decl('color', 'blue', { important: true }), implicit('color', 'blue', { important: true })], { line: 2 }),
      rule('.btn', [decl('cursor', 'pointer'), decl('colr', 'blue', { parsedOk: false }), implicit('cursor', 'pointer')], { sheet: 's2', line: 0, media: ['(min-width: 100px)'] }),
    ],
    inherited: [],
  }, { sheets, ancestors: [] });

  it('one head line per rule, highest priority first (selector, file:line, media), declarations indented under it, overridden and invalid marked', () => {
    expect(formatRules(shaped).rules).toEqual([
      'element.style',
      '  margin-left: 3px',
      '.btn  https://app.test/site.css:1  @media (min-width: 100px)',
      '  cursor: pointer',
      '  colr: blue (invalid, ignored)',
      '#go.btn  https://app.test/:7',
      '  color: blue !important',
      '.btn  https://app.test/:6',
      '  color: red (overridden)',
    ]);
  });

  it('says so when no author rule matches, and caps a long declaration list', () => {
    expect(formatRules({ rules: [] }).rules).toEqual(['(no author rules match)']);
    const long = shapeMatchedStyles({ matchedCSSRules: [rule('.x', Array.from({ length: 80 }, (_, i) => decl(`--v${i}`, 'x'.repeat(20))))], inherited: [] }, { sheets, ancestors: [] });
    const lines = formatRules(long).rules;
    expect(lines[0]).toBe('.x  https://app.test/:5');
    expect(lines.at(-1)).toMatch(/^ {2}… \d+ more$/);
    expect(lines.filter((l) => l.includes('… ')).length).toBe(1); // one marker, not one per dropped declaration
    expect(lines.slice(1, -1).join('\n').length).toBeLessThanOrEqual(600 + 80);
  });

  it('labels inherited entries with the ancestor they come from, or the level when unknown', () => {
    const f = formatRules({ rules: [], inherited: [{ from: 'div.wrap', selector: '.wrap', decls: [{ name: 'color', value: 'purple' }] }, { level: 2, selector: 'element.style', decls: [{ name: 'font-size', value: '12px' }] }] });
    expect(f.inherited).toEqual(['.wrap  (inherited from div.wrap)', '  color: purple', 'element.style  (inherited from level 2)', '  font-size: 12px']);
  });
});

describe('listeners', () => {
  const scripts = new Map([['7', 'https://app.test/app.js'], ['8', '']]);

  it('own listeners: type, script URL and line (1-based), flags', () => {
    const own = shapeListeners([
      { type: 'click', useCapture: false, scriptId: '7', lineNumber: 11, columnNumber: 4 },
      { type: 'keydown', useCapture: true, passive: true, once: true, scriptId: '8', lineNumber: 0, columnNumber: 0 },
    ], scripts);
    expect(own).toEqual([
      { type: 'click', where: 'https://app.test/app.js:12', flags: [] },
      { type: 'keydown', where: 'inline:1', flags: ['capture', 'passive', 'once'] },
    ]);
  });

  it('delegated listeners name their ancestor; a script the page never announced is "unknown script"', () => {
    const delegated = shapeListeners([{ type: 'click', useCapture: false, scriptId: '99', lineNumber: 3 }], scripts, 'div.menu');
    expect(delegated).toEqual([{ type: 'click', where: 'unknown script:4', flags: ['on div.menu'] }]);
  });

  it('formatListeners: own first, then ancestors; capped at 30 lines with the rest counted', () => {
    const own = shapeListeners([{ type: 'click', useCapture: false, scriptId: '7', lineNumber: 0 }], scripts);
    const delegated = shapeListeners([{ type: 'focus', useCapture: true, scriptId: '7', lineNumber: 1 }], scripts, 'document');
    expect(formatListeners({ own, delegated })).toEqual(['click  https://app.test/app.js:1', 'focus  https://app.test/app.js:2 (capture, on document)']);
    expect(formatListeners({ own: [], delegated: [] })).toEqual(['(no listeners)']);
    const many = shapeListeners(Array.from({ length: 50 }, (_, i) => ({ type: `t${i}`, useCapture: false, scriptId: '7', lineNumber: 0 })), scripts);
    const lines = formatListeners({ own: many, delegated: [] });
    expect(lines).toHaveLength(31);
    expect(lines.at(-1)).toBe('… 20 more');
  });
});

describe('styles and the whole answer (text)', () => {
  it('formatStyles: prop: value lines; an empty default view and an empty property list each say so', () => {
    expect(formatStyles({ color: 'red', nope: '' })).toEqual(['color: red', 'nope: (unknown property)']);
    expect(formatStyles({})).toEqual(['(no computed style differs from the defaults)']);
    expect(formatStyles({}, true)).toEqual(['(no properties)']);
  });

  it('renderInspect: a lone styles section is bare; with more, each section has its title line', () => {
    const element = { tag: 'button', id: 'go', classes: ['btn'], text: 'Go', box: { x: 96, y: 196, width: 58, height: 38 } };
    expect(renderInspect(element, [{ title: 'styles', lines: ['color: red'] }])).toBe('button#go.btn "Go" box 96,196 58x38\ncolor: red');
    expect(renderInspect({ tag: 'div', box: { x: 0, y: 0, width: 1, height: 2 } }, [
      { title: 'rules', lines: ['.x'] }, { title: 'listeners', lines: ['(no listeners)'] },
    ])).toBe('div box 0,0 1x2\nrules:\n.x\nlisteners:\n(no listeners)');
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
