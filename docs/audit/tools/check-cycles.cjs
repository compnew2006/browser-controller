#!/usr/bin/env node
/*
 * Reports every import cycle in the resolved module graph.
 *
 * Reads modules.json (written by extract2.cjs) from this script's directory,
 * or from argv[2] when given. Exit code 0 = no cycles, 1 = cycles found, so a
 * CI step can use it directly:
 *   node docs/audit/tools/check-cycles.cjs
 *
 * Baseline at c2b37f6: exactly 2 cycles, both through mcp-server/src/tools/batch.ts.
 * Phase 2 of docs/audit/06-remediation-phases.md must bring this to 0.
 */
const fs = require('node:fs');
const path = require('node:path');

const dir = process.argv[2] ? path.resolve(process.argv[2]) : __dirname;
const file = path.join(dir, 'modules.json');
if (!fs.existsSync(file)) {
  console.error(`check-cycles: ${file} not found. Run extract2.cjs first.`);
  process.exit(2);
}

const { modules, edges } = JSON.parse(fs.readFileSync(file, 'utf8'));
const unresolved = edges.filter((e) => !e.resolved);
const resolved = edges.filter((e) => e.resolved);

const adj = new Map();
for (const e of resolved) {
  if (!adj.has(e.from)) adj.set(e.from, []);
  adj.get(e.from).push(e.to);
}

const state = new Map(); // 0/absent = unvisited, 1 = on stack, 2 = done
const stack = [];
const found = new Set();

function dfs(node) {
  state.set(node, 1);
  stack.push(node);
  for (const next of adj.get(node) || []) {
    const s = state.get(next) || 0;
    if (s === 1) {
      const cycle = stack.slice(stack.indexOf(next)).concat(next);
      const key = [...new Set(cycle)].sort().join('|');
      if (!found.has(key)) {
        found.add(key);
        console.log(`CYCLE: ${cycle.join(' -> ')}`);
      }
    } else if (s === 0) {
      dfs(next);
    }
  }
  stack.pop();
  state.set(node, 2);
}

for (const node of adj.keys()) if (!state.get(node)) dfs(node);

console.log(
  `\nmodules ${modules.length} · edges ${resolved.length} resolved · ` +
    `${unresolved.length} unresolved · ${found.size} distinct cycles`,
);
if (unresolved.length) {
  for (const e of unresolved) console.log(`  UNRESOLVED ${e.from} -> ${e.to}`);
}
process.exit(found.size === 0 ? 0 : 1);
