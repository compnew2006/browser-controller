#!/usr/bin/env node
/**
 * End-to-end MCP test: navigate google.com → search "mcp" → extract 5 topics,
 * measuring the estimated token cost of each tool response.
 *
 * Connects to the daemon over IPC (same wire format as index.ts DaemonClient).
 * Token estimate: ~4 chars/token (conventional rule-of-thumb for English+JSON).
 *
 * Output is force-flushed (blocking stdout) so it survives a `timeout` SIGTERM.
 */
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';

const SOCK = os.homedir() + '/.browser-controller/daemon.sock';
const TOKEN = JSON.parse(fs.readFileSync(os.homedir() + '/.browser-controller/token.json', 'utf8')).token;

process.stdout._handle?.setBlocking?.(true);
const log = (...a) => process.stdout.write(a.join(' ') + '\n');

const sock = net.createConnection(SOCK);
sock.setEncoding('utf8');
let buf = '', sid = null, c = 0;
const pend = new Map();

sock.on('data', (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let m; try { m = JSON.parse(line); } catch { continue; }
    if (m.kind === 'welcome') { sid = m.sessionId; continue; }
    if (m.kind === 'ping') { sock.write(JSON.stringify({ kind: 'pong' }) + '\n'); continue; }
    if (m.kind === 'result') {
      const w = pend.get(m.id);
      if (w) { w.resolve(m); pend.delete(m.id); }
    }
  }
});
// Daemon protocol: client must send `hello` FIRST; only then does the daemon
// reply `welcome`. (Waiting for welcome before hello deadlocks — see daemon.ts.)
sock.on('connect', () => {
  sock.write(JSON.stringify({ kind: 'hello', token: TOKEN, agentName: 'TokenProbe' }) + '\n');
});
sock.on('error', (e) => { log('SOCK ERR', e.message); process.exit(1); });

const call = (tool, params) => new Promise((res, rej) => {
  const id = 'x' + (++c);
  pend.set(id, { resolve: res, reject: rej });
  sock.write(JSON.stringify({ kind: 'call', id, tool, params }) + '\n');
  setTimeout(() => { if (pend.has(id)) { pend.delete(id); rej(new Error('timeout ' + tool)); } }, 30000);
});
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const est = (s) => { const n = (typeof s === 'string' ? s : JSON.stringify(s)).length; return { mid: Math.round(n / 4), chars: n }; };

const totals = { mid: 0, chars: 0 };
const steps = [];
async function step(name, tool, params) {
  const t0 = Date.now();
  const r = await call(tool, params);
  const ms = Date.now() - t0;
  if (!r.success) { log('▶ ' + name + ' ... FAIL (' + ms + 'ms): ' + r.error); throw new Error(r.error); }
  const payload = JSON.stringify(r.result ?? '');
  const e = est(payload);
  totals.mid += e.mid; totals.chars += e.chars;
  steps.push({ name, ms, e });
  log('▶ ' + name + ' ... ok (' + ms + 'ms, ~' + e.mid + ' tok, ' + e.chars + ' chars)');
  return r.result;
}

await new Promise((r) => { const i = setInterval(() => { if (sid) { clearInterval(i); r(); } }, 20); });
await sleep(200);
log('Connected as ' + sid);

try {
  const cr = await call('browser_tabs', { action: 'create', url: 'about:blank' });
  const tabId = cr.result?.tabId ?? cr.result?.tabs?.[0]?.id;
  if (typeof tabId !== 'number') throw new Error('could not extract tabId from create: ' + JSON.stringify(cr.result));
  log('(created tab ' + tabId + ')');

  await step('navigate google.com', 'browser_navigate', { tabId, url: 'https://www.google.com' });
  await sleep(1500);

  await step('navigate search?q=mcp', 'browser_navigate', { tabId, url: 'https://www.google.com/search?q=mcp' });
  await sleep(2500);

  const snapRaw = await step('snapshot results', 'browser_snapshot', { tabId, compact: true });
  const snapStr = typeof snapRaw === 'string' ? snapRaw : JSON.stringify(snapRaw);

  let snapObj = null; try { snapObj = JSON.parse(snapStr); } catch {}
  const topics = [];
  if (snapObj && snapObj.tree) {
    const walk = (n) => {
      if (!n || topics.length >= 10) return;
      const txt = n.name || n.text;
      if (typeof txt === 'string' && txt.length > 12 && txt.length < 200 &&
          n.role !== 'link' && n.role !== 'navigation' && /[a-zA-Z]{4}/.test(txt) &&
          !/^(search|images|maps|news|shopping|gmail|sign in|accounts|filter|tools|settings|privacy|terms)/i.test(txt)) {
        topics.push(txt);
      }
      if (n.children) n.children.forEach(walk);
    };
    walk({ children: snapObj.tree });
  }

  log('');
  log('══════════════════════════════════════════');
  log('5 topics from the "mcp" search results:');
  log('══════════════════════════════════════════');
  if (topics.length === 0) {
    log('(parser found none — raw first 800 chars of snapshot:)');
    log(snapStr.slice(0, 800));
  } else {
    topics.slice(0, 5).forEach((t, i) => log('  ' + (i + 1) + '. ' + t.replace(/\s+/g, ' ').slice(0, 140)));
  }

  log('');
  log('══════════════════════════════════════════');
  log('TOKEN USAGE (response payload estimate, ~4 chars/token)');
  log('══════════════════════════════════════════');
  log('  Step' + ' '.repeat(28) + '~tokens' + ' '.repeat(6) + 'chars' + ' '.repeat(6) + 'ms');
  log('  ' + '─'.repeat(60));
  steps.forEach(s => {
    log('  ' + s.name.padEnd(30) + String(s.e.mid).padStart(7) + String(s.e.chars).padStart(11) + String(s.ms).padStart(8));
  });
  log('  ' + '─'.repeat(60));
  log('  ' + 'TOTAL'.padEnd(30) + String(totals.mid).padStart(7) + String(totals.chars).padStart(11));
  log('  (range: ' + Math.round(totals.chars / 4.5) + '–' + Math.round(totals.chars / 3.5) + ' tokens)');
} catch (e) {
  log('FAILED:', e.message);
  process.exit(1);
}
log('✓ Done.');
process.exit(0);
