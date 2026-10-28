#!/usr/bin/env node
/**
 * R-23 measurement for specs/004-site-navigation-map (tasks.md T033).
 *
 * In-process, on the built dist modules: no daemon, no extension, no browser. It owns a fresh mkdtemp
 * memory directory and never touches ~/.browser-controller. It measures:
 *   - capture: the synchronous afterCall (enqueue) and the commit (flush) per call, map off vs on, for a
 *     navigate with a snapshot and for an attributed click (website memory is on in both modes);
 *   - lookup: browser_site_map by tab, by named origin and as an outline, on a map file filled to its limits;
 *   - the SC-002 route: a target three clicks from the root, run --routes times without and with the map.
 *     Page loads are counted as navigates plus clicks that changed the URL (the in-process model of
 *     main-frame navigations); the with-map run counts 1 only when the lookup really returns the target path.
 *
 * Usage: npm run build && node scripts/map-bench.mjs [--iterations 200] [--routes 20] [--write]
 * --write replaces specs/004-site-navigation-map/baseline.md; without it the report goes to stdout only.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'mcp-server', 'dist', 'memory');
const OUT_FILE = path.join(ROOT, 'specs', '004-site-navigation-map', 'baseline.md');
const ORIGIN = 'https://bench.example';
const PROFILE = 'bench-profile';
const SESSION = 's-bench';
const CONNECTION = 'conn-bench';
const TAB = 7;

function parseArgs(argv) {
  const out = { iterations: 200, routes: 20, write: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--iterations') out.iterations = Number(argv[++i]);
    else if (argv[i] === '--routes') out.routes = Number(argv[++i]);
    else if (argv[i] === '--write') out.write = true;
    else throw new Error(`unknown argument ${argv[i]}`);
  }
  for (const key of ['iterations', 'routes']) {
    if (!Number.isInteger(out[key]) || out[key] < 1 || out[key] > 10_000) throw new Error(`--${key} must be an integer from 1 to 10000`);
  }
  return out;
}

async function load(name) {
  const file = path.join(DIST, `${name}.js`);
  if (!fs.existsSync(file)) throw new Error(`${path.relative(ROOT, file)} is missing; run npm run build first`);
  return import(pathToFileURL(file).href);
}

function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  return sorted[Math.max(0, Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1))];
}

function summarize(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  return { n: sorted.length, p50: percentile(sorted, 50), p95: percentile(sorted, 95), p99: percentile(sorted, 99) };
}

const ms = (value) => (value === null ? 'n/a' : value < 1 ? value.toFixed(3) : value.toFixed(2));

// Snapshot text in the extension's format: `page: <title> — <url>`, then `role "name" [eN]` lines.
function snapshot(title, url, sections) {
  const lines = [`page: ${title} — ${url}`];
  let ref = 0;
  for (const [area, controls] of sections) {
    lines.push(area);
    for (const [role, name] of controls) lines.push(`  ${role} ${JSON.stringify(name)} [e${(ref += 1)}]`);
  }
  return lines.join('\n');
}

// Links are eligible only outside the main area (R-10), so the route's links sit in a navigation landmark.
const header = [['link', 'Home'], ['link', 'Help'], ['button', 'Account']];
function pageText(pathname, title, links) {
  return snapshot(title, `${ORIGIN}${pathname}`, [['banner', header], ['navigation', links.map((name) => ['link', name])], ['main', [['button', 'Save']]]]);
}

function fullContext(url) {
  return { url, incognito: false, topLevel: true, stable: true, anonymous: true, lang: 'en', dir: 'ltr', passwordField: false };
}

class Bench {
  constructor(mods, memoryDir) {
    this.mods = mods;
    this.memoryDir = memoryDir;
    this.seq = 0;
    this.loads = 0;
    this.service = new mods.service.MemoryService({
      memoryDir,
      vault: { memoryEligibility: () => 'clear' },
      connection: () => ({ browserId: PROFILE, browserLabel: 'Bench', connectionId: CONNECTION, ambiguous: false, supportsSiteContext: true, supportsSiteMap: true }),
    });
  }

  async setMap(on) {
    const at = new Date().toISOString();
    await this.mods.policy.writePolicy(this.memoryDir, this.mods.policy.enablePolicy(this.mods.policy.defaultPolicy(), at));
    const map = this.mods.mapPolicy.defaultMapPolicy();
    await this.mods.mapPolicy.writeMapPolicy(this.memoryDir, on ? this.mods.mapPolicy.enableMapProfile(map, PROFILE, at) : map);
    this.service.map.invalidate();
    // A tab read made before the enable time is not recorded; step past it.
    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  /**
   * One call through the hooks the daemon uses, in its order. Returns {path, commit}: `path` is the time added
   * to the agent's call (the reminder, then the synchronous enqueue); `commit` is the write that follows.
   */
  async call(tool, params, result, siteContext) {
    this.seq += 1;
    const memoryCall = this.service.beginCall(SESSION, tool);
    const outcome = {
      sessionId: SESSION,
      tool,
      params,
      daemonCallId: `bench-${this.seq}`,
      result,
      observation: memoryCall.observe ? { siteContext, digestBefore: 'a', digestAfter: 'a', sanitizedUnchanged: true } : undefined,
    };
    const start = performance.now();
    await this.service.withReminder(memoryCall, outcome);
    this.service.afterCall(memoryCall, outcome);
    const answered = performance.now();
    await this.service.flush();
    return { path: answered - start, commit: performance.now() - answered };
  }

  navigate(pathname, text) {
    this.loads += 1;
    const url = `${ORIGIN}${pathname}`;
    return this.call('browser_navigate', { tabId: TAB, url, snapshot: true }, { success: true, tabId: TAB, url, status: 200, text: `title: bench\nstatus: 200\n\n${text}` }, fullContext(url));
  }

  read(pathname, text) {
    const url = `${ORIGIN}${pathname}`;
    return this.call('browser_snapshot', { tabId: TAB }, { success: true, url, text, truncated: false, refs: [] }, fullContext(url));
  }

  click(ref, fromPath, toPath) {
    if (fromPath !== toPath) this.loads += 1;
    const url = `${ORIGIN}${toPath}`;
    const light = { url, fromUrl: `${ORIGIN}${fromPath}`, incognito: false, topLevel: true, stable: true, anonymous: null, anonymityReason: 'not_probed' };
    return this.call('browser_click', { tabId: TAB, target: ref }, { success: true, tabId: TAB, url, navigated: fromPath !== toPath }, light);
  }

  async lookup(params, siteContext = null) {
    const start = performance.now();
    const answer = await this.service.handleTool('browser_site_map', params, SESSION, { siteContext, connectionIdBefore: CONNECTION });
    return [performance.now() - start, answer];
  }
}

async function measureCapture(mods, iterations) {
  const rows = {};
  for (const mode of ['off', 'on']) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-mapbench-'));
    const memoryDir = path.join(dir, 'memory');
    fs.mkdirSync(memoryDir, { mode: 0o700 });
    try {
      const bench = new Bench(mods, memoryDir);
      await bench.setMap(mode === 'on');
      const samples = { navigatePath: [], navigateCommit: [], clickPath: [], clickCommit: [], snapshotPath: [], snapshotCommit: [] };
      const links = Array.from({ length: 20 }, (_, index) => `Section ${index}`);
      for (let index = 0; index < iterations; index += 1) {
        const navigate = await bench.navigate('/', pageText('/', 'Bench home', links));
        // e4 is the first navigation link ("Section 0"); the destination varies so pages keep being learned.
        const target = `/section-${index % 50}`;
        const click = await bench.click('e4', '/', target);
        const read = await bench.read(target, pageText(target, `Section ${index % 50}`, ['Overview', 'Details']));
        samples.navigatePath.push(navigate.path);
        samples.navigateCommit.push(navigate.commit);
        samples.clickPath.push(click.path);
        samples.clickCommit.push(click.commit);
        samples.snapshotPath.push(read.path);
        samples.snapshotCommit.push(read.commit);
      }
      rows[mode] = Object.fromEntries(Object.entries(samples).map(([key, values]) => [key, summarize(values)]));
      rows[mode].pages = (await bench.service.map.store.getMap(PROFILE, ORIGIN))?.pages.length ?? 0;
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  return rows;
}

/** A map file at its limits: 500 pages with 60 controls each, then trimmed to the 1 MiB file limit. */
async function seedFullMap(mods, service) {
  const { emptyMapRecord } = mods.record;
  const { applyMapOp, enforceMapLimits } = mods.reconcile;
  const { controlKey } = mods.text;
  const base = Date.now() - 3_600_000;
  const record = emptyMapRecord(PROFILE, ORIGIN, new Date(base).toISOString());
  const limits = mods.allowlist.MAP_LIMITS;
  for (let page = 0; page < limits.pagesPerOrigin; page += 1) {
    const controls = Array.from({ length: limits.controlsPerPage }, (_, index) => {
      const name = `Control ${index} of area ${page}`;
      return { key: controlKey('main', 'button', name), area: 'main', role: 'button', name, nth: null, parent: null };
    });
    applyMapOp(record, {
      type: 'read', opId: `seed-${page}`, profile: PROFILE, origin: ORIGIN, at: new Date(base + page * 1_000).toISOString(),
      path: page === 0 ? '/' : `/area-${page}`, addressable: true, title: `Area ${page} settings`, lang: 'en', dir: 'ltr',
      context: 'public', complete: true, readChars: 4_000, controls, reason: page === 0 ? 'root' : 'destination',
    });
  }
  const trimmed = enforceMapLimits(record);
  await service.map.store.putMap(record);
  const bytes = Buffer.byteLength(JSON.stringify(record));
  return { pages: record.pages.length, controls: record.pages.reduce((sum, page) => sum + page.controls.length, 0), bytes, trimmed };
}

async function measureLookup(mods, iterations) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-mapbench-'));
  const memoryDir = path.join(dir, 'memory');
  fs.mkdirSync(memoryDir, { mode: 0o700 });
  try {
    const bench = new Bench(mods, memoryDir);
    await bench.setMap(true);
    const seeded = await seedFullMap(mods, bench.service);
    // A fresh service reads the file cold once; the rest hit the store's cache, as a running daemon does.
    const cold = new Bench(mods, memoryDir);
    const [coldMs, coldAnswer] = await cold.lookup({ origin: ORIGIN, query: 'settings' });
    if (!coldAnswer.success) throw new Error(`cold lookup failed: ${coldAnswer.error}`);
    const samples = { tab: [], origin: [], outline: [] };
    const tabContext = fullContext(`${ORIGIN}/area-3`);
    for (let index = 0; index < iterations; index += 1) {
      const query = `area ${index % seeded.pages}`;
      const [tabMs, tab] = await cold.lookup({ tabId: TAB, query }, tabContext);
      const [originMs, named] = await cold.lookup({ origin: 'bench.example', query: `control ${index % 60}` });
      const [outlineMs, outline] = await cold.lookup({ origin: ORIGIN });
      for (const answer of [tab, named, outline]) if (!answer.success) throw new Error(`lookup failed: ${answer.error}`);
      samples.tab.push(tabMs);
      samples.origin.push(originMs);
      samples.outline.push(outlineMs);
    }
    return { seeded, coldMs, ...Object.fromEntries(Object.entries(samples).map(([key, values]) => [key, summarize(values)])) };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** SC-002: root, then "Accounts" (/accounts), "Team" (/accounts/team), "Permissions" (/accounts/team/permissions). */
const ROUTE = [
  { path: '/', title: 'Bench home', link: 'Accounts' },
  { path: '/accounts', title: 'Accounts', link: 'Team' },
  { path: '/accounts/team', title: 'Team', link: 'Permissions' },
  { path: '/accounts/team/permissions', title: 'Team permissions', link: null },
];

async function walkRoute(bench) {
  for (let step = 0; step < ROUTE.length; step += 1) {
    const page = ROUTE[step];
    const links = page.link ? [page.link, 'News', 'Blog'] : ['Add member'];
    const text = pageText(page.path, page.title, links);
    if (step === 0) await bench.navigate(page.path, text);
    else await bench.read(page.path, text);
    // e4 is the first navigation link: the next step of the route.
    if (page.link) await bench.click('e4', page.path, ROUTE[step + 1].path);
  }
}

async function measureRoute(mods, routes) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-mapbench-'));
  const memoryDir = path.join(dir, 'memory');
  fs.mkdirSync(memoryDir, { mode: 0o700 });
  const target = ROUTE.at(-1);
  try {
    const bench = new Bench(mods, memoryDir);
    await bench.setMap(true);
    const without = [];
    for (let run = 0; run < routes; run += 1) {
      bench.loads = 0;
      await walkRoute(bench);
      without.push(bench.loads);
    }
    const withMap = [];
    let found = 0;
    for (let run = 0; run < routes; run += 1) {
      bench.loads = 0;
      const [, answer] = await bench.lookup({ origin: ORIGIN, query: 'permissions' });
      const hit = answer.success && answer.pages?.find((page) => page.path === target.path);
      if (hit) {
        found += 1;
        await bench.navigate(target.path, pageText(target.path, target.title, ['Add member']));
      } else {
        await walkRoute(bench);
      }
      withMap.push(bench.loads);
    }
    const mean = (values) => values.reduce((sum, value) => sum + value, 0) / values.length;
    return { routes, without: mean(without), withMap: mean(withMap), found };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function report(args, capture, lookup, route) {
  const date = new Date().toISOString().slice(0, 10);
  const cpu = os.cpus()[0]?.model ?? 'unknown CPU';
  const row = (name, s) => `| ${name} | ${s.n} | ${ms(s.p50)} | ${ms(s.p95)} | ${ms(s.p99)} |`;
  return [
    '# Site map baseline (specs/004-site-navigation-map, R-23)',
    '',
    `- **Date**: ${date}`,
    `- **Runner**: \`node scripts/map-bench.mjs --iterations ${args.iterations} --routes ${args.routes} --write\``,
    `- **Node**: ${process.version} on ${process.platform}/${process.arch}, ${cpu}, ${os.cpus().length} cores`,
    '- **Node 20**: not run (not installed on this machine).',
    '- **Method**: in-process on the dist modules, with a fresh temp memory directory per section; no daemon, extension or browser. Times are wall-clock ms from `performance.now()`. Website memory is on in both capture modes, so the difference is the map\'s own cost.',
    '',
    '## Capture (SC-005)',
    '',
    'Each iteration is a navigate with a snapshot of the root (20 navigation links), an attributed click to one of 50 section paths, and a snapshot of that page. "On the call path" is the time website memory adds to the agent\'s call: the reminder (`withReminder`, which reads 003 and the map) and the synchronous `afterCall` enqueue. "Commit" is the `flush()` that follows; in the daemon it runs after the answer, off the call path.',
    '',
    'SC-005 targets (accepted at gate 4): p95 at most 25 ms for a navigation and 30 ms for a page read, with the map on.',
    '',
    '| Measure | n | p50 ms | p95 ms | p99 ms |',
    '|---|---|---|---|---|',
    row('navigate, on the call path, map off', capture.off.navigatePath),
    row('navigate, on the call path, map on', capture.on.navigatePath),
    row('snapshot, on the call path, map off', capture.off.snapshotPath),
    row('snapshot, on the call path, map on', capture.on.snapshotPath),
    row('click, on the call path, map off', capture.off.clickPath),
    row('click, on the call path, map on', capture.on.clickPath),
    row('navigate commit, map off', capture.off.navigateCommit),
    row('navigate commit, map on', capture.on.navigateCommit),
    row('snapshot commit, map off', capture.off.snapshotCommit),
    row('snapshot commit, map on', capture.on.snapshotCommit),
    row('click commit, map off', capture.off.clickCommit),
    row('click commit, map on', capture.on.clickCommit),
    '',
    `Pages learned: ${capture.off.pages} with the map off, ${capture.on.pages} with it on.`,
    '',
    '## Lookup (SC-005)',
    '',
    'SC-005 target (accepted at gate 4): p95 at most 50 ms on an origin at its limits.',
    '',
    `Map file at its limits: ${lookup.seeded.pages} pages, ${lookup.seeded.controls} controls, ${lookup.seeded.bytes} bytes after the 1 MiB trim (${lookup.seeded.trimmed} entries trimmed). The first lookup of a fresh service reads the file cold: ${ms(lookup.coldMs)} ms. The rest use the store's cache, as a running daemon does.`,
    '',
    '| Lookup | n | p50 ms | p95 ms | p99 ms |',
    '|---|---|---|---|---|',
    row('by tab, with query', lookup.tab),
    row('by named origin, with query', lookup.origin),
    row('outline (named origin, no query)', lookup.outline),
    '',
    '## Page loads to a target three clicks deep (SC-002)',
    '',
    `Route: \`/\` → \`/accounts\` → \`/accounts/team\` → \`/accounts/team/permissions\`, ${route.routes} runs per mode. A page load is a navigate or a click that changed the URL.`,
    '',
    '| Mode | Mean page loads |',
    '|---|---|',
    `| Without the map (navigate to the root, 3 clicks) | ${route.without} |`,
    `| With the map (lookup, then one navigate) | ${route.withMap} |`,
    '',
    `The lookup returned the target path in ${route.found} of ${route.routes} runs with the map.`,
    '',
    '## Notes',
    '',
    '- R-23 planned a synthetic site under `scripts/pages/map/` driven through a fake extension. This runner models the same route in-process instead, so it measures the daemon-side work only, not browser or IPC time.',
    '- The limits in `map-allowlist.ts` and these targets were accepted at plan gate 4 on 2026-10-28 (plan.md).',
    '',
  ].join('\n');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const mods = {
    service: await load('service'),
    policy: await load('policy'),
    mapPolicy: await load('map-policy'),
    record: await load('map-record'),
    reconcile: await load('map-reconcile'),
    text: await load('map-text'),
    allowlist: await load('map-allowlist'),
  };
  const capture = await measureCapture(mods, args.iterations);
  const lookup = await measureLookup(mods, args.iterations);
  const route = await measureRoute(mods, args.routes);
  const text = report(args, capture, lookup, route);
  process.stdout.write(text);
  if (args.write) fs.writeFileSync(OUT_FILE, text);
}

main().catch((error) => {
  process.stderr.write(`map-bench: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
