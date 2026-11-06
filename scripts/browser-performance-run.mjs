#!/usr/bin/env node
/** Run trusted, caller-provided adapters against the local paired fixture. */
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { runPairedBenchmark } from './browser-performance-bench.mjs';

function options(args) {
  const out = { iterations: 30, warmups: 1, isolated: false };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--ack-isolated') out.isolated = true;
    else if (arg === '--adapter-a' || arg === '--adapter-b') out[arg.slice(2)] = args[++i];
    else if (arg === '--iterations' || arg === '--warmups') out[arg.slice(2)] = Number(args[++i]);
    else if (arg === '--scenarios') out.scenarios = (args[++i] || '').split(',');
    else throw new Error('invalid option');
  }
  if (!out.isolated || !out['adapter-a'] || !out['adapter-b']) throw new Error('missing adapter or isolation acknowledgement');
  return out;
}

try {
  const args = options(process.argv.slice(2));
  // These are trusted local code selected by the operator; this runner cannot
  // constrain what an adapter does or verify that it actually uses isolation.
  const [a, b] = await Promise.all([
    import(pathToFileURL(path.resolve(args['adapter-a'])).href),
    import(pathToFileURL(path.resolve(args['adapter-b'])).href),
  ]);
  const report = await runPairedBenchmark({
    adapters: { a: a.default, b: b.default }, iterations: args.iterations,
    warmups: args.warmups, ...(args.scenarios ? { scenarios: args.scenarios } : {}),
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} catch {
  // Exceptions can contain page data or adapter configuration. Never echo them.
  process.stderr.write('Benchmark failed. Check trusted adapter modules, arguments, and isolated-profile setup.\n');
  process.exitCode = 1;
}
