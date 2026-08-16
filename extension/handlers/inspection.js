/**
 * Inspection handlers (extracted from background.js): wait, scroll, snapshot,
 * find, text, evaluate — the read side of the toolset.
 */
import { safeExec, resolveTab } from '../lib/page-exec.js';
import { fallbackByTab, lastSnapshotFingerprints, MAX_RESULT_CHARS, persistSessionState } from '../lib/state.js';
import { PAGE_FALLBACK_FN } from '../utils/smart-selector.js';

export async function handleWait(params, _sessionId, _agentName, signal) {
  const { tabId, selector, state = 'visible', timeout = 10000, delay } = params;

  // A promise that rejects when this call is cancelled (client gone / bridge
  // timeout forwarded). Long waits race against it so a cancelled call releases
  // the tab mutex immediately instead of blocking later calls on the same tab.
  const abortRace = signal
    ? new Promise((_, reject) => {
        if (signal.aborted) reject(new Error('aborted'));
        else signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      })
    : null;

  if (delay) {
    const sleep = new Promise((r) => setTimeout(r, Math.min(delay, 30000)));
    try {
      await (abortRace ? Promise.race([sleep, abortRace]) : sleep);
    } catch {
      return { success: false, error: 'aborted', waited: 0 };
    }
    return { success: true, waited: delay };
  }

  if (!selector) return { success: false, error: 'Need selector or delay' };
  await resolveTab(tabId);
  const start = Date.now();

  while (Date.now() - start < timeout) {
    // Bail the moment the caller is gone so we don't pin the tab mutex for the
    // full timeout window after the originating agent was evicted (consistent
    // with handleNavigate / handleRunAction).
    if (signal?.aborted) return { success: false, error: 'aborted', selector, state };
    const found = await safeExec(tabId, (_sel, _state) => {
      const el = document.querySelector(_sel);
      if (_state === 'hidden') return !el || el.offsetParent === null;
      if (_state === 'attached') return !!el;
      return el && el.offsetParent !== null;
    }, [selector, state]);

    if (found) return { success: true, selector, state, elapsed: Date.now() - start };
    await new Promise((r) => setTimeout(r, 200));
  }

  return { success: false, error: `Timeout waiting for ${selector} to be ${state}` };
}

export async function handleScroll(params) {
  const { tabId, direction = 'down', amount = 500, selector, toElement, position } = params;
  await resolveTab(tabId);

  return safeExec(tabId, (_dir, _amt, _sel, _toEl, _pos) => {
    if (_toEl) {
      const el = document.querySelector(`[data-mcp-ref="${_toEl}"]`) || document.querySelector(_toEl);
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        return { success: true, scrolledTo: 'element' };
      }
      return { success: false, error: 'Element not found' };
    }

    const target = _sel ? document.querySelector(_sel) : window;
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
  }, [direction, amount, selector, toElement, position]).then((res) => {
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
 * same-origin iframes. Refs are stamped via data-mcp-ref and are valid only for
 * the tab that produced them (enforced by resolveTab in the consuming tools).
 */
export async function handleSnapshot(params) {
  const { tabId, selector, compact = true } = params;
  await resolveTab(tabId);

  // chrome.scripting cannot serialize functions across the service worker
  // boundary, so pass the fallback generator as its SOURCE STRING and eval it
  // in the page to rebuild the live function.
  const genFallbackSrc = PAGE_FALLBACK_FN.toString();
  // isNew feature: pass the fingerprints seen in the PREVIOUS snapshot so the
  // page function can mark newly-appeared elements. Array is serializable.
  const prevFingerprints = lastSnapshotFingerprints.get(tabId) || [];
  const refPrefix = `e-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}-`;

  return safeExec(tabId, (_sel, _compact, genFallbackSrc, _prevFingerprints, _refPrefix) => {
    let refCount = 0;
    /** @type {Record<string, object>} ref -> fallback, returned to background */
    const fallbacks = {};
    /** @type {string[]} fingerprints of THIS snapshot (role|name), returned to background */
    const fingerprints = [];
    const prevSet = new Set(_prevFingerprints);
    // Rebuild the live function from its source string (see comment at call site).
    let genFallback = null;
    try { genFallback = eval('(' + genFallbackSrc + ')'); } catch {}
    const skipTags = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'PATH', 'BR', 'HR', 'WBR', 'META', 'LINK']);

    function vis(el) {
      const s = getComputedStyle(el);
      if (s.display === 'none' || s.visibility === 'hidden' || parseFloat(s.opacity) === 0) return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    }

    function role(el) {
      const r = el.getAttribute('role');
      if (r) return r;
      const map = {
        A: 'link', BUTTON: 'button', SELECT: 'combobox', TEXTAREA: 'textbox', IMG: 'img',
        H1: 'heading', H2: 'heading', H3: 'heading', H4: 'heading', H5: 'heading', H6: 'heading',
        NAV: 'navigation', MAIN: 'main', HEADER: 'banner', FOOTER: 'contentinfo', FORM: 'form',
        TABLE: 'table', UL: 'list', OL: 'list', LI: 'listitem',
      };
      if (el.tagName === 'INPUT') {
        const t = el.type?.toLowerCase();
        if (t === 'checkbox') return 'checkbox';
        if (t === 'radio') return 'radio';
        return 'textbox';
      }
      return map[el.tagName] || 'generic';
    }

    function elName(el) {
      const raw = (
        el.getAttribute('aria-label') || el.getAttribute('alt') ||
        el.getAttribute('title') || el.getAttribute('placeholder') ||
        ''
      ).trim();
      if (raw) return raw.slice(0, 80);
      const text = el.innerText;
      if (!text) return '';
      const first = text.split('\n')[0].trim();
      return first.slice(0, 80);
    }

    function isInteractive(el) {
      const tags = ['A', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA'];
      return tags.includes(el.tagName) || el.onclick || el.getAttribute('tabindex') !== null ||
        el.getAttribute('role') === 'button' || el.getAttribute('role') === 'link' ||
        el.getAttribute('role') === 'tab' || el.getAttribute('role') === 'menuitem' ||
        el.getAttribute('role') === 'option' || el.getAttribute('role') === 'switch' ||
        el.getAttribute('contenteditable') === 'true';
    }

    const landmarkRoles = new Set(['navigation', 'main', 'banner', 'contentinfo', 'form', 'search', 'complementary', 'region']);

    // Children including shadow DOM (open roots) and same-origin iframes.
    function childrenOf(el) {
      const out = [];
      for (const c of el.children) out.push(c);
      if (el.shadowRoot) {
        for (const c of el.shadowRoot.children) out.push(c);
      }
      // same-origin iframes: expose their document body children too.
      if (el.tagName === 'IFRAME') {
        try {
          const doc = el.contentDocument;
          if (doc && doc.body) for (const c of doc.body.children) out.push(c);
        } catch { /* cross-origin: skip */ }
      }
      return out;
    }

    function buildCompact(el) {
      if (!el || el.nodeType !== 1) return null;
      if (skipTags.has(el.tagName)) return null;
      if (!vis(el)) return null;

      const ia = isInteractive(el);
      const r = role(el);
      const isLandmark = landmarkRoles.has(r);

      const kids = [];
      for (const c of childrenOf(el)) {
        const cn = buildCompact(c);
        if (cn) Array.isArray(cn) ? kids.push(...cn) : kids.push(cn);
      }

      if (!ia && !isLandmark && r !== 'heading') {
        return kids.length === 0 ? null : kids.length === 1 ? kids[0] : kids;
      }

      const ref = `${_refPrefix}${refCount++}`;
      el.setAttribute('data-mcp-ref', ref);
      const n = elName(el);
      try { if (genFallback) fallbacks[ref] = genFallback(el); } catch {}

      // isNew: mark elements whose (role|name) wasn't in the previous snapshot.
      const fp = `${r}|${n}`;
      fingerprints.push(fp);
      const isNew = !prevSet.has(fp);

      const node = { ref, role: r };
      if (n) node.name = n;
      if (isNew) node.isNew = true;
      if (el.value !== undefined && el.value !== '') node.value = String(el.value);
      if (el.checked !== undefined) node.checked = el.checked;
      if (el.disabled) node.disabled = true;
      if (el.href && el.tagName === 'A') node.href = el.href;
      if (kids.length) node.children = kids;

      return node;
    }

    function buildFull(el, depth) {
      if (!el || el.nodeType !== 1) return null;
      if (skipTags.has(el.tagName)) return null;
      if (!vis(el)) return null;

      const r = role(el);
      const n = elName(el);
      const ia = isInteractive(el);

      if (r === 'generic' && !n && !ia && depth > 1) {
        const kids = [];
        for (const c of childrenOf(el)) {
          const cn = buildFull(c, depth + 1);
          if (cn) Array.isArray(cn) ? kids.push(...cn) : kids.push(cn);
        }
        return kids.length === 0 ? null : kids.length === 1 ? kids[0] : kids;
      }

      const ref = `${_refPrefix}${refCount++}`;
      el.setAttribute('data-mcp-ref', ref);
      try { if (genFallback) fallbacks[ref] = genFallback(el); } catch {}

      // isNew: mark elements whose (role|name) wasn't in the previous snapshot.
      const fp = `${r}|${n}`;
      fingerprints.push(fp);
      const isNew = !prevSet.has(fp);

      const node = { ref, role: r };
      if (r === 'generic') node.tag = el.tagName.toLowerCase();
      if (n) node.name = n;
      if (isNew) node.isNew = true;
      if (el.value !== undefined && el.value !== '') node.value = String(el.value);
      if (el.checked !== undefined) node.checked = el.checked;
      if (el.disabled) node.disabled = true;
      if (el.href && el.tagName === 'A') node.href = el.href;

      const kids = [];
      for (const c of childrenOf(el)) {
        const cn = buildFull(c, depth + 1);
        if (cn) Array.isArray(cn) ? kids.push(...cn) : kids.push(cn);
      }
      if (kids.length) node.children = kids;

      return node;
    }

    const root = _sel ? document.querySelector(_sel) : document.body;
    if (!root) return { success: false, error: 'Root element not found' };

    const tree = _compact ? buildCompact(root) : buildFull(root, 0);
    return {
      success: true,
      url: location.href,
      title: document.title,
      compact: _compact,
      tree,
      // internal: background stores these per-tab; never sent to the agent.
      __fallbacks: fallbacks,
      __fingerprints: fingerprints,
    };
  }, [selector, compact, genFallbackSrc, prevFingerprints, refPrefix]).then((res) => {
    // Store the fallbacks per-tab so click/type can resolve stale refs, and
    // persist them across service-worker recycles (MV3 lifetime).
    if (res && res.__fallbacks) {
      const map = new Map(Object.entries(res.__fallbacks));
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

export async function handleFind(params) {
  const { tabId, query, limit = 10 } = params;
  await resolveTab(tabId);
  const refPrefix = `f-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}-`;

  return safeExec(tabId, (_q, _lim, _refPrefix) => {
    const qLow = _q.toLowerCase();
    const matches = [];

    function aName(el) {
      return (el.getAttribute('aria-label') || el.getAttribute('alt') || el.getAttribute('title') ||
        el.getAttribute('placeholder') || el.innerText?.slice(0, 200) || '').trim();
    }

    function aRole(el) {
      const r = el.getAttribute('role');
      if (r) return r;
      const map = { A: 'link', BUTTON: 'button', INPUT: 'input', SELECT: 'combobox', TEXTAREA: 'textbox', IMG: 'image' };
      return map[el.tagName] || el.tagName.toLowerCase();
    }

    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
    let rc = 0;
    let node;
    while ((node = walker.nextNode()) && matches.length < _lim * 3) {
      const s = getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      if (s.display === 'none' || s.visibility === 'hidden' || rect.width === 0) continue;

      const n = aName(node).toLowerCase();
      const r = aRole(node).toLowerCase();
      const id = (node.id || '').toLowerCase();
      let score = 0;
      if (n.includes(qLow)) score += 10;
      if (r.includes(qLow)) score += 5;
      if (id.includes(qLow)) score += 3;
      if (score === 0) continue;

      const ref = `${_refPrefix}${rc++}`;
      node.setAttribute('data-mcp-ref', ref);
      matches.push({
        ref, role: r, name: n.slice(0, 100), tag: node.tagName.toLowerCase(), score,
        bounds: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
      });
    }

    matches.sort((a, b) => b.score - a.score);
    return { success: true, query: _q, matches: matches.slice(0, _lim) };
  }, [query, limit, refPrefix]);
}

export async function handleGetPageText(params) {
  // Default must match the MCP schema (text.ts: maxLength .default(5000)) —
  // it drifted 10x here once, so direct-WS callers got 50000 while MCP callers
  // got 5000 from the same knob.
  const { tabId, selector, maxLength = 5000 } = params;
  await resolveTab(tabId);
  const args = selector === undefined ? [null, maxLength] : [selector, maxLength];

  return safeExec(tabId, (_sel, _max) => {
    const root = _sel ? document.querySelector(_sel) : document.body;
    if (!root) return { success: false, error: 'Element not found' };

    let text = root.innerText || root.textContent || '';
    text = text.replace(/\t/g, ' ').replace(/\n\s*\n/g, '\n\n').replace(/ +/g, ' ').trim();
    const truncated = text.length > _max;
    if (truncated) text = text.slice(0, _max) + '...';

    return { success: true, url: location.href, title: document.title, text, length: text.length, truncated };
  }, args);
}

/**
 * evaluate (task 1.5): runs in the page's MAIN world via chrome.scripting — no
 * chrome.debugger, so no yellow "is being debugged" banner. Replaces the old
 * CDP Runtime.evaluate path.
 */
export async function handleEvaluate(params) {
  const { tabId, expression } = params;
  await resolveTab(tabId);
  const tab = await chrome.tabs.get(tabId);
  if (/^(chrome|chrome-extension|devtools|edge|about):/i.test(tab.url || '')) {
    throw new Error(`Cannot evaluate on protected page (${tab.url}).`);
  }

  // Wrap the user expression in an async IIFE so `await` works, then run it in
  // the MAIN world (page's own JS context). We serialize the result to a JSON
  // string INSIDE the page and parse it back here, because Manifest V3's
  // chrome.scripting.executeScript loses the resolved value of an async IIFE
  // across the world boundary (it comes back as null — crbug 1304272). A plain
  // string survives the structured clone reliably.
  const wrapped = `(async () => { ${expression} })()`;
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: async (code) => {
      try {
        // eslint-disable-next-line no-eval
        const value = await eval(code);
        return { ok: true, json: JSON.stringify(value) };
      } catch (err) {
        return { ok: false, error: String(err && err.message || err) };
      }
    },
    args: [wrapped],
  });
  const out = results?.[0]?.result;
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
