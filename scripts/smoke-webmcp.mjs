#!/usr/bin/env node
/**
 * Real-Chrome smoke test for browser_webmcp_list / browser_webmcp_call
 * (specs/webmcp-support, success criteria 1–10).
 *
 * Starts an ISOLATED headless Chrome (temporary profile, --enable-features=WebMCP)
 * — the user's own Chrome and profile are never touched — serves
 * tests/fixtures on http://localhost, and drives the REAL extension handlers
 * (handlers/webmcp.js → cdp-session → cdpEvaluate → page runner) through a
 * small `chrome.*` shim that forwards chrome.debugger.sendCommand to CDP.
 *
 *   npm run smoke:webmcp           (CHROME_PATH=/path/to/chrome to override)
 *
 * Exit codes: 0 all checks passed · 1 a check failed · 2 Chrome not found.
 * Not part of `npm test` / CI: it needs a local Chrome ≥ 149.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURES = path.join(ROOT, 'tests', 'fixtures');
const INSECURE_HOST = 'webmcp-insecure.test'; // not a secure context → no document.modelContext
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function findChrome() {
  if (process.env.CHROME_PATH) return fs.existsSync(process.env.CHROME_PATH) ? process.env.CHROME_PATH : null;
  const candidates = {
    darwin: ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium'],
    win32: [
      path.join(process.env.PROGRAMFILES || 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    ],
  }[process.platform];
  if (candidates) return candidates.find((p) => p && fs.existsSync(p)) || null;
  for (const name of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']) {
    for (const dir of (process.env.PATH || '').split(path.delimiter)) {
      const full = path.join(dir, name);
      if (fs.existsSync(full)) return full;
    }
  }
  return null;
}

function serveFixtures() {
  const server = http.createServer((req, res) => {
    const name = path.basename(new URL(req.url, 'http://x').pathname);
    const file = path.join(FIXTURES, name);
    if (!name.endsWith('.html') || !fs.existsSync(file)) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

function cdpClient(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let next = 1;
  const pending = new Map();
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (!msg.id || !pending.has(msg.id)) return;
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(msg.error.message));
    else resolve(msg.result);
  };
  ws.onclose = () => {
    // Deliberately NOT a CDP navigation message: SC9 must pass on Chrome's own error.
    for (const { reject } of pending.values()) reject(new Error('CDP socket closed'));
    pending.clear();
  };
  const ready = new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  return {
    ready,
    send: (method, params = {}) => new Promise((resolve, reject) => {
      const id = next++;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    }),
    close: () => ws.close(),
  };
}

const chromePath = findChrome();
if (!chromePath) {
  console.error('Chrome not found (set CHROME_PATH to a Chrome/Chromium ≥ 149 binary).');
  process.exit(2);
}

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-webmcp-smoke-'));
const server = await serveFixtures();
const port = server.address().port;
const chrome = spawn(chromePath, [
  '--headless=new',
  `--user-data-dir=${profile}`,
  '--enable-features=WebMCP',
  '--remote-debugging-port=0',
  `--host-resolver-rules=MAP ${INSECURE_HOST} 127.0.0.1`,
  '--no-first-run',
  '--no-default-browser-check',
  'about:blank',
], { stdio: 'ignore' });

const results = [];
const clients = new Map();
let exitCode = 1;

async function cleanup() {
  for (const c of clients.values()) c.close();
  chrome.kill();
  server.close();
  await sleep(300);
  fs.rmSync(profile, { recursive: true, force: true });
}

try {
  // Chrome writes its chosen debugging port to DevToolsActivePort.
  const portFile = path.join(profile, 'DevToolsActivePort');
  let debugPort = null;
  for (let i = 0; i < 100 && !debugPort; i++) {
    if (fs.existsSync(portFile)) debugPort = Number(fs.readFileSync(portFile, 'utf8').split('\n')[0]) || null;
    if (!debugPort) await sleep(100);
  }
  if (!debugPort) throw new Error('Chrome did not open a debugging port');
  const version = await (await fetch(`http://127.0.0.1:${debugPort}/json/version`)).json();

  async function openTab(tabId, url) {
    const target = await (await fetch(`http://127.0.0.1:${debugPort}/json/new?${encodeURI(url)}`, { method: 'PUT' })).json();
    const client = cdpClient(target.webSocketDebuggerUrl);
    await client.ready;
    clients.set(tabId, client);
  }
  const pageEval = async (tabId, expression) => (await clients.get(tabId).send('Runtime.evaluate', { expression, returnByValue: true })).result.value;

  // The chrome.* surface the handler chain touches, backed by CDP.
  globalThis.chrome = {
    tabs: {
      get: async (id) => {
        if (!clients.has(id)) throw new Error(`No tab with id: ${id}`);
        return { id, url: await pageEval(id, 'location.href'), windowId: 1 };
      },
      query: async () => [],
      onRemoved: { addListener: () => {} },
    },
    windows: { get: async () => ({ width: 1280, height: 900 }) },
    scripting: { executeScript: async () => { throw new Error('chrome.scripting is not available in the smoke test'); } },
    debugger: {
      attach: async () => {},
      detach: async () => {},
      sendCommand: (target, method, params) => clients.get(target.tabId).send(method, params),
      onDetach: { addListener: () => {} },
    },
    storage: { session: { get: async () => ({}), set: async () => {} }, local: { get: async () => ({}), set: async () => {} } },
  };
  const { handleWebMcpList, handleWebMcpCall } = await import(pathToFileURL(path.join(ROOT, 'extension', 'handlers', 'webmcp.js')).href);
  const list = (params) => handleWebMcpList(params, null, null, undefined);
  const call = (params) => handleWebMcpCall(params, null, null, undefined);

  async function check(sc, label, fn) {
    try {
      const detail = await fn();
      results.push({ sc, label, ok: true, detail: detail ?? '' });
    } catch (err) {
      results.push({ sc, label, ok: false, detail: err.message });
    }
  }
  const expectThat = (cond, message) => { if (!cond) throw new Error(message); };

  const TAB = 1;
  const INSECURE_TAB = 2;
  await openTab(TAB, `http://localhost:${port}/webmcp-demo.html`);
  await openTab(INSECURE_TAB, `http://${INSECURE_HOST}:${port}/webmcp-demo.html`);

  await check('SC2', 'list waitMs catches late_tool (registered 1.5 s after load)', async () => {
    const r = await list({ tabId: TAB, name: 'late_tool', waitMs: 5_000 });
    expectThat(r.success && r.count === 1, JSON.stringify(r));
    return `count=${r.count}`;
  });

  await check('SC1', 'list: shape, frames, declarative forms, untrusted flag', async () => {
    const r = await list({ tabId: TAB });
    const find = (name, frame) => r.tools.find((t) => t.name === name && (!frame || t.frame === frame));
    expectThat(r.success && r.supported && r.untrustedContent === true, JSON.stringify(r).slice(0, 300));
    expectThat(find('echo', 'main') && find('echo', '0'), 'echo in main and frame "0"');
    expectThat(find('search_form')?.declarative === true && find('search_form')?.autoSubmit === false, 'search_form declarative');
    expectThat(find('subscribe')?.autoSubmit === true, 'subscribe autoSubmit');
    expectThat(find('place_order')?.annotations?.consequentialHint === true, 'place_order consequential');
    expectThat(!JSON.stringify(r).includes('"window"'), 'no WindowProxy leaked');
    return `${r.count} tools`;
  });

  await check('SC3', 'no WebMCP (insecure context): list answers supported:false, call fails WEBMCP_UNAVAILABLE', async () => {
    const l = await list({ tabId: INSECURE_TAB });
    const c = await call({ tabId: INSECURE_TAB, name: 'echo' });
    expectThat(l.success === true && l.supported === false, JSON.stringify(l));
    expectThat(c.success === false && c.code === 'WEBMCP_UNAVAILABLE', JSON.stringify(c));
  });

  await check('SC4', 'call echo (main frame) with an input object', async () => {
    const r = await call({ tabId: TAB, name: 'echo', frame: 'main', input: { message: 'hi' } });
    expectThat(r.success && r.status === 'completed' && r.output === 'echo: hi' && r.untrustedContent === true, JSON.stringify(r));
    return r.output;
  });

  await check('SC4', 'call add_todo changes the page', async () => {
    const r = await call({ tabId: TAB, name: 'add_todo', input: { text: 'milk' } });
    const items = await pageEval(TAB, 'document.querySelectorAll("#todos li").length');
    expectThat(r.status === 'completed' && /milk/.test(r.output) && items === 1, `${JSON.stringify(r)} items=${items}`);
    return r.output;
  });

  await check('SC5', 'same name in two frames: AMBIGUOUS_TOOL, then frame "0" picks the iframe', async () => {
    const amb = await call({ tabId: TAB, name: 'echo', input: { message: 'x' } });
    expectThat(amb.code === 'AMBIGUOUS_TOOL' && amb.frames?.length === 2, JSON.stringify(amb));
    const r = await call({ tabId: TAB, name: 'echo', frame: '0', input: { message: 'hi' } });
    expectThat(r.output === 'frame echo: hi' && /webmcp-frame\.html$/.test(r.frameUrl), JSON.stringify(r));
  });

  await check('SC5', 'unknown name: TOOL_NOT_FOUND with available names', async () => {
    const r = await call({ tabId: TAB, name: 'nope' });
    expectThat(r.code === 'TOOL_NOT_FOUND' && r.available?.includes('echo'), JSON.stringify(r));
  });

  await check('SC6', 'consequential tool: refused without confirm (never ran), runs with confirm', async () => {
    const refused = await call({ tabId: TAB, name: 'place_order', input: { item: 'book' } });
    const before = await pageEval(TAB, 'window.__orders || 0');
    const ok = await call({ tabId: TAB, name: 'place_order', input: { item: 'book' }, confirm: true });
    const after = await pageEval(TAB, 'window.__orders || 0');
    expectThat(refused.code === 'CONFIRMATION_REQUIRED' && before === 0, `${JSON.stringify(refused)} before=${before}`);
    expectThat(ok.status === 'completed' && after === 1, `${JSON.stringify(ok)} after=${after}`);
  });

  await check('SC6', 'declarative forms: needs-user refusal; autosubmit needs confirm, then returns respondWith()', async () => {
    const form = await call({ tabId: TAB, name: 'search_form', input: { query: 'abc' }, confirm: true });
    const noConfirm = await call({ tabId: TAB, name: 'subscribe', input: { email: 'a@b.co' } });
    const ok = await call({ tabId: TAB, name: 'subscribe', input: { email: 'a@b.co' }, confirm: true });
    expectThat(form.code === 'DECLARATIVE_NEEDS_USER', JSON.stringify(form));
    expectThat(noConfirm.code === 'CONFIRMATION_REQUIRED' && noConfirm.reason === 'autosubmit-form', JSON.stringify(noConfirm));
    expectThat(ok.status === 'completed' && ok.output === 'Subscribed a@b.co', JSON.stringify(ok));
  });

  await check('SC6', 'shadow-root forms (open + closed) are declarative: gated, never submitted without confirm', async () => {
    const r = await list({ tabId: TAB });
    const find = (name) => r.tools.find((t) => t.name === name);
    expectThat(find('open_shadow_form')?.declarative === true && find('open_shadow_form')?.autoSubmit === true, `open: ${JSON.stringify(find('open_shadow_form'))}`);
    expectThat(find('closed_shadow_form')?.declarative === true && find('closed_shadow_form')?.autoSubmit === true, `closed: ${JSON.stringify(find('closed_shadow_form'))}`);
    const open = await call({ tabId: TAB, name: 'open_shadow_form', input: { q: 'x' } });
    const closed = await call({ tabId: TAB, name: 'closed_shadow_form', input: { q: 'x' } });
    const search = await call({ tabId: TAB, name: 'closed_shadow_search', input: { q: 'x' }, confirm: true });
    const submits = await pageEval(TAB, 'window.__shadowSubmits || 0');
    expectThat(open.code === 'CONFIRMATION_REQUIRED' && closed.code === 'CONFIRMATION_REQUIRED', `${open.code} / ${closed.code}`);
    expectThat(search.code === 'DECLARATIVE_NEEDS_USER', JSON.stringify(search));
    expectThat(submits === 0, `submits=${submits}`);
    const ok = await call({ tabId: TAB, name: 'closed_shadow_form', input: { q: 'x' }, confirm: true });
    expectThat(ok.status === 'completed' && ok.output === 'closed_shadow_form submitted', JSON.stringify(ok));
    return 'open + closed gated; confirmed run submitted once';
  });

  await check('SC6', 'a form in the iframe gates only the iframe tool, not the main-frame tool of the same name', async () => {
    const r = await list({ tabId: TAB, name: 'dup_tool' });
    const byFrame = Object.fromEntries(r.tools.map((t) => [t.frame, t.declarative]));
    expectThat(byFrame.main === false && byFrame['0'] === true, JSON.stringify(byFrame));
    const main = await call({ tabId: TAB, name: 'dup_tool', frame: 'main' });
    const frame = await call({ tabId: TAB, name: 'dup_tool', frame: '0', confirm: true });
    expectThat(main.status === 'completed' && main.output === 'main dup_tool ran', JSON.stringify(main));
    expectThat(frame.code === 'DECLARATIVE_NEEDS_USER', JSON.stringify(frame));
  });

  await check('SC7', 'timeout aborts a tool that ignores its signal; the tab keeps working', async () => {
    const t0 = Date.now();
    const r = await call({ tabId: TAB, name: 'slow_tool', timeout: 1_000 });
    const ms = Date.now() - t0;
    const after = await call({ tabId: TAB, name: 'echo', frame: 'main', input: { message: 'still alive' } });
    expectThat(r.code === 'WEBMCP_TOOL_CANCELED' && r.timedOut === true && ms < 4_000, `${JSON.stringify(r)} ${ms}ms`);
    expectThat(after.output === 'echo: still alive', JSON.stringify(after));
    return `${ms}ms`;
  });

  await check('SC8', 'a tool that throws: WEBMCP_TOOL_ERROR with the browser error name', async () => {
    const r = await call({ tabId: TAB, name: 'throws_tool' });
    expectThat(r.success === false && r.code === 'WEBMCP_TOOL_ERROR' && r.status === 'error' && r.errorName, JSON.stringify(r));
    return `${r.errorName}`;
  });

  await check('SC10', '120 000-char output comes back truncated and parseable', async () => {
    const r = await call({ tabId: TAB, name: 'big_output' });
    expectThat(r.status === 'completed' && r.outputTruncated === true && r.outputChars === 120_000, JSON.stringify(r).slice(0, 300));
    return `${r.output.length} chars kept`;
  });

  await check('SC9', 'main-frame navigation during a call: non-error unknown outcome', async () => {
    const r = await call({ tabId: TAB, name: 'navigate_away', timeout: 10_000 });
    expectThat(r.success === true && r.status === 'unknown' && r.code === 'WEBMCP_NAVIGATED', JSON.stringify(r));
  });

  console.log(`WebMCP smoke — ${version.Browser} (headless, isolated profile)\n`);
  for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.sc.padEnd(4)}  ${r.label}${r.detail ? `  — ${r.detail}` : ''}`);
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed (SC11 "no debugger" is unit-tested only).`);
  exitCode = failed ? 1 : 0;
} catch (err) {
  console.error(`Smoke run failed: ${err.stack || err.message}`);
  exitCode = 1;
} finally {
  await cleanup();
}
process.exit(exitCode);
