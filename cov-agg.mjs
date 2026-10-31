import { readFileSync } from 'node:fs';

const j = JSON.parse(readFileSync('coverage/coverage-summary.json', 'utf8'));
const norm = (k) => k.replace(/\\/g, '/');

function agg(pred) {
  let c = 0, t = 0;
  for (const [k, v] of Object.entries(j)) {
    if (k === 'total') continue;
    if (!pred(norm(k))) continue;
    c += v.branches.covered; t += v.branches.total;
  }
  return { covered: c, total: t, pct: +(100 * c / t).toFixed(3) };
}

const scopes = {
  'mcp-server/src': (k) => k.includes('mcp-server/src/'),
  'mcp-server/src/vault': (k) => k.includes('mcp-server/src/vault/'),
  'mcp-server/src/tools': (k) => k.includes('mcp-server/src/tools/'),
  'extension': (k) => k.includes('extension/'),
  'global': () => true,
};

for (const [name, pred] of Object.entries(scopes)) {
  const a = agg(pred);
  const need = Math.ceil(0.79 * a.total) - a.covered;
  console.log(name.padEnd(24), JSON.stringify(a), 'to reach 79%:', need);
}

// files I touched
const touched = [
  'mcp-server/src/core/error-codes.ts',
  'mcp-server/src/tools/vault.ts',
  'mcp-server/src/vault/bridge-transport.ts',
  'mcp-server/src/vault/daemon-routing.ts',
  'mcp-server/src/vault/fill.ts',
  'mcp-server/src/vault/requests.ts',
  'mcp-server/src/vault/service-common.ts',
  'mcp-server/src/vault/service-core.ts',
  'mcp-server/src/vault/service-private.ts',
  'mcp-server/src/vault/service.ts',
];
console.log('\n--- touched files ---');
for (const f of touched) {
  const key = Object.keys(j).find((k) => norm(k).endsWith('/' + f));
  if (!key) { console.log('missing', f); continue; }
  const v = j[key];
  console.log(f.padEnd(45), 'br', String(v.branches.covered).padStart(3) + '/' + String(v.branches.total).padEnd(4),
    'ln', String(v.lines.covered).padStart(3) + '/' + String(v.lines.total).padEnd(4),
    'fn', String(v.functions.covered).padStart(3) + '/' + String(v.functions.total).padEnd(4),
    'st', String(v.statements.covered).padStart(3) + '/' + String(v.statements.total).padEnd(4));
}
