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

/** Default output cap for snapshots (chars of serialized tree). */
export const SNAPSHOT_MAX_CHARS = 20_000;

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
 * Snapshot (task 2.4): builds an accessibility tree INCLUDING shadow DOM and
 * same-origin iframes. Refs are returned to the agent, while element recovery
 * state is stored in the extension fallback registry instead of mutating page
 * DOM with permanent data-mcp-ref attributes.
 */
export async function handleSnapshot(params) {
  const { tabId, selector, ref: rootRef, depth, maxChars = SNAPSHOT_MAX_CHARS } = params;
  // filter:"interactive"|"all" (Claude-in-Chrome naming) is an alias of compact.
  const compact = params.filter === 'all' ? false : params.filter === 'interactive' ? true : params.compact !== false;
  await resolveTab(tabId);

  // Install the fallback page runtime first (v2 install-once pattern): the
  // generator's source is injected natively as a chrome.scripting `func:`.
  // Rebuilding it from a source string via eval() is impossible — MV3's
  // extension CSP (script-src 'self', no unsafe-eval) throws in every
  // isolated world, which silently killed fallback capture before this fix.
  await safeExec(tabId, PAGE_FALLBACK_INSTALL, []);
  // isNew feature: pass the fingerprints seen in the PREVIOUS snapshot so the
  // page function can mark newly-appeared elements. Array is serializable.
  const prevFingerprints = lastSnapshotFingerprints.get(tabId) || null;
  const refPrefix = nextRefPrefix('s');

  return execDom(tabId, (_sel, _compact, _prevFingerprints, _refPrefix, _rootRef, _depth, _maxChars) => {
    const D = globalThis.__bcDom;
    if (!D) return { __needDom: true };
    let refCount = 0;
    /** @type {Record<string, object>} ref -> fallback, returned to background */
    const fallbacks = {};
    /** @type {string[]} fingerprints of THIS snapshot (role|name), returned to background */
    const fingerprints = [];
    // No previous snapshot → nothing is "new" (marking every node wasted tokens).
    const prevSet = _prevFingerprints ? new Set(_prevFingerprints) : null;
    // Descriptor generator comes from the pre-installed page runtime.
    const genFallback = (globalThis.__browserControllerFallbackRuntime || {}).generateFallback || null;
    const skipTags = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'PATH', 'BR', 'HR', 'WBR', 'META', 'LINK']);
    const maxDepth = Number.isInteger(_depth) && _depth >= 0 ? _depth : Infinity;
    // Output budget: stop emitting nodes once the serialized size reaches it.
    let budget = Number.isInteger(_maxChars) && _maxChars > 0 ? _maxChars : Infinity;
    let truncated = false;

    // 'show' = render normally, 'pass' = no box of its own (display:contents,
    // slots) but its children may render, false = hidden subtree.
    function vis(el) {
      const s = D.styleOf(el);
      if (!s || s.display === 'none') return false;
      if (s.display === 'contents' || el.tagName === 'SLOT') return 'pass';
      if (s.visibility === 'hidden' || s.visibility === 'collapse' || parseFloat(s.opacity) === 0) {
        // visibility is inherited but can be re-enabled below; keep walking.
        return 'pass';
      }
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) return 'show';
      // Zero-size wrappers (custom-element hosts, overflow containers) can still hold visible children.
      return el.childElementCount > 0 || D.shadowOf(el) ? 'pass' : false;
    }

    const role = (el) => D.roleOf(el);
    // Landmarks/regions are named only by an explicit label: their text is just
    // their children's names again (token noise).
    const elName = (el, r) => (landmarkRoles.has(r) && r !== 'dialog'
      ? D.clean(D.attr(el, 'aria-label') || D.attr(el, 'title'))
      : D.nameOf(el)).slice(0, 80);
    const isInteractive = (el) => D.isInteractive(el);

    const landmarkRoles = new Set(['navigation', 'main', 'banner', 'contentinfo', 'form', 'search', 'complementary', 'region', 'dialog']);

    // Flat-tree children: open AND closed shadow roots, slotted content,
    // same-origin iframe bodies (lib/page-dom.js flatChildren).
    function childrenOf(el) {
      return D.flatChildren(el).filter((c) => c.nodeType === 1);
    }

    const origin = location.origin;
    function hrefOf(el) {
      const h = el.href;
      if (!h || typeof h !== 'string') return null;
      if (h.startsWith(origin + '/')) return h.slice(origin.length); // same-origin: path only
      return h;
    }

    function emit(el, r, n, extra, isNewCheck) {
      const ref = `${_refPrefix}${refCount++}`;
      D.registry.set(ref, el);
      try { if (genFallback) fallbacks[ref] = genFallback(el); } catch {}
      const fp = `${r}|${n}`;
      fingerprints.push(fp);
      const node = { ref, role: r, ...extra };
      if (n) node.name = n;
      if (isNewCheck && prevSet && !prevSet.has(fp)) node.isNew = true;
      if (el.value !== undefined && el.value !== '' && typeof el.value !== 'object') node.value = String(el.value).slice(0, 200);
      if (el.tagName === 'INPUT' && (el.type === 'checkbox' || el.type === 'radio')) node.checked = el.checked;
      else if (D.attr(el, 'aria-checked')) node.checked = D.attr(el, 'aria-checked') === 'true';
      if (D.attr(el, 'aria-expanded')) node.expanded = D.attr(el, 'aria-expanded') === 'true';
      if (D.attr(el, 'aria-selected') === 'true') node.selected = true;
      if (el.disabled) node.disabled = true;
      if (el.tagName === 'A') { const h = hrefOf(el); if (h) node.href = h; }
      budget -= JSON.stringify(node).length + 16;
      return node;
    }

    function buildCompact(el, d) {
      if (!el || el.nodeType !== 1) return null;
      if (skipTags.has(el.tagName)) return null;
      if (budget <= 0) { truncated = true; return null; }
      const v = vis(el);
      if (!v) return null;

      const ia = v === 'show' && isInteractive(el);
      const r = role(el);
      const isLandmark = v === 'show' && (landmarkRoles.has(r) || (r === 'heading'));
      const own = ia || isLandmark;

      let node = null;
      if (own) {
        if (d > maxDepth) { truncated = true; return null; }
        node = emit(el, r, elName(el, r), {}, true);
      }
      const kids = [];
      if (!(own && d >= maxDepth)) {
        for (const c of childrenOf(el)) {
          const cn = buildCompact(c, own ? d + 1 : d);
          if (cn) Array.isArray(cn) ? kids.push(...cn) : kids.push(cn);
        }
      } else if (childrenOf(el).length) truncated = true;

      if (!own) return kids.length === 0 ? null : kids.length === 1 ? kids[0] : kids;
      if (kids.length) node.children = kids;
      return node;
    }

    function buildFull(el, d) {
      if (!el || el.nodeType !== 1) return null;
      if (skipTags.has(el.tagName)) return null;
      if (budget <= 0) { truncated = true; return null; }
      const v = vis(el);
      if (!v) return null;

      const r = role(el);
      const ia = v === 'show' && isInteractive(el);
      const n = v === 'show' ? elName(el, r) : '';

      if (v !== 'show' || (r === 'generic' && !n && !ia && d > 1)) {
        const kids = [];
        for (const c of childrenOf(el)) {
          const cn = buildFull(c, d + (v === 'show' ? 1 : 0));
          if (cn) Array.isArray(cn) ? kids.push(...cn) : kids.push(cn);
        }
        return kids.length === 0 ? null : kids.length === 1 ? kids[0] : kids;
      }
      if (d > maxDepth) { truncated = true; return null; }

      const node = emit(el, r, n, r === 'generic' ? { tag: el.tagName.toLowerCase() } : {}, true);
      const kids = [];
      for (const c of childrenOf(el)) {
        const cn = buildFull(c, d + 1);
        if (cn) Array.isArray(cn) ? kids.push(...cn) : kids.push(cn);
      }
      if (kids.length) node.children = kids;
      return node;
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

    const tree = _compact ? buildCompact(root, 0) : buildFull(root, 0);
    return {
      success: true,
      url: location.href,
      title: document.title,
      compact: _compact,
      tree,
      ...(truncated ? {
        truncated: true,
        hint: 'Output capped (maxChars/depth). Scope it with selector or ref (a subtree), or raise maxChars.',
      } : {}),
      // internal: background stores these per-tab; never sent to the agent.
      __fallbacks: fallbacks,
      __fingerprints: fingerprints,
    };
  }, [selector ?? null, compact, prevFingerprints, refPrefix, rootRef ?? null, depth ?? null, maxChars]).then((res) => {
    // Store the fallbacks per-tab so click/type can resolve stale refs, and
    // persist them across service-worker recycles (MV3 lifetime). Merged, not
    // replaced: a scoped snapshot must not invalidate refs from the full one.
    if (res && res.__fallbacks) {
      const map = fallbackByTab.get(tabId) || new Map();
      for (const [ref, fbEntry] of Object.entries(res.__fallbacks)) map.set(ref, fbEntry);
      // Bound the map: keep the most recent entries.
      while (map.size > 3000) map.delete(map.keys().next().value);
      fallbackByTab.set(tabId, map);
      delete res.__fallbacks; // keep it out of the agent-visible payload
      persistSessionState();
    }
    // Store THIS snapshot's fingerprints so the next snapshot can compute isNew.
    if (res && res.__fingerprints) {
      lastSnapshotFingerprints.set(tabId, res.__fingerprints);
      delete res.__fingerprints;
    }
    return res;
  });
}

export async function handleGetPageText(params) {
  // Default must match the MCP schema (text.ts: maxLength .default(5000)) —
  // it drifted 10x here once, so direct-WS callers got 50000 while MCP callers
  // got 5000 from the same knob.
  const { tabId, selector, maxLength = 5000, mode = 'all', offset = 0 } = params;
  await resolveTab(tabId);
  const max = Math.min(Math.max(1, Number(maxLength) || 5000), 100_000);
  const from = Math.max(0, Number(offset) || 0);

  return execDom(tabId, (_sel, _max, _mode, _from) => {
    const D = globalThis.__bcDom;
    if (!D) return { __needDom: true };
    const article = _mode === 'article';
    let root = document.body;
    if (_sel) {
      const hit = D.resolve(null, _sel, null);
      if (hit.error === 'INVALID_SELECTOR') return { success: false, error: `Invalid CSS selector: ${_sel}` };
      root = hit.el;
    } else if (article) {
      root = D.articleRoot();
    }
    if (!root) return { success: false, error: 'Element not found' };

    // Composed text: includes open/closed shadow roots and same-origin frames
    // (innerText alone misses web-component content such as caniuse's tables).
    let text = D.pageText(root, { article, max: _from + _max + 1000 });
    const total = text.length;
    if (_from) text = text.slice(_from);
    const truncated = text.length > _max;
    if (truncated) text = text.slice(0, _max) + '...';

    return {
      success: true, url: location.href, title: document.title, text, length: text.length, truncated,
      ...(_from ? { offset: _from } : {}),
      ...(truncated ? { nextOffset: _from + _max } : {}),
      ...(article ? { mode: 'article' } : {}),
      ...(total && _from >= total ? { note: `offset ${_from} is past the end (${total} chars)` } : {}),
    };
  }, [selector ?? null, max, mode, from]);
}

export { handleFind } from './find.js';

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

/**
 * Auto-re-snapshot helper (Facebook/Instagram virtualization recovery).
 *
 * On virtualized sites (FB/IG/Twitter feeds), scrolling can REMOVE a post from
 * the DOM entirely — so a stale `ref` + every in-page fallback all return null.
 * Rather than forcing the agent to do a full round-trip (error → snapshot →
 * retry), we snapshot the tab HERE and embed the fresh refs in the error so the
 * agent can retry in one step using the new refs.
 *
 * Returns a compact summary (refs + names) suitable for an error payload — NOT
 * the full tree (keeps it token-cheap). null if the re-snapshot itself failed.
 */
export async function autoReSnapshot(tabId) {
  try {
    const res = await handleSnapshot({ tabId, compact: true });
    if (!res || !res.success || !res.tree) return null;
    // Flatten ref → {role, name} so the agent can pick the right new ref.
    const refs = [];
    const walk = (n) => {
      if (!n) return;
      if (Array.isArray(n)) { n.forEach(walk); return; }
      if (n.ref) refs.push({ ref: n.ref, role: n.role || '', name: (n.name || '').slice(0, 60) });
      if (n.children) walk(n.children);
    };
    walk(res.tree);
    return { refs: refs.slice(0, 40), url: res.url, title: res.title };
  } catch {
    return null;
  }
}
