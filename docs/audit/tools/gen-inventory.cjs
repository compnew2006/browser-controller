/*
 * Renders the symbol inventory markdown from symbols.json.
 * Purpose column provenance:
 *   D = taken from the doc comment in the source
 *   R = written by hand after reading the body (purposes.json, wins over D)
 *   B = no doc comment, the quoted line is the whole body
 *   N = no doc comment and a multi-statement body: derived from the identifier
 *       only, printed with "~" — a label, not a verified description
 *
 * Inputs (symbols.json, modules.json, purposes.json) are read from this
 * script's own directory. The markdown is written to argv[2], or beside the
 * script when no argument is given:
 *   node docs/audit/tools/gen-inventory.cjs docs/audit
 */
const fs = require('node:fs');
const path = require('node:path');

const BASE = __dirname;
const OUT = process.argv[2] ? path.resolve(process.argv[2]) : BASE;
const symbols = require(path.join(BASE, 'symbols.json'));

// Hand-written purposes for the symbols where a name gloss would mislead.
// Keys are "file:line". Read from source, not guessed.
const handWritten = require(path.join(BASE, 'purposes.json'));

const WORD_REPLACEMENTS = [
  [/\burl\b/g, 'URL'], [/\burls\b/g, 'URLs'], [/\bid\b/g, 'ID'], [/\bids\b/g, 'IDs'],
  [/\bui\b/g, 'UI'], [/\bws\b/g, 'WebSocket'], [/\bcss\b/g, 'CSS'], [/\bdom\b/g, 'DOM'],
  [/\bcdp\b/g, 'CDP'], [/\bhttp\b/g, 'HTTP'], [/\bjson\b/g, 'JSON'], [/\bapi\b/g, 'API'],
  [/\bttl\b/g, 'TTL'], [/\bmcp\b/g, 'MCP'], [/\bws\b/g, 'WebSocket'],
];

const PREFIXES = [
  ['handle', 'handles'],
  ['on', 'callback for'],
  ['get', 'reads'],
  ['set', 'sets'],
  ['is', 'tests whether'],
  ['has', 'tests whether there is'],
  ['can', 'tests whether it can'],
  ['should', 'decides whether to'],
  ['to', 'converts to'],
  ['from', 'builds from'],
  ['parse', 'parses'],
  ['assert', 'asserts'],
  ['ensure', 'ensures'],
  ['validate', 'validates'],
  ['normalize', 'normalises'],
  ['normalise', 'normalises'],
  ['render', 'renders'],
  ['register', 'registers'],
  ['create', 'creates'],
  ['build', 'builds'],
  ['make', 'makes'],
  ['read', 'reads'],
  ['write', 'writes'],
  ['load', 'loads'],
  ['save', 'saves'],
  ['send', 'sends'],
  ['emit', 'emits'],
  ['open', 'opens'],
  ['close', 'closes'],
  ['start', 'starts'],
  ['stop', 'stops'],
  ['wait', 'waits for'],
  ['watch', 'watches'],
  ['find', 'finds'],
  ['collect', 'collects'],
  ['detect', 'detects'],
  ['resolve', 'resolves'],
  ['require', 'throws unless'],
  ['clear', 'clears'],
  ['drop', 'drops'],
  ['forget', 'forgets'],
  ['release', 'releases'],
  ['prune', 'prunes'],
  ['restore', 'restores'],
  ['apply', 'applies'],
  ['run', 'runs'],
  ['finish', 'finishes'],
  ['sort', 'sorts'],
  ['match', 'matches'],
  ['filter', 'filters'],
  ['pick', 'picks'],
  ['map', 'maps'],
  ['with', 'wrapper that supplies'],
  ['without', 'variant that omits'],
];

function words(identifier) {
  return identifier
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/[_.$]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function gloss(symbol) {
  const raw = symbol.owner ? symbol.owner.replace(/\s*\(static\)$/, '') : '';
  if (symbol.kind === 'class') return `~ class ${words(symbol.name)}: ${symbol.members} members`;
  if (symbol.kind === 'constructor') return `~ constructs ${raw}`;
  if (symbol.kind === 'getter') return `~ exposes ${words(symbol.name)} of ${raw}`;
  if (symbol.kind === 'setter') return `~ sets ${words(symbol.name)} on ${raw}`;
  if (symbol.kind === 'method') {
    const base = words(symbol.name);
    const prefix = PREFIXES.find(([p]) => base.startsWith(p + ' ') && base.length > p.length + 1);
    const body = prefix ? `${prefix[1]} ${base.slice(prefix[0].length + 1)}` : base;
    return `~ ${body} on ${raw}`;
  }
  const base = words(symbol.name);
  const prefix = PREFIXES.find(([p]) => base.startsWith(p + ' ') && base.length > p.length + 1);
  const body = prefix ? `${prefix[1]} ${base.slice(prefix[0].length + 1)}` : base;
  return `~ ${body}`;
}

function fixCase(text) {
  // camelCase inside the purpose would otherwise be lowercased by words()
  let out = text;
  for (const [re, rep] of WORD_REPLACEMENTS) out = out.replace(re, rep);
  return out;
}

function purposeOf(symbol) {
  const key = `${symbol.file}:${symbol.line}`;
  if (handWritten[key]) return { purpose: handWritten[key], evidence: 'R' };
  if (symbol.doc) return { purpose: fixCase(shorten(symbol.doc)), evidence: 'D' };
  // No doc comment, but the body is a single statement: quote it instead of guessing.
  if (symbol.body1 && symbol.bodyLoc <= 3) return { purpose: '`' + symbol.body1 + '`', evidence: 'B' };
  return { purpose: fixCase(gloss(symbol)), evidence: 'N' };
}

function shorten(text) {
  const clean = String(text).replace(/\s+/g, ' ').trim();
  const words = clean.split(' ');
  if (words.length <= 20) return clean;
  return words.slice(0, 20).join(' ') + ' …';
}

function escape(text) {
  return String(text).replace(/\|/g, '\\|');
}

const AREAS = [
  {
    id: 'mcp-server',
    title: 'MCP server (Node/TypeScript)',
    test: (f) => f.startsWith('mcp-server/'),
    intro: 'The process the MCP client launches: tool surface, extension bridge, daemon client, credential vault.',
  },
  {
    id: 'extension',
    title: 'Chrome extension (MV3, JavaScript)',
    test: (f) => f.startsWith('extension/'),
    intro: 'The browser side: service worker router, tool handlers, page-side scripts, popup UI, vault page.',
  },
  {
    id: 'scripts-agent-config',
    title: 'Scripts and agent configuration',
    test: (f) => f.startsWith('scripts/') || f.startsWith('agent-config/'),
    intro: 'Operator scripts (daemon lifecycle, pairing, smoke harnesses) and the MCP client config installers.',
  },
];

const prod = symbols.filter((s) => !s.file.startsWith('tests/'));
const testSymbols = symbols.filter((s) => s.file.startsWith('tests/'));

const testCounts = {};
for (const s of testSymbols) testCounts[s.file] = (testCounts[s.file] || 0) + 1;
const testLineCounts = {};
for (const s of testSymbols) testLineCounts[s.file] = Math.max(testLineCounts[s.file] || 0, s.endLine || s.line);

const modules = require(path.join(BASE, 'modules.json'));
const fileLines = new Map(modules.modules.map((m) => [m.file, m.lines]));
const fanIn = new Map();
const fanOut = new Map();
for (const e of modules.edges) {
  if (!e.resolved) continue;
  fanOut.set(e.from, (fanOut.get(e.from) || 0) + 1);
  fanIn.set(e.to, (fanIn.get(e.to) || 0) + 1);
}

let total = 0;
for (const area of AREAS) {
  const rows = prod.filter((s) => area.test(s.file));
  const files = [...new Set(rows.map((s) => s.file))].sort();
  const lines = [];
  lines.push(`# Inventory — ${area.title}`);
  lines.push('');
  lines.push(area.intro);
  lines.push('');
  lines.push(`Symbols: **${rows.length}** across **${files.length}** files.`);
  lines.push('');
  lines.push('Evidence column: `D` = purpose taken from the doc comment in the source; `R` = purpose written after reading the body; `B` = no doc comment, the quoted line is the whole body; `N` = no doc comment and a multi-statement body, so the purpose is derived from the identifier only (shown with `~`) — treat those as a label, not a verified description.');
  lines.push('');

  for (const file of files) {
    const fileRows = rows.filter((s) => s.file === file).sort((a, b) => a.line - b.line);
    const loc = fileLines.get(file) || fileRows.reduce((n, s) => Math.max(n, s.endLine), 0);
    const exp = fileRows.filter((s) => s.exported).length;
    lines.push(`## ${file}`);
    lines.push('');
    lines.push(`${loc} lines · ${fileRows.length} symbols · ${exp} exported · fan-in ${fanIn.get(file) || 0} · fan-out ${fanOut.get(file) || 0}`);
    lines.push('');
    lines.push('| line | kind | symbol | purpose | ev |');
    lines.push('|---:|---|---|---|---|');
    for (const s of fileRows) {
      const { purpose, evidence } = purposeOf(s);
      const name = (s.owner ? `${s.owner}.` : '') + s.name;
      const marks = [];
      if (s.exported) marks.push('exp');
      if (s.async) marks.push('async');
      if (s.complexity >= 20) marks.push(`cx${s.complexity}`);
      const label = marks.length ? `${name} (${marks.join(', ')})` : name;
      lines.push(`| ${s.line} | ${s.kind} | ${escape(label)} | ${escape(purpose)} | ${evidence} |`);
      total++;
    }
    lines.push('');
  }

  fs.writeFileSync(path.join(OUT, `inventory-${area.id}.md`), lines.join('\n'));
  console.log(area.id, rows.length, 'symbols,', files.length, 'files');
}

// test inventory: file-level only
const testFiles = [...new Set(testSymbols.map((s) => s.file))].sort();
const tl = [];
tl.push('# Inventory — tests');
tl.push('');
tl.push(`Tests are listed at file level: **${testFiles.length}** files, **${testSymbols.length}** test-side symbols. Tests are out of scope for the remediation plan, but they are counted so the inventory covers every parsed symbol in the repository.`);
tl.push('');
tl.push('| file | lines | test-side symbols |');
tl.push('|---|---:|---:|');
for (const f of testFiles) tl.push(`| ${f} | ${fileLines.get(f) || testLineCounts[f]} | ${testCounts[f]} |`);
tl.push('');
tl.push(`Total parsed symbols: **${symbols.length}** (production ${prod.length} + tests ${testSymbols.length}).`);
fs.writeFileSync(path.join(OUT, 'inventory-tests.md'), tl.join('\n'));

console.log('production rows written:', total, 'of', prod.length);
console.log('test files:', testFiles.length, 'test symbols:', testSymbols.length);
