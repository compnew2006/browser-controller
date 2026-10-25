/*
 * Read-only symbol inventory, duplicate-shape detector and module graph
 * for real-browser-mcp. Uses the project's own @babel/parser (already installed).
 * No files are written into the project; output goes to OUT.
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = process.argv[2];
const OUT = process.argv[3];
const parser = require(path.join(ROOT, 'node_modules/@babel/parser'));

// `docs` is skipped so the audit measures the product, not its own report: this
// tooling lives in docs/audit/tools and would otherwise count its own symbols.
const SKIP_DIRS = new Set(['node_modules', '.git', 'coverage', 'graphify-out', 'store-assets', 'assets', 'deploy', 'dist', '.codebase-memory', '.serena', 'docs']);

function walk(dir, acc = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(full, acc);
    } else if (/\.(ts|js|mjs|cjs)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) {
      acc.push(full);
    }
  }
  return acc;
}

const files = walk(ROOT).sort();
const symbols = [];
const modules = [];
const fileTokens = new Map();   // rel -> [{start,end,label,keyword,text}]
const parseFailures = [];

const COMPLEXITY_KEYWORDS = new Set(['if', 'for', 'while', 'case', 'catch', 'switch']);
const COMPLEXITY_PUNCT = new Set(['&&', '||', '??', '?']);

function rel(p) { return path.relative(ROOT, p); }

function parseFile(file) {
  const source = fs.readFileSync(file, 'utf8');
  const isTs = file.endsWith('.ts');
  const ast = parser.parse(source, {
    sourceType: 'module',
    allowReturnOutsideFunction: true,
    errorRecovery: false,
    tokens: true,
    plugins: isTs ? ['typescript'] : ['jsx'],
  });
  return { source, ast, tokens: ast.tokens };
}

function lineOf(source, index) {
  let line = 1;
  for (let i = 0; i < index; i++) if (source.charCodeAt(i) === 10) line++;
  return line;
}

function firstBodyLine(source, start, end) {
  const text = source.slice(start, end);
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  // skip the opening brace line and closing brace line
  const inner = lines.slice(1, lines.length - 1);
  const pick = inner.find((l) => !l.startsWith('//') && !l.startsWith('/*') && !l.startsWith('*'));
  if (!pick) return '';
  return pick.length > 82 ? pick.slice(0, 79) + '...' : pick;
}

function bodySlice(node, source) {
  const body = node.body;
  if (!body) return '';
  const text = source.slice(body.start, body.end);
  return text.startsWith('{') ? text.slice(1, -1) : text;
}

function fingerprint(tokens, start, end) {
  const literal = [];
  const shape = [];
  let identifiers = 0;
  let complexity = 1;
  let calls = 0;
  let awaits = 0;
  for (const t of tokens) {
    if (t.start < start || t.end > end) continue;
    const label = t.type.label;
    const keyword = t.type.keyword;
    if (label === 'name' && !keyword) { identifiers++; literal.push('$' + t.value); shape.push('I'); continue; }
    if (label === 'privateName') { literal.push('$' + t.value.slice(1)); shape.push('I'); continue; }
    if (label === 'string' || label === 'template' || label === 'regexp') { literal.push('S'); shape.push('S'); continue; }
    if (label === 'num' || label === 'bigint') { literal.push('N'); shape.push('N'); continue; }
    const text = keyword || (t.value !== undefined ? String(t.value) : label);
    if (keyword && COMPLEXITY_KEYWORDS.has(keyword)) complexity++;
    if (COMPLEXITY_PUNCT.has(text)) complexity++;
    if (text === '(') calls++;
    if (text === 'await') awaits++;
    literal.push('$' + text);
    shape.push(text);
  }
  return { literalKey: literal.join('\u0001'), shapeKey: shape.join('\u0001'), tokenCount: literal.length, identifiers, complexity, calls, awaits };
}

function isFunctionNode(node) {
  return node && (node.type === 'ArrowFunctionExpression' || node.type === 'FunctionExpression' || node.type === 'FunctionDeclaration' || node.type === 'ObjectMethod' || node.type === 'ClassMethod' || node.type === 'ClassPrivateMethod');
}

function memberName(node) {
  const key = node.key;
  if (!key) return '<anonymous>';
  if (key.type === 'Identifier') return key.name;
  if (key.type === 'StringLiteral') return key.value;
  if (key.type === 'PrivateName') return '#' + key.id.name;
  return '<computed>';
}


function leadingComment(source, start) {
  const before = source.slice(0, start);
  const lines = before.split('\n');
  // drop the partial line the symbol starts on
  lines.pop();
  let i = lines.length - 1;
  while (i >= 0 && lines[i].trim() === '') { i--; if (lines.length - 1 - i > 2) return ''; }
  if (i < 0) return '';
  const collected = [];
  if (lines[i].trim().endsWith('*/')) {
    while (i >= 0) {
      collected.unshift(lines[i].trim());
      if (lines[i].trim().startsWith('/*')) break;
      i--;
      if (collected.length > 12) break;
    }
  } else if (lines[i].trim().startsWith('//')) {
    while (i >= 0 && lines[i].trim().startsWith('//')) { collected.unshift(lines[i].trim()); i--; }
  } else {
    return '';
  }
  return collected.join(' ').replace(/^\/\*\*?/, '').replace(/\*\/$/, '').replace(/^\/\//, '').replace(/\s*\*\s?/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 240);
}

function addSymbol(ctx, node, name, kind, owner, exported, extra = {}) {
  const { source, tokens } = ctx;
  const bodyStart = node.body ? node.body.start : node.start;
  const fp = fingerprint(tokens, bodyStart, node.end);
  const body = bodySlice(node, source);
  symbols.push({
    file: ctx.rel,
    name,
    kind,
    owner: owner || null,
    line: lineOf(source, node.start),
    endLine: lineOf(source, node.end),
    loc: lineOf(source, node.end) - lineOf(source, node.start) + 1,
    bodyLoc: body ? body.split('\n').length : 0,
    params: Array.isArray(node.params) ? node.params.length : 0,
    exported: !!exported,
    async: !!node.async || !!node.generator === !!node.generator && !!node.async,
    generator: !!node.generator,
    hasAwait: fp.awaits > 0,
    complexity: fp.complexity,
    tokens: fp.tokenCount,
    doc: leadingComment(ctx.source, node.start),
    body1: node.body ? firstBodyLine(ctx.source, node.body.start, node.body.end) : '',
    bodyLoc: body ? body.split('\n').filter((l) => l.trim()).length : 0,
    identifiers: fp.identifiers,
    calls: fp.calls,
    literalKey: fp.literalKey,
    shapeKey: fp.shapeKey,
    ...extra,
  });
}

function visit(ctx, node, owner) {
  if (!node || typeof node.type !== 'string') return;

  switch (node.type) {
    case 'FunctionDeclaration': {
      if (!node.id) break;
      addSymbol(ctx, node, node.id.name, 'function', owner, ctx.exported.has(node));
      break;
    }
    case 'TSDeclareFunction':
      break;
    case 'ClassDeclaration':
    case 'ClassExpression': {
      const name = node.id ? node.id.name : '<anonymous class>';
      addSymbol(ctx, node, name, 'class', owner, ctx.exported.has(node), {
        members: node.body.body.length,
        extends: node.superClass && node.superClass.type === 'Identifier' ? node.superClass.name : (node.superClass ? '<expr>' : null),
      });
      for (const member of node.body.body) {
        if (member.type === 'ClassMethod' || member.type === 'ClassPrivateMethod') {
          const kind = member.kind === 'constructor' ? 'constructor' : member.kind === 'get' ? 'getter' : member.kind === 'set' ? 'setter' : 'method';
          addSymbol(ctx, member, memberName(member), kind, name, ctx.exported.has(node), { static: !!member.static, accessibility: member.accessibility || 'public' });
        } else if ((member.type === 'ClassProperty' || member.type === 'PropertyDefinition') && isFunctionNode(member.value)) {
          addSymbol(ctx, member.value, memberName(member), 'property-function', name, ctx.exported.has(node), { static: !!member.static, accessibility: member.accessibility || 'public' });
        }
      }
      break;
    }
    case 'VariableDeclarator': {
      if (isFunctionNode(node.init)) {
        const name = node.id.type === 'Identifier' ? node.id.name : '<pattern>';
        addSymbol(ctx, node.init, name, 'const-function', owner, ctx.exported.has(node.init));
      }
      break;
    }
    case 'ExportDefaultDeclaration': {
      if (isFunctionNode(node.declaration)) addSymbol(ctx, node.declaration, 'export default', 'const-function', owner, true);
      break;
    }
    case 'ObjectProperty': {
      if (isFunctionNode(node.value)) addSymbol(ctx, node.value, memberName(node), 'object-function', owner, false);
      break;
    }
    case 'ObjectMethod': {
      const kind = node.kind === 'get' ? 'getter' : node.kind === 'set' ? 'setter' : 'object-function';
      addSymbol(ctx, node, memberName(node), kind, owner, false);
      break;
    }
    default:
      break;
  }

  for (const key of Object.keys(node)) {
    if (key === 'tokens' || key === 'loc' || key === 'leadingComments' || key === 'trailingComments' || key === 'innerComments') continue;
    const value = node[key];
    if (Array.isArray(value)) {
      for (const child of value) if (child && typeof child.type === 'string') visit(ctx, child, owner);
    } else if (value && typeof value.type === 'string') {
      visit(ctx, value, owner);
    }
  }
}

for (const file of files) {
  const relPath = rel(file);
  let parsed;
  try {
    parsed = parseFile(file);
  } catch (error) {
    parseFailures.push({ file: relPath, error: String(error.message).slice(0, 200) });
    continue;
  }
  const { ast, tokens, source } = parsed;
  fileTokens.set(relPath, tokens.map((t) => ({ start: t.start, end: t.end, label: t.type.label, keyword: t.type.keyword, text: t.value !== undefined ? String(t.value) : t.type.label })));

  const exported = new Set();
  const imports = [];
  const exportedNames = [];
  const requireCalls = [];

  for (const node of ast.program.body) {
    let target = node;
    let isExport = false;
    if (node.type === 'ExportNamedDeclaration' || node.type === 'ExportDefaultDeclaration') {
      isExport = true;
      target = node.declaration || node;
      exported.add(node.declaration);
      if (node.type === 'ExportNamedDeclaration' && node.specifiers) {
        for (const spec of node.specifiers) if (spec.exported) exportedNames.push(spec.exported.name || spec.exported.value);
      }
    }
    if (isExport) {
      if (target.type === 'FunctionDeclaration' && target.id) exportedNames.push(target.id.name);
      if (target.type === 'ClassDeclaration' && target.id) exportedNames.push(target.id.name);
      if (target.type === 'VariableDeclaration') {
        for (const decl of target.declarations) if (decl.id.type === 'Identifier') exportedNames.push(decl.id.name);
      }
      if (node.declaration) exported.add(node.declaration);
    }
    if (node.type === 'ImportDeclaration') imports.push({ source: node.source.value, kind: 'import', names: node.specifiers.length });
    if (node.type === 'ExportAllDeclaration') imports.push({ source: node.source.value, kind: 're-export', names: 0 });
    if (node.type === 'ExportNamedDeclaration' && node.source) imports.push({ source: node.source.value, kind: 're-export', names: node.specifiers ? node.specifiers.length : 0 });
  }

  const collectRequires = (node) => {
    if (!node || typeof node.type !== 'string') return;
    if (node.type === 'CallExpression' && node.callee.type === 'Identifier' && node.callee.name === 'require' && node.arguments[0] && node.arguments[0].type === 'StringLiteral') {
      requireCalls.push(node.arguments[0].value);
      imports.push({ source: node.arguments[0].value, kind: 'require', names: 0 });
    }
    if (node.type === 'ImportExpression' && node.source && node.source.type === 'StringLiteral') {
      imports.push({ source: node.source.value, kind: 'dynamic-import', names: 0 });
    }
    for (const key of Object.keys(node)) {
      if (key === 'loc' || key === 'tokens') continue;
      const value = node[key];
      if (Array.isArray(value)) for (const child of value) if (child && typeof child.type === 'string') collectRequires(child);
      else if (value && typeof value.type === 'string') collectRequires(value);
    }
  };
  collectRequires(ast.program);

  const ctx = { rel: relPath, source, tokens, exported };
  visit(ctx, ast.program, null);

  modules.push({
    file: relPath,
    lines: source.split('\n').length,
    exports: [...new Set(exportedNames)],
    imports: imports.filter((i) => i.source.startsWith('.')),
    externalImports: [...new Set(imports.filter((i) => !i.source.startsWith('.')).map((i) => i.source))],
    requireCalls: [...new Set(requireCalls)],
  });
}

// ---- duplicate detection -------------------------------------------------
const MIN_TOKENS = 14;
const byLiteral = new Map();
const byShape = new Map();
for (const s of symbols) {
  if (s.kind === 'class') continue;
  if (s.tokens < MIN_TOKENS) continue;
  if (!byLiteral.has(s.literalKey)) byLiteral.set(s.literalKey, []);
  byLiteral.get(s.literalKey).push(s);
  if (!byShape.has(s.shapeKey)) byShape.set(s.shapeKey, []);
  byShape.get(s.shapeKey).push(s);
}

const trim = (s) => ({ file: s.file, name: s.name, owner: s.owner, kind: s.kind, line: s.line, endLine: s.endLine, tokens: s.tokens, complexity: s.complexity, params: s.params, loc: s.loc });
const exact = [...byLiteral.values()].filter((g) => g.length > 1).map((g) => ({ kind: 'identical', tokens: g[0].tokens, members: g.map(trim) }))
  .sort((a, b) => b.tokens - a.tokens);
const shape = [...byShape.values()].filter((g) => g.length > 1).map((g) => ({ kind: 'same-shape', tokens: g[0].tokens, members: g.map(trim) }))
  .filter((g) => !exact.some((e) => e.members.length === g.members.length && e.members.every((m, i) => m.file === g.members[i].file && m.line === g.members[i].line)))
  .sort((a, b) => b.tokens - a.tokens);

// ---- export usage -------------------------------------------------------
const tokenIndex = new Map();
for (const [file, tokens] of fileTokens) {
  const names = new Map();
  for (const t of tokens) if (t.label === 'name' && !t.keyword) names.set(t.text, (names.get(t.text) || 0) + 1);
  tokenIndex.set(file, names);
}
const unusedExports = [];
const testOnlyExports = [];
const isTestFile = (file) => file.startsWith('tests/') || file.includes('.test.') || file.includes('.spec.');
for (const mod of modules) {
  for (const name of mod.exports) {
    let usedInProd = 0;
    let usedInTests = 0;
    for (const [file, names] of tokenIndex) {
      if (file === mod.file) continue;
      const hits = names.get(name) || 0;
      if (!hits) continue;
      if (isTestFile(file)) usedInTests += hits;
      else usedInProd += hits;
    }
    if (usedInProd === 0 && usedInTests === 0) unusedExports.push({ file: mod.file, name });
    else if (usedInProd === 0) testOnlyExports.push({ file: mod.file, name, testHits: usedInTests });
  }
}

// ---- module graph -------------------------------------------------------
const byRelPath = new Map(modules.map((m) => [m.file, m]));
const edges = [];
for (const mod of modules) {
  for (const imp of mod.imports) {
    let target = imp.source;
    const base = path.dirname(path.join(ROOT, mod.file));
    let resolved = path.resolve(base, imp.source);
    const candidates = [resolved];
    // TypeScript sources import `./x.js` but the file on disk is `./x.ts`.
    if (resolved.endsWith('.js')) candidates.push(resolved.slice(0, -3) + '.ts');
    if (resolved.endsWith('.mjs')) candidates.push(resolved.slice(0, -4) + '.ts');
    candidates.push(resolved + '.ts', resolved + '.js', resolved + '.mjs', path.join(resolved, 'index.ts'), path.join(resolved, 'index.js'));
    let found = null;
    for (const candidate of candidates) {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) { found = rel(candidate); break; }
    }
    edges.push({ from: mod.file, to: found || target, kind: imp.kind, resolved: !!found });
  }
}

const summary = { files: files.length, symbols: symbols.length, parseFailures: parseFailures.length, modules: modules.length, edges: edges.length };

fs.writeFileSync(path.join(OUT, 'symbols.json'), JSON.stringify(symbols.map(({ literalKey, shapeKey, ...rest }) => rest), null, 1));
fs.writeFileSync(path.join(OUT, 'dups.json'), JSON.stringify({ exact, shape }, null, 1));
fs.writeFileSync(path.join(OUT, 'modules.json'), JSON.stringify({ modules, edges, unusedExports, testOnlyExports }, null, 1));
fs.writeFileSync(path.join(OUT, 'summary.json'), JSON.stringify(summary, null, 2));
fs.writeFileSync(path.join(OUT, 'parse-failures.json'), JSON.stringify(parseFailures, null, 2));

console.log(JSON.stringify({
  ...summary,
  kindCounts: symbols.reduce((acc, s) => { acc[s.kind] = (acc[s.kind] || 0) + 1; return acc; }, Object.create(null)),
  exactGroups: exact.length,
  exactMembers: exact.reduce((n, g) => n + g.members.length, 0),
  shapeGroups: shape.length,
  shapeMembers: shape.reduce((n, g) => n + g.members.length, 0),
  unusedExports: unusedExports.length,
  testOnlyExports: testOnlyExports.length,
}, null, 2));
