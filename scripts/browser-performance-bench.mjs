/**
 * Paired local-fixture benchmark runner.
 *
 * Adapters are supplied by the caller and must use isolated browser profiles.
 * This module never opens a browser or reads browser-controller state itself.
 * Adapters must run only against the provided loopback fixture and verify each
 * scenario's postcondition. The runner cannot enforce an adapter's isolation.
 *
 * Each adapter exposes async createSession({ baseUrl, mode, measure }) and the
 * resulting session exposes reset({ baseUrl, scenario }), run({ baseUrl, scenario, mode, measure,
 * recordRequest }) and close(). The `measure` callback wraps a real observable
 * boundary; an uninstrumented stage stays absent. Never pass page data, URLs,
 * error messages, or input values to the reporting callbacks.
 */
import http from 'node:http';
import { performance } from 'node:perf_hooks';

export const SCENARIOS = Object.freeze(['navigation', 'input', 'form', 'spa', 'iframe', 'batch']);
export const PHASES = Object.freeze(['connection', 'tab_lookup', 'target_resolution', 'input_dispatch', 'settle', 'save']);

/** Nearest-rank percentiles. Empty or unmeasured phases remain null. */
export function summarize(samples) {
  if (!Array.isArray(samples) || samples.some((n) => !Number.isFinite(n) || n < 0)) {
    throw new TypeError('samples must contain finite nonnegative durations');
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const rank = (p) => sorted.length ? sorted[Math.ceil(p * sorted.length) - 1] : null;
  return { n: sorted.length, p50: rank(0.5), p95: rank(0.95) };
}

const PAGE = `<!doctype html><html lang="en"><meta charset="utf-8"><title>Local performance fixture</title>
<main><a id="navigate" href="/next">Next</a><input id="input" aria-label="Input">
<form id="form"><input name="value" aria-label="Form input"><button>Submit</button></form>
<button id="spa">Change route</button><output id="result">ready</output>
<iframe title="Fixture frame" src="/frame"></iframe></main>
<script>
document.querySelector('#form').addEventListener('submit', e => { e.preventDefault(); document.querySelector('#result').textContent = 'submitted'; });
document.querySelector('#spa').addEventListener('click', () => { history.pushState({}, '', '/spa'); document.querySelector('#result').textContent = 'route changed'; });
</script></html>`;
const FRAME = '<!doctype html><html lang="en"><title>Fixture frame</title><button id="frame-button" onclick="this.textContent=\'clicked\'">Frame button</button></html>';

/** Bind to loopback on an ephemeral port and serve only fixed, local fixture pages. */
export async function startFixture() {
  const server = http.createServer((req, res) => {
    const path = (req.url || '').split('?')[0];
    if (req.method !== 'GET' || !['/', '/next', '/spa', '/frame'].includes(path)) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(path === '/frame' ? FRAME : PAGE);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('fixture listener did not bind');
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve, reject) => server.close((err) => err ? reject(err) : resolve())),
  };
}

function validateOptions(adapters, scenarios, iterations, warmups) {
  if (!adapters || !['a', 'b'].every((key) => typeof adapters[key]?.createSession === 'function')) {
    throw new TypeError('adapters.a and adapters.b must expose createSession');
  }
  if (!Array.isArray(scenarios) || scenarios.length === 0 || new Set(scenarios).size !== scenarios.length || scenarios.some((s) => !SCENARIOS.includes(s))) {
    throw new TypeError('scenarios must be unique supported fixture scenarios');
  }
  for (const [name, value, min] of [['iterations', iterations, 1], ['warmups', warmups, 0]]) {
    if (!Number.isInteger(value) || value < min || value > 1000) throw new RangeError(`${name} must be ${min}..1000`);
  }
}

function newAggregate() {
  return { attempted: 0, passed: 0, failed: 0, requests: 0, payloadBytes: 0, duration: [], successfulDuration: [], failedDuration: [], phases: Object.fromEntries(PHASES.map((p) => [p, []])) };
}

function measurement(aggregate, clock) {
  const phaseSamples = Object.fromEntries(PHASES.map((phase) => [phase, []]));
  let requests = 0;
  let payloadBytes = 0;
  return {
    async measure(phase, callback) {
      if (!PHASES.includes(phase) || typeof callback !== 'function') throw new TypeError('invalid measured phase');
      const start = clock();
      try { return await callback(); }
      finally {
        const elapsed = clock() - start;
        if (!Number.isFinite(elapsed) || elapsed < 0) throw new RangeError('invalid monotonic duration');
        phaseSamples[phase].push(elapsed);
      }
    },
    recordRequest(bytes) {
      if (!Number.isSafeInteger(bytes) || bytes < 0) throw new RangeError('payload size must be a nonnegative integer');
      requests += 1;
      payloadBytes += bytes;
    },
    finish(success, elapsed) {
      aggregate.attempted += 1;
      if (success) aggregate.passed += 1;
      else aggregate.failed += 1;
      aggregate.duration.push(elapsed);
      (success ? aggregate.successfulDuration : aggregate.failedDuration).push(elapsed);
      aggregate.requests += requests;
      aggregate.payloadBytes += payloadBytes;
      for (const phase of PHASES) aggregate.phases[phase].push(...phaseSamples[phase]);
    },
  };
}

function finalReport(aggregate) {
  return {
    attempted: aggregate.attempted, passed: aggregate.passed, failed: aggregate.failed,
    requests: aggregate.requests, payloadBytes: aggregate.payloadBytes,
    durationMs: summarize(aggregate.duration),
    successfulDurationMs: summarize(aggregate.successfulDuration),
    failedDurationMs: summarize(aggregate.failedDuration),
    phasesMs: Object.fromEntries(PHASES.map((phase) => [phase, summarize(aggregate.phases[phase])])),
  };
}

/**
 * Alternate adapter order for each sample. Cold runs create a new session for
 * every sample; warm runs reuse one session per adapter and scenario. Adapter
 * exceptions are counted, not echoed: messages can contain page data.
 */
export async function runPairedBenchmark({ adapters, scenarios = SCENARIOS, iterations = 30, warmups = 1, clock = () => performance.now() }) {
  validateOptions(adapters, scenarios, iterations, warmups);
  if (typeof clock !== 'function') throw new TypeError('clock must be a function');
  const fixture = await startFixture();
  const report = { schema: 1, fixture: 'loopback', iterations, warmups, percentile: 'nearest-rank', results: {} };
  const run = async (adapter, scenario, mode, aggregate, session) => {
    const m = measurement(aggregate, clock);
    const start = clock();
    let local = session;
    let success = false;
    try {
      if (!local) local = await adapter.createSession({ baseUrl: fixture.baseUrl, mode, measure: m.measure });
      if (typeof local?.run !== 'function' || typeof local?.reset !== 'function' || typeof local?.close !== 'function') throw new TypeError('invalid adapter session');
      await local.reset({ baseUrl: fixture.baseUrl, scenario });
      const result = await local.run({ baseUrl: fixture.baseUrl, scenario, mode, measure: m.measure, recordRequest: m.recordRequest });
      success = result?.success === true;
    } catch { success = false; }
    finally {
      if (mode === 'cold' && local?.close) {
        try { await local.close(); } catch { success = false; }
      }
      const elapsed = clock() - start;
      if (!Number.isFinite(elapsed) || elapsed < 0) throw new RangeError('invalid monotonic duration');
      m.finish(success, elapsed);
    }
  };
  try {
    for (const scenario of scenarios) {
      report.results[scenario] = {};
      for (const mode of ['cold', 'warm']) {
        const aggregates = { a: newAggregate(), b: newAggregate() };
        const sessions = {};
        try {
          if (mode === 'warm') {
            for (const key of ['a', 'b']) {
              try { sessions[key] = await adapters[key].createSession({ baseUrl: fixture.baseUrl, mode, measure: measurement(newAggregate(), clock).measure }); }
              catch { sessions[key] = null; }
            }
            for (let i = 0; i < warmups; i += 1) for (const key of (i % 2 ? ['b', 'a'] : ['a', 'b'])) {
              if (sessions[key]) await run(adapters[key], scenario, mode, newAggregate(), sessions[key]);
            }
          }
          for (let i = 0; i < iterations; i += 1) for (const key of (i % 2 ? ['b', 'a'] : ['a', 'b'])) {
            if (mode === 'warm' && !sessions[key]) {
              aggregates[key].attempted += 1;
              aggregates[key].failed += 1;
            } else await run(adapters[key], scenario, mode, aggregates[key], sessions[key]);
          }
        } finally {
          if (mode === 'warm') for (const key of ['a', 'b']) {
            try { await sessions[key]?.close(); } catch { /* cleanup is independent of recorded samples */ }
          }
        }
        report.results[scenario][mode] = { a: finalReport(aggregates.a), b: finalReport(aggregates.b) };
      }
    }
  } finally { await fixture.close(); }
  return report;
}
