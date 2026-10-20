/**
 * Inspection handlers (extracted from background.js): wait, scroll, snapshot,
 * find, text, evaluate — the read side of the toolset.
 */
import { safeExec, execDom, resolveTab, getFallback, assertResponsive, hasPoint } from '../lib/page-exec.js';
import { trustedSender, pointInfo, releaseShield } from '../lib/trusted-input.js';
import { fallbackByTab, lastSnapshotFingerprints, MAX_RESULT_CHARS, persistSessionState, nextRefPrefix } from '../lib/state.js';
import { PAGE_FALLBACK_INSTALL } from '../utils/smart-selector.js';
import { withCdp, settleWithin, TIMED_OUT } from '../lib/cdp-session.js';
import { cdpEvaluate, DEFAULT_EVAL_TIMEOUT_MS, MAX_EVAL_TIMEOUT_MS } from '../lib/cdp-evaluate.js';
import { handleNativeSnapshot } from './ax-snapshot.js';
import { refErrorMessage } from '../lib/ref-errors.js';

/** Default output cap for snapshots (chars of serialized tree). */
export const SNAPSHOT_MAX_CHARS = 20_000;

/** Longest fixed delay a browser_wait call sleeps (the rest is reported as capped). */
const WAIT_DELAY_MAX_MS = 30_000;
/** Longest condition wait: below the ~60 s transport timeout, so the call answers instead of timing out. */
const WAIT_TIMEOUT_MAX_MS = 50_000;

export async function handleWait(params, _sessionId, _agentName, signal) {
  const { tabId, selector, state = 'visible', delay, text, urlIncludes } = params;
  const requestedTimeout = Number.isFinite(params.timeout) ? params.timeout : 10000;
  const timeout = Math.min(Math.max(0, requestedTimeout), WAIT_TIMEOUT_MAX_MS);
  const clampNote = requestedTimeout > WAIT_TIMEOUT_MAX_MS
    ? { note: `timeout capped at ${WAIT_TIMEOUT_MAX_MS} ms (requested ${requestedTimeout}); the call must answer before the transport timeout` }
    : {};

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
    const waited = Math.min(delay, WAIT_DELAY_MAX_MS);
    const sleep = new Promise((r) => setTimeout(r, waited));
    try {
      await (abortRace ? Promise.race([sleep, abortRace]) : sleep);
    } catch {
      return { success: false, error: 'aborted', waited: 0 };
    }
    // documented: a delay ignores the conditions. `waited` is what really elapsed.
    return { success: true, waited, ...(waited < delay ? { note: `delay capped at ${WAIT_DELAY_MAX_MS} ms (requested ${delay})` } : {}) };
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
        ...clampNote,
      };
    }
    await new Promise((r) => setTimeout(r, 200));
  }

  return { success: false, error: `Timeout waiting for ${what} to be ${state}`, ...clampNote };
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

    // A position (top/bottom) is a vertical move; otherwise the direction decides the axis.
    const dirOf = _pos ? (_pos === 'top' ? 'up' : 'down') : _dir;
    const axis = dirOf === 'left' || dirOf === 'right' ? 'x' : 'y';
    const scrollingEl = document.scrollingElement || document.documentElement;
    const overflows = (el) => (axis === 'y'
      ? el.scrollHeight - el.clientHeight > 1
      : el.scrollWidth - el.clientWidth > 1);
    // Can `el` still move in the requested direction? (window: its document element)
    const canMove = (el) => {
      const win = el === window;
      const s = win ? scrollingEl : el;
      const at = win ? (axis === 'y' ? window.scrollY || 0 : window.scrollX || 0) : (axis === 'y' ? el.scrollTop : el.scrollLeft);
      if (!overflows(s)) return false;
      if (dirOf === 'up' || dirOf === 'left') return at > 0;
      return at + (axis === 'y' ? s.clientHeight : s.clientWidth) < (axis === 'y' ? s.scrollHeight : s.scrollWidth) - 1;
    };
    const positionOf = (el) => (el === window
      ? { x: window.scrollX || 0, y: window.scrollY || 0 }
      : { x: el.scrollLeft || 0, y: el.scrollTop || 0 });

    let target = _sel ? (D.resolve(null, _sel, null).el || null) : window;
    if (!target) return { success: false, error: 'Scroll container not found' };
    // App shells: the document does not scroll, an inner container does. Use the
    // nearest scrollable container under the viewport centre, else the largest one.
    if (!_sel && !canMove(window)) {
      const isScrollable = (el) => {
        const st = D.styleOf(el);
        const ov = st ? (axis === 'y' ? st.overflowY : st.overflowX) : '';
        return /(auto|scroll|overlay)/.test(ov || '') && canMove(el);
      };
      let found = null;
      for (let el = D.elementAt(window.innerWidth / 2 || 0, window.innerHeight / 2 || 0); el && !found; el = el.parentElement) {
        if (el.nodeType === 1 && isScrollable(el)) found = el;
      }
      if (!found) {
        let bestArea = 0;
        for (const el of document.querySelectorAll('*')) {
          if (!isScrollable(el) || !D.isVisible(el)) continue;
          const area = el.clientWidth * el.clientHeight;
          if (area > bestArea) { found = el; bestArea = area; }
        }
      }
      if (found) target = found;
    }

    const before = positionOf(target);
    if (_pos) {
      const edge = _pos === 'top' ? 0 : (target === window ? scrollingEl.scrollHeight : target.scrollHeight);
      if (target === window) window.scrollTo({ top: edge, behavior: 'instant' });
      else target.scrollTop = edge;
    } else {
      const dx = _dir === 'right' ? _amt : _dir === 'left' ? -_amt : 0;
      const dy = _dir === 'down' ? _amt : _dir === 'up' ? -_amt : 0;
      if (target === window) window.scrollBy({ left: dx, top: dy, behavior: 'instant' });
      else target.scrollBy({ left: dx, top: dy, behavior: 'instant' });
    }
    const after = positionOf(target);
    const moved = after.x !== before.x || after.y !== before.y;
    const container = target === window ? undefined : D.describe(target);
    if (!moved) {
      // Nothing moved: say so. Reaching the requested edge is a success, not an error.
      if (_pos && overflows(target === window ? scrollingEl : target) === false) {
        return { success: false, error: 'NOT_SCROLLABLE: nothing on this page scrolls', moved: false, position: after };
      }
      if (_pos) return { success: true, scrolledTo: _pos, moved: false, position: after };
      const why = overflows(target === window ? scrollingEl : target)
        ? `already at the ${_dir === 'down' ? 'bottom' : _dir === 'up' ? 'top' : _dir === 'right' ? 'right' : 'left'} edge`
        : 'nothing scrollable in this direction';
      return { success: false, error: `NOT_SCROLLABLE: nothing moved (${why})`, moved: false, position: after };
    }
    return {
      success: true,
      ...(_pos ? { scrolledTo: _pos } : { direction: _dir, amount: _amt }),
      moved: true,
      position: after,
      ...(container ? { container } : {}),
    };
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
 * same-origin iframes (source:"dom", the default; source:"native" reads Chrome's
 * real AX tree instead — handlers/ax-snapshot.js). Refs are returned to the agent, while element recovery
 * state is stored in the extension fallback registry instead of mutating page
 * DOM with permanent data-mcp-ref attributes.
 */
export async function handleSnapshot(params) {
  const { tabId, selector, ref: rootRef, depth, maxChars = SNAPSHOT_MAX_CHARS } = params;
  // filter:"interactive"|"all" (Claude-in-Chrome naming) is an alias of compact.
  const compact = params.filter === 'all' ? false : params.filter === 'interactive' ? true : params.compact !== false;
  await resolveTab(tabId);

  // source:"native": Chrome's own accessibility tree (CDP). When the debugger
  // can't attach (or the AX read fails) the DOM snapshot below answers instead
  // and says why in `nativeUnavailable`.
  let nativeUnavailable;
  if (params.source === 'native') {
    const native = await handleNativeSnapshot(params, { compact, maxChars });
    if (!native.__fallback) return native;
    nativeUnavailable = native.__fallback;
  }

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
    // An older runtime (installed before an extension update) has no labelsOf.
    if (!D || !D.labelsOf) return { __needDom: true };
    D.beginRefGeneration?.(_refPrefix);
    let refCount = 0;
    /** @type {Record<string, object>} ref -> fallback, returned to background */
    const fallbacks = {};
    /** One sibling index for every fallback of this pass (smart-selector.js). */
    const fallbackPass = {};
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
    // slots, hidden-but-walkable wrappers) but its children may render, false =
    // hidden subtree, never listed. Hidden means: display:none, opacity:0 (the
    // whole subtree is invisible), inert, aria-hidden="true", an extension
    // overlay, or no box at all. Off-screen elements are NOT hidden: scrollable
    // content must stay listed.
    // The exception to opacity:0: a native checkbox/radio drawn over by its styled
    // <label> is the control a person clicks, so it is listed (see labelledCheckable).
    function vis(el) {
      if (D.isExtensionNode?.(el)) return false;
      if (D.attr(el, 'aria-hidden') === 'true' || el.inert === true || (el.hasAttribute && el.hasAttribute('inert'))) return false;
      const s = D.styleOf(el);
      if (!s || s.display === 'none') return false;
      if (parseFloat(s.opacity) === 0 && !labelledCheckable(el)) return false;
      if (s.display === 'contents' || el.tagName === 'SLOT') return 'pass';
      if (s.visibility === 'hidden' || s.visibility === 'collapse') {
        // visibility is inherited but can be re-enabled below; keep walking.
        return 'pass';
      }
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) return 'show';
      // Zero-size wrappers (custom-element hosts, overflow containers) can still hold visible children.
      return el.childElementCount > 0 || D.shadowOf(el) ? 'pass' : false;
    }

    /**
     * A native checkbox/radio whose box is only transparent (opacity:0, the custom
     * pattern) and whose label is visible: the control the user sees and clicks.
     */
    function labelledCheckable(el) {
      if (el.tagName !== 'INPUT' || !['checkbox', 'radio'].includes(String(el.type || '').toLowerCase())) return false;
      if (!D.isVisible(el, { ignoreOpacity: true })) return false;
      return D.labelsOf(el).some((label) => D.isVisible(label));
    }

    /**
     * Same-origin frames are walked (their body is in the flat tree). A frame whose
     * document we cannot read is named, not silently dropped: its text, links and
     * controls are simply not reachable from this page's script.
     */
    function crossOriginFrame(el) {
      if (el.tagName !== 'IFRAME' && el.tagName !== 'FRAME') return null;
      if (D.frameDoc(el)) return null;
      let origin = '';
      try { origin = new URL(D.attr(el, 'src') || '', location.href).origin; } catch { /* no usable src: unnamed origin */ }
      return origin && origin !== 'null' ? `cross-origin: ${origin}` : 'cross-origin';
    }
    function frameNode(name) {
      const node = { role: 'iframe', name };
      budget -= JSON.stringify(node).length + 16;
      return node;
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
      try { if (genFallback) fallbacks[ref] = genFallback(el, fallbackPass); } catch {}
      const fp = `${r}|${n}`;
      fingerprints.push(fp);
      const node = { ref, role: r, ...extra };
      if (n) node.name = n;
      if (isNewCheck && prevSet && !prevSet.has(fp)) node.isNew = true;
      if (el.tagName === 'INPUT' && String(el.type || '').toLowerCase() === 'password') {
        // A password is never printed: a mask says the field is filled.
        if (el.value) node.value = '••••';
      } else if (el.value !== undefined && el.value !== '' && typeof el.value !== 'object') node.value = String(el.value).slice(0, 200);
      if (el.tagName === 'INPUT' && (el.type === 'checkbox' || el.type === 'radio')) node.checked = el.checked;
      else if (D.attr(el, 'aria-checked')) node.checked = D.attr(el, 'aria-checked') === 'true';
      if (D.attr(el, 'aria-expanded')) node.expanded = D.attr(el, 'aria-expanded') === 'true';
      if (D.attr(el, 'aria-selected') === 'true') node.selected = true;
      if (el.disabled) node.disabled = true;
      if (el.tagName === 'A') { const h = hrefOf(el); if (h) node.href = h; }
      budget -= JSON.stringify(node).length + 16;
      return node;
    }

    /** Compact-mode controls, so look-alikes ("Edit" in every row) can get row context afterwards. */
    const controls = [];

    function buildCompact(el, d) {
      if (!el || el.nodeType !== 1) return null;
      if (skipTags.has(el.tagName)) return null;
      if (budget <= 0) { truncated = true; return null; }
      const v = vis(el);
      if (!v) return null;
      const xo = v === 'show' ? crossOriginFrame(el) : null;
      if (xo) {
        if (d > maxDepth) { truncated = true; return null; }
        return frameNode(xo);
      }

      const ia = v === 'show' && isInteractive(el);
      const r = role(el);
      const isLandmark = v === 'show' && (landmarkRoles.has(r) || (r === 'heading'));
      const own = ia || isLandmark;

      let node = null;
      if (own) {
        if (d > maxDepth) { truncated = true; return null; }
        node = emit(el, r, elName(el, r), {}, true);
        if (ia) controls.push({ el, node });
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
      const xo = v === 'show' ? crossOriginFrame(el) : null;
      if (xo) {
        if (d > maxDepth) { truncated = true; return null; }
        return frameNode(xo);
      }

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
      // The extension words the stale-ref error (lib/ref-errors.js), not the page.
      if (!D.connected(root)) return { success: false, error: 'REF_GONE', _ref: _rootRef };
    } else if (_sel) {
      const hit = D.resolve(null, _sel, null);
      if (hit.error === 'INVALID_SELECTOR') return { success: false, error: `Invalid CSS selector: ${_sel}` };
      root = hit.el;
    }
    if (!root) return { success: false, error: 'Root element not found' };

    const tree = _compact ? buildCompact(root, 0) : buildFull(root, 0);
    // The compact tree drops the cell text that tells look-alike controls apart:
    // controls sharing role+name get their table row's text. Unique ones stay lean.
    const seen = new Map();
    for (const c of controls) { const k = `${c.node.role}|${c.node.name || ''}`; seen.set(k, (seen.get(k) || 0) + 1); }
    for (const c of controls) {
      if (seen.get(`${c.node.role}|${c.node.name || ''}`) < 2) continue;
      const context = D.rowContextOf(c.el);
      if (!context) continue;
      if (budget < context.length + 13) { truncated = true; break; } // `,"context":""` counts against maxChars too
      budget -= context.length + 13;
      c.node.context = context;
    }
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
    if (res && res.success === false && res.error === 'REF_GONE') {
      res.error = refErrorMessage(res._ref, getFallback(tabId, res._ref));
      delete res._ref;
    }
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
    if (nativeUnavailable && res && res.success) res.nativeUnavailable = nativeUnavailable;
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
    const budget = _from + _max + 1000;
    /** Composed text of the roots: shadow roots and same-origin frames included. */
    const textOf = (roots, art) => {
      const parts = [];
      let size = 0;
      for (const root of roots) {
        if (size > budget) break;
        const part = D.pageText(root, { article: art, max: budget });
        if (part) { parts.push(part); size += part.length + 2; }
      }
      return parts.join('\n\n');
    };
    let roots = [document.body];
    let note = null;
    if (_sel) {
      // EVERY match, not just the first: a selector list like "h1, .price"
      // used to return only the h1 (found live). Visible matches only (the
      // resolver's light/shadow/frame order does not matter once we filter).
      const all = D.queryAll(_sel, true);
      if (all === null) return { success: false, error: `Invalid CSS selector: ${_sel}` };
      if (!all.length) return { success: false, error: 'Element not found' };
      // Extension overlays are never page text.
      const shown = all.filter((el) => !D.isExtensionNode?.(el) && D.isVisible(el));
      if (!shown.length) {
        return { success: false, error: `ELEMENT_HIDDEN: ${_sel} matches only hidden elements (display:none, visibility:hidden or no box), so there is no visible text` };
      }
      // Outermost matches only — a match inside another match would repeat its text.
      roots = shown.filter((el) => !shown.some((o) => o !== el && D.composedContains(o, el)));
    } else if (article) {
      roots = [D.articleRoot()];
    }
    if (!roots.length || !roots[0]) return { success: false, error: 'Element not found' };

    let text = textOf(roots, article);
    // The article heuristic skips by class-name guesses ("share", "related",
    // "comments"...), which can drop real paragraphs. Compared with the same
    // roots' full text: when the heuristic keeps less than half of it, the full
    // visible text of those roots is the honest answer.
    let articleUsed = article;
    if (article) {
      const full = textOf(roots, false);
      if (text.length < full.length * 0.5) {
        note = `article mode kept ${Math.round(100 * text.length / Math.max(1, full.length))}% of the text, so the full visible text is returned`;
        text = full;
        articleUsed = false;
      }
    }
    const total = text.length;
    if (_from) text = text.slice(_from);
    const truncated = text.length > _max;
    if (truncated) text = text.slice(0, _max) + '...';

    return {
      success: true, url: location.href, title: document.title, text, length: text.length, truncated,
      ...(roots.length > 1 ? { matches: roots.length } : {}),
      ...(_from ? { offset: _from } : {}),
      ...(truncated ? { nextOffset: _from + _max } : {}),
      ...(articleUsed ? { mode: 'article' } : {}),
      ...(note ? { note } : {}),
      ...(total && _from >= total ? { note: `offset ${_from} is past the end (${total} chars)` } : {}),
    };
  }, [selector ?? null, max, mode, from]);
}

export { handleFind } from './find.js';

/**
 * evaluate. Default: CDP with REPL semantics (top-level await, the last expression is
 * the result, the page's CSP does not apply). mode:"scripting", or no debugger
 * available, runs the code in the page's MAIN world via chrome.scripting instead: no
 * banner, but CSP-bound. Every result says which path ran (`via`). Both paths share one
 * budget, `timeout` (default DEFAULT_EVAL_TIMEOUT_MS, the same default the MCP schema
 * declares), and return TIMEOUT when it runs out.
 */
export async function handleEvaluate(params, _sessionId, _agentName, signal) {
  const { tabId, expression, mode = 'cdp', timeout } = params;
  const budget = Math.min(Math.max(1000, timeout ?? DEFAULT_EVAL_TIMEOUT_MS), MAX_EVAL_TIMEOUT_MS);
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
      return await withCdp(tabId, async (send) => {
        attached = true;
        return { ...(await cdpEvaluate(send, expression, { timeoutMs: budget, signal })), via: 'cdp' };
      });
    } catch (err) {
      if (attached) throw err; // a real evaluate failure, not "no debugger"
    }
  }

  // The expression runs as a direct eval() in the page's MAIN world; its completion
  // value (await included) is parked on a page global by a SYNC kick func and polled
  // back by a SYNC read. The wrapper must not be a block body (that discards the value),
  // and async funcs lose their return across the world boundary (crbug 1304272).
  const deadline = Date.now() + budget;
  const left = () => Math.max(1, deadline - Date.now());
  const timedOut = {
    success: false,
    via: 'scripting',
    error: `TIMEOUT: evaluate did not finish within ${budget}ms. The page may still be running it; the call returned so the tab is free.`,
  };
  // executeScript waits for the page's main thread. A busy page never answers, so every
  // call is raced against the budget: a frozen page returns TIMEOUT instead of holding the tab.
  const kicked = await settleWithin(chrome.scripting.executeScript({
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
  }), left());
  if (kicked === TIMED_OUT) return timedOut;

  let out = null;
  while (Date.now() < deadline) {
    const read = await settleWithin(chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: () => (window.__bcEvalOut === undefined ? null : window.__bcEvalOut),
    }), left());
    if (read === TIMED_OUT) return timedOut;
    out = read?.[0]?.result ?? null;
    if (out) break;
    await new Promise((r) => setTimeout(r, 40));
  }
  if (!out) return timedOut;
  if (out.ok === false) return { success: false, via: 'scripting', error: out.error };
  // Cap oversized results: the page-side stringify has no bound, and a huge
  // value pins service-worker memory + floods the WS frame.
  if (typeof out.json === 'string' && out.json.length > MAX_RESULT_CHARS) {
    return {
      success: true,
      via: 'scripting',
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
  return { success: true, via: 'scripting', result: value };
}

/** Refs a stale-ref error lists at most (the rest of the page is one browser_snapshot away). */
export const CLOSEST_REFS_MAX = 5;

/**
 * Similarity of two names: Dice coefficient over character bigrams, 0..1. Forgiving
 * about small edits ("Save" / "Save draft") and cheap enough for a whole page.
 */
export function nameSimilarity(a, b) {
  const x = String(a || '').toLowerCase().trim();
  const y = String(b || '').toLowerCase().trim();
  if (!x || !y) return 0;
  if (x === y) return 1;
  if (x.length < 2 || y.length < 2) return 0;
  const grams = new Map();
  for (let i = 0; i < x.length - 1; i++) {
    const g = x.slice(i, i + 2);
    grams.set(g, (grams.get(g) || 0) + 1);
  }
  let common = 0;
  for (let i = 0; i < y.length - 1; i++) {
    const g = y.slice(i, i + 2);
    const n = grams.get(g) || 0;
    if (n > 0) { common++; grams.set(g, n - 1); }
  }
  return (2 * common) / ((x.length - 1) + (y.length - 1));
}

/**
 * The refs whose names look most like `wanted.name` (a stale ref's last known
 * name), best first, at most CLOSEST_REFS_MAX. A same-role match breaks ties.
 * Refs below a minimum similarity are left out: nothing alike means no list.
 */
export function closestRefs(refs, wanted, limit = CLOSEST_REFS_MAX) {
  const name = wanted && wanted.name ? String(wanted.name) : '';
  if (!name) return [];
  return refs
    .map((r) => ({ r, score: nameSimilarity(r.name, name) + (wanted.role && r.role === wanted.role ? 0.05 : 0) }))
    .filter((x) => x.score >= 0.3)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => x.r);
}

/**
 * Stale-ref recovery (virtualized feeds, re-rendered lists): a fresh snapshot
 * whose refs look like the missing ref's last known name, so the agent can retry
 * in one step. Returns at most CLOSEST_REFS_MAX refs and never the whole page:
 * a 40-ref dump cost ~800 tokens on every stale click. null if the snapshot failed.
 */
export async function autoReSnapshot(tabId, wanted) {
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
    return { refs: closestRefs(refs, wanted), url: res.url, title: res.title };
  } catch {
    return null;
  }
}
