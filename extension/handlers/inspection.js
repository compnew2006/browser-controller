/**
 * Inspection handlers, the read side of the toolset (contract 3.0): browser_snapshot,
 * browser_text, browser_wait and browser_scroll (browser_evaluate is handlers/evaluate.js).
 * Each answers with compact text (`text`, the one thing the agent reads); the other fields
 * are machine data for the server and the tests.
 */
import { safeExec, execDom, resolveTab, getFallback } from '../lib/page-exec.js';
import { requireSender, pointInfo, releaseShield } from '../lib/trusted-input.js';
import { withFrames } from '../lib/drag-input.js';
import { sleep } from '../lib/timing.js';
import { waitPage } from '../lib/wait-page.js';
import { snapshotPage } from './snapshot-page.js';
import { fallbackByTab, persistSessionState } from '../lib/state.js';
import { PAGE_FALLBACK_INSTALL } from '../utils/smart-selector.js';
import { parseTarget, targetLabel } from '../lib/target.js';
import { refErrorMessage, reboundNote } from '../lib/ref-errors.js';
import { dispatchAgentInput } from '../lib/overlay.js';

/** browser_snapshot: the default and the largest `maxChars`. */
export const SNAPSHOT_MAX_CHARS = 8_000;
const SNAPSHOT_HARD_MAX_CHARS = 50_000;
/** browser_text: the default and the largest `maxChars`. */
const TEXT_MAX_CHARS = 20_000;
const TEXT_HARD_MAX_CHARS = 100_000;
/** browser_wait: the default and the largest `timeout`, in ms. */
const WAIT_DEFAULT_MS = 10_000;
const WAIT_HARD_MAX_MS = 50_000;
/** browser_scroll: the wheel's smooth scroll is polled until the position stops moving. */
const SCROLL_FIRST_CHECK_MS = 150;
const SCROLL_POLL_MS = 100;
const SCROLL_SETTLE_MS = 1_500;
/** A wheel aimed at a container with room to move: how long its first movement may take (a background tab holds the wheel for its next frame). */
const SCROLL_START_MS = 1_500;

/** An integer option within [lo, hi]; `fallback` when it is missing. */
function intOption(value, lo, hi, fallback) {
  const n = Number.isFinite(value) ? Math.floor(value) : fallback;
  return Math.min(hi, Math.max(lo, n));
}

/** A page result's failure as the wire error. A ref miss is worded from `issued` (lib/ref-errors.js). */
function failureOf(res) {
  if (res && res.error === 'REF_GONE') return { success: false, error: refErrorMessage(res.ref, !!res.issued, !!res.earlier) };
  return { success: false, error: (res && res.error) || 'SCRIPT_ERROR: the page did not answer; try again' };
}

/** The note line a reply carries when its target ref was re-found by its descriptor ("" when it was not). */
const reboundLine = (ref) => (ref ? `\n${reboundNote(ref)}` : '');

/** The fallback descriptor of a ref target (the snapshot's re-find recipe), or null. */
function fallbackFor(tabId, parsed) {
  return parsed && parsed.kind === 'ref' ? getFallback(tabId, parsed.ref) : null;
}

/** browser_wait: a `url` glob ("*" = any run of characters) as a RegExp source, anchored to the whole URL. */
function globSource(pattern) {
  return `^${pattern.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`;
}

/**
 * browser_wait (contract 3.0): exactly one of target / url / ms. `target` waits until it
 * is visible (`gone: true`: hidden or removed); `url` is a substring of location.href, or
 * a glob when it has a `*`; `ms` is a plain delay that must fit in the timeout.
 */
export async function handleWait(params, _sessionId, _agentName, signal) {
  const { tabId, target, gone = false, url, ms } = params;
  const given = [target != null, url != null && url !== '', ms != null].filter(Boolean).length;
  if (given !== 1) throw new Error('INVALID_ARGUMENT: give exactly one of target, url or ms');
  if (gone && target == null) throw new Error('INVALID_ARGUMENT: gone applies to target only');
  const requested = Number.isFinite(params.timeout) ? params.timeout : WAIT_DEFAULT_MS;
  const timeout = Math.min(Math.max(0, requested), WAIT_HARD_MAX_MS);
  const notes = requested > WAIT_HARD_MAX_MS ? [`note: timeout capped at ${WAIT_HARD_MAX_MS} ms (requested ${requested})`] : [];
  const started = Date.now();
  const elapsed = () => Date.now() - started;
  const ok = (extra = []) => ({ success: true, text: [`ok after ${elapsed()} ms`, ...notes, ...extra].join('\n'), elapsed: elapsed() });

  if (ms != null) {
    if (!(ms >= 0)) throw new Error('INVALID_ARGUMENT: ms must be a number of milliseconds');
    if (ms > timeout) throw new Error(`INVALID_ARGUMENT: ms (${ms}) is longer than timeout (${timeout}); raise timeout or lower ms`);
    await sleep(ms);
    return ok();
  }

  await resolveTab(tabId);
  const parsed = target == null ? null : parseTarget(target);
  const fb = fallbackFor(tabId, parsed);
  const urlRe = parsed == null && url.includes('*') ? globSource(url) : null;
  const condition = parsed
    ? `target ${targetLabel(target)} ${gone ? 'gone' : 'visible'}`
    : `url ${urlRe ? 'matching' : 'containing'} "${url}"`;
  let last = null;
  // Each poll is raced against the deadline and the abort: execDom can overrun its budget (install
  // plus retry, a frozen page), and the wait must still end with its own result inside the 55 s tool timeout.
  const cancelledReply = { success: false, error: 'TIMEOUT: wait cancelled by the caller' };
  let timer;
  const deadline = new Promise((resolve) => { timer = setTimeout(() => resolve({ __expired: true }), timeout); });
  const cancelled = new Promise((resolve) => {
    if (signal?.aborted) resolve(cancelledReply);
    else signal?.addEventListener('abort', () => resolve(cancelledReply), { once: true });
  });
  try {
    for (;;) {
      if (signal?.aborted) return cancelledReply;
      // A poll that cannot run (navigation in progress) is "not met yet", not a failure.
      const poll = await Promise.race([
        execDom(tabId, waitPage, [parsed, fb, gone, url ?? null, urlRe], { timeoutMs: Math.max(1, timeout - elapsed()) }).catch(() => null),
        deadline,
        cancelled,
      ]);
      if (poll === cancelledReply) return cancelledReply;
      if (poll && poll.__expired) break;
      if (poll && poll.error) return failureOf(poll);
      if (poll) last = poll;
      if (poll && poll.met) return ok(poll.rebound ? [reboundNote(poll.rebound)] : []);
      if (elapsed() >= timeout) break;
      if (await Promise.race([sleep(Math.min(200, Math.max(0, timeout - elapsed()))), cancelled]) === cancelledReply) return cancelledReply;
    }
  } finally {
    clearTimeout(timer);
  }
  // The last look found the ref's element gone: say so, so the agent takes a new snapshot instead of waiting again.
  const refGone = last?.refGone && parsed ? ` (ref ${parsed.ref} is no longer on the page)` : '';
  const miss = gone ? '' : { NOT_FOUND: ' (it matched nothing: check the selector or take a snapshot)', ELEMENT_HIDDEN: ' (it matched only hidden elements)' }[last?.miss] || '';
  return { success: false, error: `TIMEOUT: ${condition} not met after ${timeout} ms${refGone}${miss}` };
}

/** The position line of a scroll reply: `x: 40 y: 1234 atEnd: false` (x only when scrolled sideways). */
function positionLine(pos, dx, atEnd) {
  return [...(dx ? [`x: ${pos.x}`] : []), `y: ${pos.y}`, `atEnd: ${atEnd}`].join(' ');
}

/** The edge a scroll heads for, for the NOT_SCROLLABLE reason. */
function edgeOf(dx, dy) {
  if (dy !== 0) return dy > 0 ? 'bottom' : 'top';
  return dx > 0 ? 'right' : 'left';
}

/**
 * browser_scroll (contract 3.0). `target` alone scrolls it into view (instant). With dx/dy,
 * a real mouse wheel (CDP Input.dispatchMouseEvent) at the target's centre, or the viewport
 * centre; the wheel scrolls whatever scroll container is under that point. Nothing moving is
 * NOT_SCROLLABLE. The wheel needs the debugger: DEBUGGER_UNAVAILABLE, never a synthetic scroll.
 */
export async function handleScroll(params, _sessionId, _agentName, _signal, activityRecorder) {
  const { tabId, target } = params;
  const wheel = Number.isFinite(params.dx) || Number.isFinite(params.dy);
  if (!wheel && target == null) throw new Error('INVALID_ARGUMENT: give target (to bring it into view) or dx/dy (to scroll)');
  const dx = Number.isFinite(params.dx) ? Math.round(params.dx) : 0;
  const dy = Number.isFinite(params.dy) ? Math.round(params.dy) : 0;
  await resolveTab(tabId);
  const parsed = target == null ? null : parseTarget(target);
  const fb = fallbackFor(tabId, parsed);

  if (!wheel) {
    if (parsed.kind === 'point') throw new Error('INVALID_ARGUMENT: a point target needs dx or dy to scroll');
    const res = await execDom(tabId, scrollIntoViewPage, [parsed, fb]);
    if (res.success !== true) return failureOf(res);
    if (!res.inView) return { success: false, error: 'NOT_SCROLLABLE: nothing moved and the element is still out of view' };
    return { success: true, text: positionLine(res.position, 0, res.atEnd) + reboundLine(res.rebound), container: res.container, position: res.position };
  }

  // Checked before anything moves on the page: a wheel needs the debugger, and nothing scrolls without it.
  const send = await requireSender(tabId);
  const aim = await execDom(tabId, scrollAimPage, [parsed, fb, dx, dy]);
  if (aim.success !== true) return failureOf(aim);
  const before = await execDom(tabId, scrollStatePage, [dx, dy]);
  await pointInfo(tabId, aim.x, aim.y); // opens the agent's input window (lib/overlay.js) and glides the cursor
  let after;
  try {
    // A background tab holds the wheel until it draws a frame: keep frames coming until the scroll settles.
    after = await withFrames(tabId, send, async () => {
      try {
        await dispatchAgentInput(tabId, send, 'Input.dispatchMouseEvent', { type: 'mouseWheel', x: aim.x, y: aim.y, deltaX: dx, deltaY: dy });
        activityRecorder?.observe?.('Input.dispatchMouseEvent', { type: 'mouseWheel' }, 'sent');
      } catch (error) {
        activityRecorder?.observe?.('Input.dispatchMouseEvent', { type: 'mouseWheel' }, 'unknown');
        throw error;
      }
      return settleScroll(tabId, dx, dy, aim.room ? before : null);
    });
  } finally {
    await releaseShield(tabId);
  }
  if (after.x === before.x && after.y === before.y) {
    const why = before.atEnd
      ? `already at the ${edgeOf(dx, dy)} edge of ${aim.container}`
      : `nothing scrollable at ${aim.x},${aim.y} toward the ${edgeOf(dx, dy)}`;
    return { success: false, error: `NOT_SCROLLABLE: nothing moved (${why})`, moved: false, position: { x: after.x, y: after.y } };
  }
  return {
    success: true,
    text: positionLine(after, dx, after.atEnd) + reboundLine(aim.rebound),
    moved: true,
    position: { x: after.x, y: after.y },
    atEnd: after.atEnd,
    container: aim.container,
  };
}

/**
 * Polls the scroll position until two reads in a row agree (a wheel scrolls smoothly), or the
 * settle budget ends. With `before` (the container has room to move that way), a position that
 * has not left `before` yet is no answer until SCROLL_START_MS: a background tab can hold the
 * wheel until it draws its next frame, and two still reads before that are not "nothing moved".
 */
async function settleScroll(tabId, dx, dy, before = null) {
  await sleep(SCROLL_FIRST_CHECK_MS);
  let last = await execDom(tabId, scrollStatePage, [dx, dy]);
  const startBy = Date.now() + SCROLL_START_MS;
  while (before && last.x === before.x && last.y === before.y && Date.now() < startBy) {
    await sleep(SCROLL_POLL_MS);
    last = await execDom(tabId, scrollStatePage, [dx, dy]);
  }
  let still = 0;
  const deadline = Date.now() + SCROLL_SETTLE_MS;
  while (Date.now() < deadline && still < 2) {
    await sleep(SCROLL_POLL_MS);
    const now = await execDom(tabId, scrollStatePage, [dx, dy]);
    still = now.x === last.x && now.y === last.y ? still + 1 : 0;
    last = now;
  }
  return last;
}

/**
 * Page side of a wheel: where the wheel lands (the target's centre, after scrolling it into
 * view, or the viewport centre) and the scroll container under that point that can move.
 */
function scrollAimPage(_t, _fb, _dx, _dy) {
  const D = globalThis.__bcDom;
  if (!D || !D.resolveTarget) return { __needDom: true };
  let x = (window.innerWidth || 0) / 2;
  let y = (window.innerHeight || 0) / 2;
  let rebound = null;
  if (_t && _t.kind === 'point') {
    x = _t.x;
    y = _t.y;
  } else if (_t) {
    const r = D.resolveTarget(_t, _fb);
    if (r.error) return { success: false, error: r.error, ref: r.ref, issued: r.issued, earlier: r.earlier };
    if (!r.el) return { success: false, error: 'NOT_FOUND: no element to scroll at' };
    if (!D.isVisible(r.el)) return { success: false, error: `ELEMENT_HIDDEN: ${D.describe(r.el)} is not displayed; nothing to scroll` };
    if (r.via === 'fallback') rebound = _t.ref;
    r.el.scrollIntoView({ behavior: 'instant', block: 'center', inline: 'center' });
    const c = D.centerOf(r.el);
    x = c.x;
    y = c.y;
  }
  const scrolls = (ov) => /(auto|scroll|overlay)/.test(ov || '');
  const movable = (n) => {
    const st = D.styleOf(n) || {};
    if (_dy !== 0 && scrolls(st.overflowY) && n.scrollHeight - n.clientHeight > 1) {
      if (_dy > 0 ? n.scrollTop + n.clientHeight < n.scrollHeight - 1 : n.scrollTop > 0) return true;
    }
    if (_dx !== 0 && scrolls(st.overflowX) && n.scrollWidth - n.clientWidth > 1) {
      if (_dx > 0 ? n.scrollLeft + n.clientWidth < n.scrollWidth - 1 : n.scrollLeft > 0) return true;
    }
    return false;
  };
  let scroller = null;
  for (let n = D.elementAt(x, y); n && !scroller; n = n.parentElement || (n.getRootNode && n.getRootNode().host) || null) {
    if (n.nodeType === 1 && movable(n)) scroller = n;
  }
  const page = document.scrollingElement || document.documentElement;
  if (!scroller) scroller = page;
  globalThis.__bcScroller = scroller;
  // Room to move that way: the page has it when its content runs past the viewport on that side.
  const pageRoom = (_dy > 0 && page.scrollTop + page.clientHeight < page.scrollHeight - 1) || (_dy < 0 && page.scrollTop > 0)
    || (_dx > 0 && page.scrollLeft + page.clientWidth < page.scrollWidth - 1) || (_dx < 0 && page.scrollLeft > 0);
  const room = scroller !== page || pageRoom;
  return { success: true, x, y, room, container: scroller === page ? 'page' : D.describe(scroller), rebound };
}

/** Page side: the scroll position of the container the last wheel aimed at, and whether it is at the edge it heads for. */
function scrollStatePage(_dx, _dy) {
  const s = globalThis.__bcScroller || document.scrollingElement || document.documentElement;
  const x = s.scrollLeft || 0;
  const y = s.scrollTop || 0;
  const cw = s.clientWidth || 0;
  const ch = s.clientHeight || 0;
  const sw = s.scrollWidth || 0;
  const sh = s.scrollHeight || 0;
  let atEnd = y + ch >= sh - 1;
  if (_dy !== 0) atEnd = _dy > 0 ? y + ch >= sh - 1 : y <= 0;
  else if (_dx !== 0) atEnd = _dx > 0 ? x + cw >= sw - 1 : x <= 0;
  return { x, y, atEnd };
}

/** Page side of `target` alone: scroll it into view (instant) and report the container that moved. */
function scrollIntoViewPage(_t, _fb) {
  const D = globalThis.__bcDom;
  if (!D || !D.resolveTarget) return { __needDom: true };
  const r = D.resolveTarget(_t, _fb);
  if (r.error) return { success: false, error: r.error, ref: r.ref, issued: r.issued, earlier: r.earlier };
  const el = r.el;
  if (!el) return { success: false, error: 'NOT_FOUND: no element to scroll to' };
  if (!D.isVisible(el)) return { success: false, error: `ELEMENT_HIDDEN: ${D.describe(el)} is not displayed; it cannot be scrolled to` };
  el.scrollIntoView({ behavior: 'instant', block: 'center', inline: 'center' });
  const scrolls = (ov) => /(auto|scroll|overlay)/.test(ov || '');
  let box = null;
  for (let n = el.parentElement; n && !box; n = n.parentElement) {
    const st = D.styleOf(n) || {};
    if (scrolls(st.overflowY) || scrolls(st.overflowX)) box = n;
  }
  const page = document.scrollingElement || document.documentElement;
  const s = box || page;
  globalThis.__bcScroller = s;
  const rect = el.getBoundingClientRect();
  const inView = rect.bottom > 0 && rect.right > 0 && rect.top < (window.innerHeight || 0) && rect.left < (window.innerWidth || 0);
  const y = s.scrollTop || 0;
  return {
    success: true,
    inView,
    rebound: r.via === 'fallback' ? _t.ref : null,
    container: box ? D.describe(box) : 'page',
    position: { x: s.scrollLeft || 0, y },
    atEnd: y + (s.clientHeight || 0) >= (s.scrollHeight || 0) - 1,
  };
}

/**
 * browser_snapshot (contract 3.0): the page as text lines, one per element that matters,
 * indented by depth: `role "name" [e12] value="…" checked disabled …`. Shadow DOM and
 * same-origin frames are walked; hidden subtrees, passwords and cross-origin frames are
 * handled as before. `target` is the subtree root, `query` keeps the elements that hold every
 * word of it (whole words first) with their ancestors, `maxChars` cuts in page order.
 */
export async function handleSnapshot(params) {
  const { tabId, target, query } = params;
  if (params.since != null && params.delta !== true) throw new Error('INVALID_ARGUMENT: since requires delta:true');
  const max = intOption(params.maxChars, 1, SNAPSHOT_HARD_MAX_CHARS, SNAPSHOT_MAX_CHARS);
  await resolveTab(tabId);
  const parsed = target == null ? null : parseTarget(target);
  const fb = fallbackFor(tabId, parsed);
  // The smart-selector runtime gives every ref its re-find descriptor (lib/state.js fallbacks).
  await safeExec(tabId, PAGE_FALLBACK_INSTALL, []);
  const q = query == null ? null : String(query).trim() || null;
  const res = await execDom(tabId, snapshotPage, [parsed, fb, q, max, params.delta === true]);
  if (!res || res.success !== true) return failureOf(res);
  // Fallbacks merge, not replace: a scoped snapshot must not drop the refs of an earlier one.
  if (res.__fallbacks) {
    const map = fallbackByTab.get(tabId) || new Map();
    for (const [ref, fbEntry] of Object.entries(res.__fallbacks)) map.set(ref, fbEntry);
    while (map.size > 3000) map.delete(map.keys().next().value);
    fallbackByTab.set(tabId, map);
    persistSessionState();
  }
  const { __fallbacks, __snapshotEpoch, rebound, ...reply } = res;
  // A target re-found by its snapshot descriptor: the reply says so, on its own line at the end.
  const full = rebound ? { ...reply, text: `${reply.text}\n${reboundNote(rebound)}` } : reply;
  // Comparison belongs after daemon vault sanitization; expose only the page's
  // ephemeral identity as machine metadata and leave the full text untouched.
  return params.delta === true ? { ...full, snapshotEpoch: __snapshotEpoch } : full;
}

/**
 * browser_text (contract 3.0): the readable text of the page, or of `target`, through one
 * walker (same-origin frames and open shadow roots included; hidden text excluded).
 */
export async function handleGetPageText(params) {
  const { tabId, target } = params;
  const max = intOption(params.maxChars, 1, TEXT_HARD_MAX_CHARS, TEXT_MAX_CHARS);
  await resolveTab(tabId);
  const parsed = target == null ? null : parseTarget(target);
  const fb = fallbackFor(tabId, parsed);
  const res = await execDom(tabId, textPage, [parsed, fb, max]);
  if (res.success !== true) return failureOf(res);
  const note = reboundLine(res.rebound);
  if (res.length === 0) return { success: true, url: res.url, title: res.title, text: `(no visible text)${note}`, length: 0, truncated: false };
  const body = res.total > max ? `${res.text}\n… truncated (${res.total - max} more chars)` : res.text;
  return { success: true, url: res.url, title: res.title, text: `${body}${note}`, length: res.total, truncated: res.total > max };
}

/** Page side of browser_text: the visible text of the root, cut to `max` (the rest is only counted). */
function textPage(_t, _fb, _max) {
  const D = globalThis.__bcDom;
  if (!D || !D.resolveTarget || !D.flatText) return { __needDom: true };
  let root = document.body || null;
  let rebound = null;
  if (_t) {
    const r = D.resolveTarget(_t, _fb);
    if (r.error) return { success: false, error: r.error, ref: r.ref, issued: r.issued, earlier: r.earlier };
    if (r.via === 'fallback') rebound = _t.ref;
    root = r.el || null;
    if (!root) return { success: false, error: 'NOT_FOUND: no element at that point' };
    if (!D.isVisible(root)) return { success: false, error: `ELEMENT_HIDDEN: ${D.describe(root)} is not displayed; it has no visible text` };
  }
  if (!root) return { success: false, error: 'NOT_FOUND: the page has no body' };
  const rawText = D.flatText(root);
  const full = D.redactSensitiveText ? D.redactSensitiveText(rawText, root) : rawText;
  return { success: true, url: location.href, title: document.title, text: full.slice(0, _max), total: full.length, length: full.length, rebound };
}
