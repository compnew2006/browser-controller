/**
 * Inspection handlers (extracted from background.js): wait, scroll, snapshot,
 * find, text, evaluate — the read side of the toolset.
 */
import { safeExec, execDom, resolveTab, getFallback, assertResponsive, hasPoint } from '../lib/page-exec.js';
import { trustedSender, pointInfo, releaseShield } from '../lib/trusted-input.js';
import { fallbackByTab, lastSnapshotFingerprints, MAX_RESULT_CHARS, persistSessionState, nextRefPrefix } from '../lib/state.js';
import { PAGE_FALLBACK_INSTALL } from '../utils/smart-selector.js';
import { withCdp } from '../lib/cdp-session.js';
import { cdpEvaluate } from '../lib/cdp-evaluate.js';
import { handleFind } from './find.js';

/** Default output cap for snapshots (characters of lines). */
export const SNAPSHOT_MAX_CHARS = 12_000;

export async function handleWait(params, _sessionId, _agentName, signal) {
  const { tabId, selector, state = 'visible', timeout = 10000, delay, text, urlIncludes } = params;

  // A promise that rejects when this call is cancelled (client gone / bridge
  // timeout forwarded). Long waits race against it so a cancelled call releases
  // the tab mutex immediately instead of blocking later calls on the same tab.
  const abortRace = signal
    ? new Promise((_, reject) => {
        if (signal.aborted) reject(new Error('aborted'));
        else signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      })
    : null;

  const hasCondition = !!selector || text != null || !!urlIncludes;
  if (delay) {
    const sleep = new Promise((r) => setTimeout(r, Math.min(delay, 30000)));
    try {
      await (abortRace ? Promise.race([sleep, abortRace]) : sleep);
    } catch {
      return { success: false, error: 'aborted', waited: 0 };
    }
    return { success: true, waited: delay }; // documented: a delay ignores the conditions
  }

  if (!hasCondition) return { success: false, error: 'Need selector, text, urlIncludes or delay' };
  await resolveTab(tabId);
  const start = Date.now();
  const what = selector || (text != null ? `text "${text}"` : `url containing "${urlIncludes}"`);

  while (Date.now() - start < timeout) {
    // Bail the moment the caller is gone so we don't pin the tab mutex for the
    // full timeout window after the originating agent was evicted (consistent
    // with handleNavigate / handleRunAction).
    if (signal?.aborted) return { success: false, error: 'aborted', selector, state };
    let found;
    try {
      found = await execDom(tabId, (_sel, _state, _text, _url) => {
        const D = globalThis.__bcDom;
        if (!D) return { __needDom: true };
        const hidden = _state === 'hidden';
        if (_url != null && !location.href.includes(_url)) return false;
        if (_text != null) {
          const has = D.pageText(document.body).toLowerCase().includes(String(_text).toLowerCase());
          if (hidden ? has : !has) return false;
        }
        if (_sel) {
          // Every match across shadow roots / same-origin frames, not just the first.
          const all = D.queryAll(_sel, true);
          if (all === null) return { error: `Invalid CSS selector: ${_sel}` };
          if (_state === 'attached') return all.length > 0;
          const anyVisible = all.some((el) => D.isVisible(el));
          return hidden ? !anyVisible : anyVisible;
        }
        return true;
      }, [selector ?? null, state, text ?? null, urlIncludes ?? null]);
    } catch { found = false; /* navigating: the next document isn't ready yet */ }
    if (found && found.error) return { success: false, error: found.error };

    if (found === true) {
      return {
        success: true,
        ...(selector ? { selector } : {}),
        ...(text != null ? { text } : {}),
        ...(urlIncludes ? { urlIncludes } : {}),
        state,
        elapsed: Date.now() - start,
      };
    }
    await new Promise((r) => setTimeout(r, 200));
  }

  return { success: false, error: `Timeout waiting for ${what} to be ${state}` };
}

export async function handleScroll(params) {
  const { tabId, direction = 'down', amount = 500, selector, toElement, position } = params;
  await resolveTab(tabId);
  // x/y: a real mouse-wheel event at that point — scrolls whatever is under
  // it (inner panels, maps, virtual lists) exactly like a user's wheel.
  if (hasPoint(params) && !toElement && !position && !selector) {
    const send = await trustedSender(tabId, true);
    if (!send) throw new Error(`Scrolling at x/y needs the debugger (CDP), which could not attach to tab ${tabId}. Use selector/toElement instead.`);
    const deltaX = direction === 'right' ? amount : direction === 'left' ? -amount : 0;
    const deltaY = direction === 'down' ? amount : direction === 'up' ? -amount : 0;
    const info = await pointInfo(tabId, params.x, params.y);
    try {
      await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: params.x, y: params.y, deltaX, deltaY });
    } finally {
      await releaseShield(tabId);
    }
    return { success: true, input: 'cdp', at: { x: params.x, y: params.y }, deltaX, deltaY, refsMayBeStale: true, ...(info.hit ? { over: info.hit } : {}) };
  }
  const fb = getFallback(tabId, toElement);

  return execDom(tabId, (_dir, _amt, _sel, _toEl, _pos, _fb) => {
    const D = globalThis.__bcDom;
    if (!D) return { __needDom: true };
    if (_toEl) {
      // toElement accepts a ref or a CSS selector (first visible match).
      let el = D.resolve(_toEl, null, _fb).el;
      if (!el) { try { el = D.resolve(null, _toEl, null).el; } catch { el = null; } }
      if (el) {
        el.scrollIntoView({ behavior: 'instant', block: 'center' });
        return { success: true, scrolledTo: 'element' };
      }
      return { success: false, error: 'Element not found' };
    }

    const target = _sel ? D.resolve(null, _sel, null).el : window;
    if (!target) return { success: false, error: 'Scroll container not found' };

    if (_pos === 'top') {
      if (target === window) window.scrollTo({ top: 0, behavior: 'smooth' });
      else target.scrollTop = 0;
      return { success: true, scrolledTo: 'top' };
    }
    if (_pos === 'bottom') {
      if (target === window) window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
      else target.scrollTop = target.scrollHeight;
      return { success: true, scrolledTo: 'bottom' };
    }

    const scrollOpts = { behavior: 'smooth' };
    if (_dir === 'down') scrollOpts.top = _amt;
    else if (_dir === 'up') scrollOpts.top = -_amt;
    else if (_dir === 'right') scrollOpts.left = _amt;
    else if (_dir === 'left') scrollOpts.left = -_amt;

    if (target === window) window.scrollBy(scrollOpts);
    else target.scrollBy(scrollOpts);

    return { success: true, direction: _dir, amount: _amt };
  }, [direction, amount, selector, toElement, position, fb]).then((res) => {
    // Scrolling a virtualized feed (FB/IG/Twitter) recycles DOM nodes, so any
    // refs the agent holds are now likely stale. Hint it to re-snapshot. We
    // don't auto-snapshot here (every scroll would be expensive); the hint is
    // enough for a well-behaved agent to snapshot before its next interaction.
    if (res && res.success) res.refsMayBeStale = true;
    return res;
  });
}

/**
 * Page-side snapshot: interactive elements, landmarks and headings of the
 * flat tree (shadow DOM, slots, same-origin iframes) as indented lines,
 *   - role "name" [ref] checked value="…" (row: …)   (+ → /path for links with _links)
 * "+ " instead of "- " marks an element that was not in the previous snapshot.
 * Refs go into the shared page registry (lib/page-dom.js); recovery
 * descriptors come back in __fallbacks for the extension to keep.
 */
function pageSnapshot(_sel, _rootRef, _prevFingerprints, _refPrefix, _maxChars, _links) {
  const D = globalThis.__bcDom;
  if (!D) return { __needDom: true };
  const genFallback = (globalThis.__browserControllerFallbackRuntime || {}).generateFallback || null;
  const fallbacks = {};
  const fingerprints = [];
  const prevSet = _prevFingerprints ? new Set(_prevFingerprints) : null;
  const skipTags = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'PATH', 'BR', 'HR', 'WBR', 'META', 'LINK']);
  const landmarkRoles = new Set(['navigation', 'main', 'banner', 'contentinfo', 'form', 'search', 'complementary', 'region', 'dialog']);
  let budget = _maxChars;
  let truncated = false;
  let refCount = 0;

  // 'show' = render normally, 'pass' = no box of its own (display:contents,
  // slots, hidden-but-overridable) but children may render, false = hidden subtree.
  function vis(el) {
    const s = D.styleOf(el);
    if (!s || s.display === 'none' || el.inert || D.attr(el, 'aria-hidden') === 'true') return false;
    if (s.display === 'contents' || el.tagName === 'SLOT') return 'pass';
    if (s.visibility === 'hidden' || s.visibility === 'collapse') return 'pass'; // inherited, can be re-enabled below
    if (parseFloat(s.opacity) === 0) return false;
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) return 'show';
    return el.childElementCount > 0 || D.shadowOf(el) ? 'pass' : false;
  }
  // Landmarks are named only by an explicit label: their text is just their children again.
  const nameFor = (el, r) => (landmarkRoles.has(r) && r !== 'dialog'
    ? D.clean(D.attr(el, 'aria-label') || D.attr(el, 'title'))
    : D.nameOf(el)).slice(0, 80);
  const origin = location.origin;
  const short = (s, n) => (s.length > n ? `${s.slice(0, n)}…` : s);
  function hrefOf(el) {
    const h = el.href;
    if (!h || typeof h !== 'string' || h.startsWith('javascript:') || h.endsWith('#')) return '';
    if (h.startsWith(origin + '/')) return short(h.slice(origin.length), 60);
    return short(h.replace(/^https?:\/\//, ''), 60);
  }

  const entries = []; // in document order
  const controls = [];
  function emit(el, r, depth) {
    const ref = `${_refPrefix}${refCount++}`;
    D.registry.set(ref, el);
    try { if (genFallback) fallbacks[ref] = genFallback(el); } catch {}
    const name = nameFor(el, r).replace(/"/g, "'");
    const fp = `${r}|${name}`;
    fingerprints.push(fp);
    let line = `${r}${name ? ` "${name}"` : ''} [${ref}]`;
    if (el.tagName === 'INPUT' && (el.type === 'checkbox' || el.type === 'radio')) { if (el.checked) line += ' checked'; }
    else if (D.attr(el, 'aria-checked') === 'true') line += ' checked';
    const exp = D.attr(el, 'aria-expanded');
    if (exp) line += exp === 'true' ? ' expanded' : ' collapsed';
    if (D.attr(el, 'aria-selected') === 'true') line += ' selected';
    if (el.disabled || D.attr(el, 'aria-disabled') === 'true') line += ' disabled';
    if (el.value !== undefined && el.value !== '' && typeof el.value !== 'object'
      && !['checkbox', 'radio', 'submit', 'button', 'reset', 'image'].includes(el.type)) {
      // A password field shows only that it is filled (and how long), never its value.
      const v = el.type === 'password' ? '•'.repeat(Math.min(String(el.value).length, 20)) : short(String(el.value), 80).replace(/"/g, "'");
      line += ` value="${v}"`;
    }
    if (_links && el.tagName === 'A') { const h = hrefOf(el); if (h) line += ` → ${h}`; }
    const entry = { depth, el, key: `${r}|${name}`, line, isNew: !!(prevSet && !prevSet.has(fp)) };
    entries.push(entry);
    budget -= depth * 2 + line.length + 3;
    return entry;
  }

  function walk(el, depth) {
    if (!el || el.nodeType !== 1 || skipTags.has(el.tagName)) return;
    if (budget <= 0) { truncated = true; return; }
    if (el.id && el.id.startsWith('__bc')) return; // the extension's own frame and cursor
    const v = vis(el);
    if (!v) return;
    const r = D.roleOf(el);
    const interactive = v === 'show' && D.isInteractive(el);
    const own = interactive || (v === 'show' && (landmarkRoles.has(r) || r === 'heading'));
    if (own) {
      const entry = emit(el, r, depth);
      if (interactive) controls.push(entry);
    }
    for (const c of D.flatChildren(el)) if (c.nodeType === 1) walk(c, own ? depth + 1 : depth);
  }

  let root = document.body;
  if (_rootRef) {
    root = D.registry.get(_rootRef);
    if (!D.connected(root)) return { success: false, error: `ref ${_rootRef} is gone — take a new snapshot` };
  } else if (_sel) {
    const hit = D.resolve(null, _sel, null);
    if (hit.error === 'INVALID_SELECTOR') return { success: false, error: `Invalid CSS selector: ${_sel}` };
    root = hit.el;
  }
  if (!root) return { success: false, error: 'Root element not found' };
  walk(root, 0);

  // Look-alike controls ("Edit" in every row) get their table row's text.
  const seen = new Map();
  for (const c of controls) seen.set(c.key, (seen.get(c.key) || 0) + 1);
  for (const c of controls) {
    if (seen.get(c.key) < 2) continue;
    const context = D.rowContextOf(c.el);
    if (context) c.line += ` (row: ${short(context, 80)})`;
  }
  let text = entries.map((e) => `${'  '.repeat(e.depth)}${e.isNew ? '+' : '-'} ${e.line}`).join('\n');
  if (text.length > _maxChars) {
    text = text.slice(0, Math.max(0, text.lastIndexOf('\n', _maxChars)));
    truncated = true;
  }
  return {
    success: true,
    url: location.href,
    title: document.title,
    snapshot: text,
    ...(truncated ? { truncated: true } : {}),
    __fallbacks: fallbacks,
    __fingerprints: fingerprints,
  };
}

/**
 * Snapshot: the page's controls, landmarks and headings as lines with refs
 * every ref tool accepts. `query` instead returns the few elements that best
 * match a description (find.js). Recovery descriptors for the refs are kept
 * per tab, not written into the page's DOM.
 */
export async function handleSnapshot(params) {
  const { tabId, selector, ref: rootRef, query, links = false, maxChars = SNAPSHOT_MAX_CHARS } = params;
  await resolveTab(tabId);
  if (query) return snapshotQuery(tabId, query);
  // The fallback page runtime is injected as a chrome.scripting `func:`: MV3's
  // extension CSP (no unsafe-eval) rules out rebuilding it from a source string.
  await safeExec(tabId, PAGE_FALLBACK_INSTALL, []);
  const prevFingerprints = lastSnapshotFingerprints.get(tabId) || null;
  const res = await execDom(tabId, pageSnapshot, [selector ?? null, rootRef ?? null, prevFingerprints, nextRefPrefix('s'), maxChars, !!links]);
  if (res && res.__fallbacks) {
    // Merged, not replaced: a scoped snapshot must not invalidate the full one's refs.
    const map = fallbackByTab.get(tabId) || new Map();
    for (const [ref, fbEntry] of Object.entries(res.__fallbacks)) map.set(ref, fbEntry);
    while (map.size > 3000) map.delete(map.keys().next().value);
    fallbackByTab.set(tabId, map);
    delete res.__fallbacks;
    persistSessionState();
  }
  if (res && res.__fingerprints) {
    lastSnapshotFingerprints.set(tabId, res.__fingerprints);
    delete res.__fingerprints;
  }
  if (res?.truncated) res.hint = 'Cut at maxChars: scope it with selector or ref, or use query to find one element.';
  return res;
}

/** snapshot {query}: the best matches for a description, as snapshot lines. */
async function snapshotQuery(tabId, query) {
  const found = await handleFind({ tabId, query, limit: 8 });
  if (!found?.success) return found;
  const lines = found.matches.map((m) => `- ${m.role}${m.name ? ` "${m.name.replace(/"/g, "'")}"` : ''} [${m.ref}]${m.context ? ` (row: ${m.context.slice(0, 80)})` : ''}`);
  return {
    success: true,
    query,
    snapshot: lines.join('\n'),
    ...(lines.length ? {} : { hint: 'No match: try other words, or a snapshot without query.' }),
  };
}

export async function handleGetPageText(params) {
  // Default must match the MCP schema (text.ts: maxLength .default(5000)) —
  // it drifted 10x here once, so direct-WS callers got 50000 while MCP callers
  // got 5000 from the same knob.
  const { tabId, selector, maxLength = 5000, offset = 0 } = params;
  await resolveTab(tabId);
  const max = Math.min(Math.max(1, Number(maxLength) || 5000), 100_000);
  const from = Math.max(0, Number(offset) || 0);

  return execDom(tabId, (_sel, _max, _from) => {
    const D = globalThis.__bcDom;
    if (!D) return { __needDom: true };
    const budget = _from + _max + 1000;
    let roots = [document.body];
    if (_sel) {
      // EVERY match, not just the first: a selector list like "h1, .price"
      // used to return only the h1 (found live). Same preference order as
      // the resolver — visible light-DOM matches, then visible shadow/frame
      // matches, then the first match even if hidden.
      const light = D.queryAll(_sel, false);
      if (light === null) return { success: false, error: `Invalid CSS selector: ${_sel}` };
      let hits = light.filter((el) => D.isVisible(el));
      if (!hits.length) {
        const deep = D.queryAll(_sel, true) || [];
        hits = deep.filter((el) => D.isVisible(el));
        if (!hits.length && (deep[0] || light[0])) hits = [deep[0] || light[0]];
      }
      // Outermost matches only — a match inside another match would repeat its text.
      roots = hits.filter((el) => !hits.some((o) => o !== el && D.composedContains(o, el)));
    }
    if (!roots.length || !roots[0]) return { success: false, error: 'Element not found' };

    // Composed text: includes open/closed shadow roots and same-origin frames
    // (innerText alone misses web-component content such as caniuse's tables).
    const parts = [];
    let size = 0;
    for (const root of roots) {
      if (size > budget) break;
      const part = D.pageText(root, { max: budget });
      if (part) { parts.push(part); size += part.length + 2; }
    }
    let text = parts.join('\n\n');
    const total = text.length;
    if (_from) text = text.slice(_from);
    const truncated = text.length > _max;
    if (truncated) text = text.slice(0, _max) + '...';

    return {
      success: true, url: location.href, title: document.title, text, length: text.length, truncated,
      ...(roots.length > 1 ? { matches: roots.length } : {}),
      ...(_from ? { offset: _from } : {}),
      ...(truncated ? { nextOffset: _from + _max } : {}),
      ...(total && _from >= total ? { note: `offset ${_from} is past the end (${total} chars)` } : {}),
    };
  }, [selector ?? null, max, from]);
}

export { handleFind };

/**
 * evaluate (task 1.5): runs in the page's MAIN world via chrome.scripting — no
 * chrome.debugger, so no yellow "is being debugged" banner. Replaces the old
 * CDP Runtime.evaluate path.
 */
export async function handleEvaluate(params, _sessionId, _agentName, signal) {
  const { tabId, expression, mode = 'cdp', timeout } = params;
  await resolveTab(tabId);
  const tab = await chrome.tabs.get(tabId);
  if (/^(chrome|chrome-extension|devtools|edge|about):/i.test(tab.url || '')) {
    throw new Error(`Cannot evaluate on protected page (${tab.url}).`);
  }

  // Default: REPL semantics over CDP (top-level await, last expression is the
  // result, not blocked by CSP). mode:"scripting" (or no debugger available)
  // keeps the banner-free chrome.scripting path below.
  await assertResponsive(tabId);
  if (mode !== 'scripting') {
    let attached = false;
    try {
      return await withCdp(tabId, (send) => {
        attached = true;
        return cdpEvaluate(send, expression, { timeoutMs: timeout, signal });
      });
    } catch (err) {
      if (attached) throw err; // a real evaluate failure, not "no debugger"
    }
  }

  // TWO stacked bugs found live (production stress audit): (1) the old
  // wrapper `(async () => { ${expression} })()` is a BLOCK body — it evaluates
  // the expression and DISCARDS it, so every result was undefined even where
  // the injection worked; (2) async funcs lose returns across the world
  // boundary (crbug 1304272). Fix: pass the RAW expression; the page-side
  // direct eval() yields the completion value (expressions AND statement
  // lists, await included via the async context), parked on a page global by
  // a SYNC kick func and polled back by a SYNC read (sync MAIN-world returns
  // verified working live).
  await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: (code) => {
      window.__bcEvalOut = undefined;
      (async () => {
        try {
          const value = await eval(code);
          window.__bcEvalOut = { ok: true, json: JSON.stringify(value) };
        } catch (err) {
          window.__bcEvalOut = { ok: false, error: String(err && err.message || err).slice(0, 2000) };
        }
      })();
      return true;
    },
    args: [expression],
  });

  let out = null;
  const deadline = Date.now() + Math.min(timeout ?? 5000, 120_000); // page-side settle budget
  while (Date.now() < deadline) {
    const read = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: () => (window.__bcEvalOut === undefined ? null : window.__bcEvalOut),
    });
    out = read?.[0]?.result ?? null;
    if (out) break;
    await new Promise((r) => setTimeout(r, 40));
  }
  if (!out) return { success: false, error: 'evaluate returned no result' };
  if (out.ok === false) return { success: false, error: out.error };
  // Cap oversized results: the page-side stringify has no bound, and a huge
  // value pins service-worker memory + floods the WS frame.
  if (typeof out.json === 'string' && out.json.length > MAX_RESULT_CHARS) {
    return {
      success: true,
      result: out.json.slice(0, MAX_RESULT_CHARS),
      truncated: true,
      fullLength: out.json.length,
    };
  }
  let value;
  try {
    value = out.json === undefined ? undefined : JSON.parse(out.json);
  } catch {
    // JSON.stringify can fail for values it can't represent (functions, etc.);
    // fall back to the raw string so the caller still gets something useful.
    value = out.json;
  }
  return { success: true, result: value };
}

