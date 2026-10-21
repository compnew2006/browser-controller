/**
 * Shared page-side DOM runtime: one element resolver and one composed-tree
 * walker for every tool, installed once per document (injected source can't import
 * modules).
 *
 * Why: refs used to be looked up by a `[data-mcp-ref]` attribute nothing
 * writes any more, so every ref action fell through to the smart-selector
 * fallback, whose first step returned the FIRST querySelector match — clicks
 * "succeeded" on the wrong element. Selectors also acted on the first match
 * even when it was hidden, and nothing looked inside shadow roots.
 *
 * Each parsed locator kind uses its own matcher: refs, visible text, exact
 * role/name, points and CSS selectors. Matches cover the composed tree (open/closed
 * shadow roots + same-origin iframes); anything ambiguous is reported, never guessed.
 */

export const PAGE_DOM_VERSION = 15;

/**
 * `refBase`: the highest ref number the tab's earlier documents showed (lib/state.js
 * refHighWaterByTab). This document's counter starts there, so its refs never reuse a
 * number an earlier document issued: a stale ref from that page is REF_GONE, never a
 * different element of this one.
 */
export function PAGE_DOM_INSTALL(version, refBase = 0) {
  if (globalThis.__bcDom && globalThis.__bcDom.v === version) return false;
  const REGISTRY_KEY = '__browserControllerLegacyRefRegistry';
  const registry = globalThis[REGISTRY_KEY] instanceof Map ? globalThis[REGISTRY_KEY] : new Map();
  globalThis[REGISTRY_KEY] = registry;

  // Uncaught errors in this isolated world. chrome.scripting hands back a bare
  // null when an injected function throws, so lib/page-exec.js reads the last
  // error recorded here (and clears it) to turn that null into a failure.
  if (!globalThis.__bcErrorRecorder && typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    globalThis.__bcErrorRecorder = true;
    window.addEventListener('error', (e) => {
      const err = e && e.error;
      const message = String((err && err.message) || String((e && e.message) || 'error').replace(/^Uncaught\s+/, ''));
      globalThis.__bcPageError = { message, at: Date.now() };
    });
  }

  /** Computed style from the element's own window (frames have their own). */
  function styleOf(el) {
    try { return ((el.ownerDocument && el.ownerDocument.defaultView) || globalThis).getComputedStyle(el); } catch { return null; }
  }
  const connected = (el) => !!el && el.isConnected !== false;

  const clean = (v, max = 160) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max);
  const attr = (el, n) => (el && el.getAttribute ? el.getAttribute(n) || '' : '');

  /**
   * Elements the extension injects into pages (lib/overlay.js, the agent cursor
   * below). They are never page content: find, snapshot and text skip them.
   */
  const EXTENSION_IDS = new Set(['__bc-lock-shield', '__bc-agent-cursor']);
  function isExtensionNode(el) {
    for (let cur = el, guard = 0; cur && cur.nodeType === 1 && guard < 512; guard++) {
      if (EXTENSION_IDS.has(cur.id)) return true;
      cur = cur.parentElement || (cur.parentNode && cur.parentNode.host) || null;
    }
    return false;
  }

  /**
   * Stable refs (contract "Refs"): an element keeps its `e<n>` ref for as long as
   * the document lives, and every snapshot, find and target resolution issues the
   * same ref for the same element. The counter and the element→ref map sit beside
   * the registry and are reset with it (a new registry is a new document here).
   */
  const REF_STATE_KEY = '__browserControllerRefState';
  const priorRefs = globalThis[REF_STATE_KEY];
  const base = Number.isInteger(refBase) && refBase > 0 ? refBase : 0;
  const refState = priorRefs && priorRefs.registry === registry ? priorRefs : { registry, base, seq: base, ids: new WeakMap() };
  globalThis[REF_STATE_KEY] = refState;
  /** The ref an element has, or the one it will get: nothing is issued or registered. */
  function peekRef(el) {
    return refState.ids.get(el) || `e${refState.seq + 1}`;
  }
  /** The element's stable ref, registered in the page registry (the first sight issues it). */
  function refFor(el) {
    let ref = refState.ids.get(el);
    if (!ref) {
      refState.seq += 1;
      ref = `e${refState.seq}`;
      refState.ids.set(el, ref);
    }
    registry.set(ref, el);
    return ref;
  }
  /** Was this ref issued in this tab (this document or an earlier one)? `e<n>` with n at most the counter. */
  function refIssued(ref) {
    const m = /^e(\d+)$/.exec(String(ref || ''));
    return !!m && Number(m[1]) >= 1 && Number(m[1]) <= refState.seq;
  }
  /** Was this ref issued by an earlier document of the tab (its number is at or below this document's start)? */
  function refIsEarlier(ref) {
    const m = /^e(\d+)$/.exec(String(ref || ''));
    return !!m && Number(m[1]) >= 1 && Number(m[1]) <= refState.base;
  }
  /** Drop the registry entries whose element has left the document (each snapshot runs this). */
  function pruneRegistry() {
    for (const [ref, el] of Array.from(registry.entries())) if (!connected(el)) registry.delete(ref);
  }

  /** Open or closed shadow root (closed ones via chrome.dom in the isolated world). */
  function shadowOf(el) {
    if (!el || el.nodeType !== 1) return null;
    if (el.shadowRoot) return el.shadowRoot;
    try {
      if (typeof chrome !== 'undefined' && chrome.dom && chrome.dom.openOrClosedShadowRoot) return chrome.dom.openOrClosedShadowRoot(el) || null;
    } catch { /* not an element that can host a root */ }
    return null;
  }

  function frameDoc(el) {
    if (!el || el.tagName !== 'IFRAME' && el.tagName !== 'FRAME') return null;
    try { return el.contentDocument || null; } catch { return null; }
  }

  /** Every search root: documents (top + same-origin frames) and shadow roots. */
  function allRoots(withShadow) {
    const roots = [];
    const seen = new Set();
    const visit = (root, depth) => {
      if (!root || seen.has(root) || depth > 6) return;
      seen.add(root);
      roots.push(root);
      let els = [];
      try { els = root.querySelectorAll(withShadow ? '*' : 'iframe,frame'); } catch {}
      for (const el of els) {
        const d = frameDoc(el);
        if (d) visit(d, depth + 1);
        if (withShadow) { const s = shadowOf(el); if (s) visit(s, depth + 1); }
      }
    };
    visit(document, 0);
    return roots;
  }

  function queryAll(sel, withShadow) {
    const out = [];
    for (const root of allRoots(withShadow)) {
      try { for (const el of root.querySelectorAll(sel)) out.push(el); } catch { return null; /* invalid selector */ }
    }
    return out;
  }

  /**
   * Composed-ancestor aware: display/visibility/opacity/content-visibility + a real box.
   * `ignoreOpacity`: opacity:0 still counts as rendered (a real click reaches it).
   */
  function isVisible(el, { ignoreOpacity = false } = {}) {
    if (!connected(el)) return false;
    // An element in a hidden/transparent/zero-size iframe is not visible either.
    let frameEl;
    try { frameEl = el.ownerDocument && el.ownerDocument.defaultView ? el.ownerDocument.defaultView.frameElement : null; } catch { frameEl = null; }
    if (frameEl && !isVisible(frameEl, { ignoreOpacity })) return false;
    try {
      if (typeof el.checkVisibility === 'function'
        && !el.checkVisibility({ checkOpacity: !ignoreOpacity, checkVisibilityCSS: true, contentVisibilityAuto: true })) return false;
    } catch { /* old engine */ }
    let r;
    try { r = el.getBoundingClientRect(); } catch { return false; }
    if (r.width > 0 && r.height > 0) return true;
    // display:contents hosts / slots have no box of their own, and a box that does not clip can be
    // collapsed by its own content (a list of floats is 0 px high, a squeezed column 0 px wide with
    // its text overflowing it): visible if a child element or a text of its own is.
    try {
      const st = styleOf(el);
      const unclipped = st && st.overflowX === 'visible' && st.overflowY === 'visible';
      if (st && (st.display === 'contents' || unclipped)) {
        for (const c of flatChildren(el)) {
          if (c.nodeType === 1 && isVisible(c, { ignoreOpacity })) return true;
          if (c.nodeType === 3 && textHasBox(c)) return true;
        }
      }
    } catch {}
    return false;
  }

  /** Does a text node lay out a box of its own (it shows even when its element has none)? */
  function textHasBox(node) {
    if (!clean(node.textContent)) return false;
    try {
      const range = node.ownerDocument.createRange();
      range.selectNodeContents(node);
      const r = range.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    } catch { return false; }
  }

  /** Flat-tree children: shadow content replaces light children, slots show what is assigned. */
  function flatChildren(node) {
    if (!node) return [];
    if (node.nodeType === 1) {
      const s = shadowOf(node);
      if (s) return Array.from(s.childNodes);
      if (node.tagName === 'SLOT' && typeof node.assignedNodes === 'function') {
        const assigned = node.assignedNodes({ flatten: true });
        if (assigned.length) return assigned;
      }
      const d = frameDoc(node);
      if (d) return d.body ? [d.body] : [];
    }
    return Array.from(node.childNodes || node.children || []);
  }


  const INPUT_BUTTONS = ['button', 'submit', 'reset', 'image'];
  function roleOf(el) {
    const explicit = clean(attr(el, 'role')).split(' ')[0];
    if (explicit) return explicit;
    const tag = String(el.tagName || '').toLowerCase();
    const type = String(el.type || attr(el, 'type') || '').toLowerCase();
    if (tag === 'button' || tag === 'summary') return 'button';
    if (tag === 'a') return el.hasAttribute('href') ? 'link' : 'generic';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'select') return el.multiple ? 'listbox' : 'combobox';
    if (tag === 'option') return 'option';
    if (tag === 'img') return 'img';
    if (/^h[1-6]$/.test(tag)) return 'heading';
    if (tag === 'input') {
      if (INPUT_BUTTONS.includes(type)) return 'button';
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio';
      if (type === 'range') return 'slider';
      if (type === 'search') return 'searchbox';
      if (type === 'hidden') return 'none';
      return 'textbox';
    }
    if (el.isContentEditable) return 'textbox';
    const map = { nav: 'navigation', main: 'main', header: 'banner', footer: 'contentinfo', form: 'form', dialog: 'dialog', table: 'table', ul: 'list', ol: 'list', li: 'listitem', aside: 'complementary' };
    return map[tag] || 'generic';
  }

  // Block and table-cell boundaries are word boundaries ("1</td><td>قطعه" → "1 قطعه");
  // inline markup is not ("Lo<b>g</b>in" stays "Login"). Tag-based: no style reads.
  const SEPARATED_TAGS = new Set(['TD', 'TH', 'TR', 'LI', 'DIV', 'P', 'BR', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'DT', 'DD',
    'TABLE', 'THEAD', 'TBODY', 'TFOOT', 'CAPTION', 'UL', 'OL', 'DL', 'SECTION', 'ARTICLE', 'HEADER', 'FOOTER', 'NAV',
    'ASIDE', 'MAIN', 'FIGCAPTION', 'BLOCKQUOTE', 'PRE', 'OPTION', 'FIELDSET', 'LEGEND', 'FORM']);

  /**
   * Composed text (includes shadow content) — innerText misses shadow roots. `shownOnly` leaves
   * out what does not show: a display:none subtree, and the text of a visibility:hidden element.
   */
  function composedText(el, max = 300, shownOnly = false) {
    let out = '';
    let budget = max * 4; // raw chars incl. whitespace; stops long before a big container's full text
    const walk = (n, unseen) => {
      if (budget <= 0) return;
      if (n.nodeType === 3) { if (!unseen) { out += n.nodeValue; budget -= n.nodeValue.length; } return; }
      if (n.nodeType === 1 && n.childNodes === undefined && !shadowOf(n)) {
        const t = String(n.textContent ?? n.innerText ?? ''); out += t; budget -= t.length; return; // minimal DOMs
      }
      if (n.nodeType !== 1 && n.nodeType !== 11) return;
      if (n.nodeType === 1 && (n.tagName === 'SCRIPT' || n.tagName === 'STYLE')) return;
      let hidden = unseen;
      if (shownOnly && n.nodeType === 1) {
        const st = styleOf(n);
        if (n.hidden || (st && st.display === 'none')) return;
        if (st && st.visibility) hidden = st.visibility !== 'visible';
      }
      const sep = n.nodeType === 1 && SEPARATED_TAGS.has(n.tagName) ? ' ' : '';
      out += sep;
      for (const c of flatChildren(n)) walk(c, hidden);
      out += sep;
    };
    walk(el, false);
    return clean(out, max);
  }

  /** `shownOnly`: a name from the element's own text counts only the text that shows (composedText). */
  function nameOf(el, shownOnly = false) {
    const labelledBy = attr(el, 'aria-labelledby');
    if (labelledBy) {
      let root = null;
      try { root = el.getRootNode(); } catch {}
      const t = labelledBy.split(/\s+/).map((id) => {
        const l = (root && root.getElementById && root.getElementById(id)) || el.ownerDocument.getElementById(id);
        return l ? clean(l.textContent) : '';
      }).filter(Boolean).join(' ');
      if (t) return clean(t);
    }
    const aria = clean(attr(el, 'aria-label'));
    if (aria) return aria;
    try {
      const labels = Array.from(el.labels || []).map((l) => clean(l.textContent)).filter(Boolean);
      if (labels.length) return clean(labels.join(' '));
    } catch {}
    const tag = String(el.tagName || '').toLowerCase();
    const type = String(el.type || '').toLowerCase();
    if (tag === 'input' && INPUT_BUTTONS.includes(type) && el.value) return clean(el.value);
    for (const a of ['alt', 'title', 'placeholder']) { const v = clean(attr(el, a)); if (v) return v; }
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return '';
    // Bounded composed text: CSS-independent (innerText applies text-transform:
    // uppercase), includes shadow content, and never materialises a huge
    // container's whole textContent.
    return composedText(el, 200, shownOnly);
  }

  /** Text the element holds itself: its direct text nodes, cleaned (descendants excluded). */
  function ownText(el, max = 80) {
    let out = '';
    for (const c of el.childNodes || []) if (c.nodeType === 3) out += c.nodeValue;
    return clean(out, max);
  }

  const INTERACTIVE_ROLES = new Set(['button', 'link', 'textbox', 'searchbox', 'combobox', 'listbox', 'checkbox', 'radio', 'switch', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'option', 'slider', 'spinbutton', 'treeitem']);
  function isInteractive(el) {
    const tag = el.tagName;
    if (['A', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'SUMMARY'].includes(tag)) return tag !== 'A' || el.hasAttribute('href') || el.hasAttribute('onclick');
    if (INTERACTIVE_ROLES.has(roleOf(el))) return true;
    if (el.isContentEditable) return true;
    const ti = attr(el, 'tabindex');
    if (ti !== '' && Number(ti) >= 0) return true;
    return typeof el.onclick === 'function';
  }

  /** Exact, or wanted + non-letter suffix ("Login »"). */
  function preciseMatch(candidate, wanted) {
    const c = clean(candidate).toLowerCase();
    const w = clean(wanted).toLowerCase();
    if (!w) return false;
    if (c === w) return true;
    return w.length > 2 && c.length > w.length && c.startsWith(w) && !/[a-zà-ÿ؀-ۿ]/i.test(c.slice(w.length));
  }

  function firstVisible(list) {
    if (!list || !list.length) return null;
    for (const el of list) if (isVisible(el)) return el;
    return null;
  }


  /** Fallback descriptor → element, only when the match is unambiguous. */
  function byFallback(fb) {
    if (!fb) return null;
    const wantTag = fb.tag || null;
    const wantRole = fb.role || null;
    const wantNth = typeof fb.nth === 'number' && fb.nth >= 0 ? fb.nth : 0;
    const effRole = (el) => attr(el, 'role') || el.tagName.toLowerCase();
    const textOk = (el) => !fb.text || preciseMatch(nameOf(el), fb.text)
      || preciseMatch(clean(el.textContent).split('\n')[0], fb.text)
      || preciseMatch(attr(el, 'aria-label') || attr(el, 'alt') || attr(el, 'title') || attr(el, 'placeholder'), fb.text);
    // A descriptor names its role the generator's way (role attribute or tag name) or the snapshot's (roleOf: link, textbox…).
    const same = (el) => (!wantTag || el.tagName === wantTag) && (!wantRole || effRole(el) === wantRole || roleOf(el) === wantRole);

    if (fb.robustSelector) {
      const cands = (queryAll(fb.robustSelector, true) || []).filter((el) => same(el) && isVisible(el));
      const named = fb.text ? cands.filter(textOk) : cands;
      // The recorded ordinal decides: a lone look-alike is the element only when it is the first one.
      if (named.length > wantNth) return named[wantNth];
      if (named.length > 1) return null; // several look-alikes and the ordinal no longer fits: don't guess
    }
    if (!fb.text) return null;
    const matches = [];
    const sel = wantTag ? wantTag.toLowerCase() : '*';
    for (const el of queryAll(sel, true) || []) {
      if (!same(el) || !isVisible(el)) continue;
      if (textOk(el)) matches.push(el);
    }
    if (matches.length > wantNth) return matches[wantNth];
    return null;
  }


  const TEXT_SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'HEAD', 'HTML', 'BODY', 'META', 'LINK']);
  /** The node above `n` in the composed tree: parent, shadow host or frame element. */
  function composedParent(n) {
    if (n.parentElement) return n.parentElement;
    let root = null;
    try { root = n.getRootNode(); } catch {}
    if (root && root.host) return root.host;
    return (root && root.nodeType === 9 && root.defaultView && root.defaultView.frameElement) || null;
  }

  function isAccessibilityHidden(el) {
    for (let node = el; node; node = composedParent(node)) {
      if (node.nodeType === 1 && (attr(node, 'aria-hidden').toLowerCase() === 'true' || node.inert === true)) return true;
    }
    return false;
  }

  /**
   * `text=<words>` (lib/target.js): the visible elements whose accessible name or
   * text equals the words (case-insensitive, whitespace collapsed); when none
   * equals, the ones that contain them. Among those, the innermost interactive
   * match, else the innermost element. Returns the distinct best matches (empty
   * when there are none).
   */
  function byText(text) {
    const want = clean(text, 500).toLowerCase();
    if (!want) return [];
    const equal = [];
    const contained = [];
    for (const root of allRoots(true)) {
      let els = [];
      try { els = root.querySelectorAll('*'); } catch {}
      for (const el of els) {
        if (TEXT_SKIP.has(el.tagName)) continue;
        const holds = (name, own) => ({ equal: name === want || own === want, any: name.includes(want) || own.includes(want) });
        // A cheap pass over all text first; then only the text that shows counts (a closed
        // submenu's words are inside its visible menu's text).
        if (!holds(clean(nameOf(el), 500).toLowerCase(), clean(composedText(el, 200), 500).toLowerCase()).any) continue;
        if (!isVisible(el) || isExtensionNode(el)) continue;
        const shown = holds(clean(nameOf(el, true), 500).toLowerCase(), clean(composedText(el, 200, true), 500).toLowerCase());
        if (shown.any) (shown.equal ? equal : contained).push(el);
      }
    }
    const pool = equal.length ? equal : contained;
    const interactive = pool.filter((el) => isInteractive(el));
    const cands = interactive.length ? interactive : pool;
    // Innermost: one upward walk per candidate marks each ancestor once (linear).
    const holdsOne = new Set();
    for (const c of cands) for (let a = composedParent(c); a && !holdsOne.has(a); a = composedParent(a)) holdsOne.add(a);
    return cands.filter((c) => !holdsOne.has(c));
  }

  /** Exact accessible role and name match, optionally selecting a zero-based occurrence. */
  function byRole(target) {
    const role = clean(target.role, 80).toLowerCase();
    const name = clean(target.name, 500).toLowerCase();
    const hits = [];
    for (const root of allRoots(true)) {
      let els = [];
      try { els = root.querySelectorAll('*'); } catch {}
      for (const el of els) {
        if (TEXT_SKIP.has(el.tagName) || isExtensionNode(el) || isAccessibilityHidden(el) || !isVisible(el)) continue;
        if (clean(roleOf(el), 80).toLowerCase() === role && clean(nameOf(el), 500).toLowerCase() === name) hits.push(el);
      }
    }
    return hits;
  }

  /**
   * The one target resolver. `t` is the object lib/target.js parseTarget returns;
   * `fb` is the snapshot's fallback descriptor for a ref (as resolve() takes it), so
   * a re-rendered element is still re-found. Returns one of:
   *   { el, via }                  an element (via: 'text' | 'role' | 'ref' | 'selector')
   *   { point, el, via: 'point' }  a viewport point; `el` is the element under it, or null
   *   { error: 'CODE: message' }   text, selector and ambiguity failures
   *   { error: 'REF_GONE', ref, issued, earlier }  a ref miss: the bare code. `issued` says whether
   *                                the ref was issued in this tab (its element is gone)
   *                                or never was (REF_NOT_FOUND); `earlier` says it was issued by an
   *                                earlier document of the tab. lib/ref-errors.js words it.
   */
  function resolveTarget(t, fb) {
    if (!t) return { error: 'INVALID_ARGUMENT: target is empty' };
    if (t.kind === 'point') {
      let el = null;
      try { el = elementAt(t.x, t.y); } catch { /* detached mid-hit-test: no element under it */ }
      return { point: { x: t.x, y: t.y }, el, via: 'point' };
    }
    if (t.kind === 'text') {
      const hits = byText(t.text);
      if (hits.length === 0) return { error: `NOT_FOUND: no visible element with text "${t.text}"` };
      if (hits.length === 1) return { el: hits[0], via: 'text' };
      // Each candidate gets its stable ref, so the agent can retry with one of them.
      const shown = hits.slice(0, 5).map((el) => `${refFor(el)} "${nameOf(el).slice(0, 60)}"`);
      return { error: `AMBIGUOUS: text=${t.text} matches ${hits.length} elements: ${shown.join(', ')}${hits.length > 5 ? ', …' : ''}` };
    }
    if (t.kind === 'role') {
      const hits = byRole(t);
      const label = `role=${t.role} name=${JSON.stringify(t.name)}`;
      if (t.nth !== undefined) {
        if (!hits[t.nth]) return { error: `NOT_FOUND: ${label} nth=${t.nth} has ${hits.length} exact match(es)` };
        return { el: hits[t.nth], via: 'role' };
      }
      if (hits.length === 0) return { error: `NOT_FOUND: no visible ${label} element` };
      if (hits.length === 1) return { el: hits[0], via: 'role' };
      const shown = hits.slice(0, 5).map((el) => `${refFor(el)} "${nameOf(el).slice(0, 60)}"`);
      return { error: `AMBIGUOUS: ${label} matches ${hits.length} elements: ${shown.join(', ')}${hits.length > 5 ? ', …' : ''}` };
    }
    if (t.kind === 'ref') {
      const hit = registry.get(t.ref);
      if (connected(hit)) return { el: hit, via: 'ref' };
      if (hit) registry.delete(t.ref);
      // A ref from an earlier document is never re-found: its descriptor describes that page.
      const again = fb && !refIsEarlier(t.ref) ? byFallback(fb) : null;
      if (again) { registry.set(t.ref, again); return { el: again, via: 'fallback', ref: t.ref }; }
      return { error: 'REF_GONE', ref: t.ref, issued: refIssued(t.ref), earlier: refIsEarlier(t.ref), url: location.href };
    }
    if (t.kind === 'selector') {
      let all = queryAll(t.selector, false);
      if (all === null) return { error: `INVALID_SELECTOR: ${t.selector}` };
      let el = firstVisible(all);
      if (!el) {
        all = queryAll(t.selector, true) || [];
        el = firstVisible(all);
      }
      if (el) return { el, via: 'selector' };
      if (all.length) return { error: `ELEMENT_HIDDEN: ${t.selector} matches only hidden elements` };
      return { error: `NOT_FOUND: ${t.selector} matches nothing` };
    }
    return { error: `INVALID_ARGUMENT: unknown target kind ${t.kind}` };
  }

  /** Top-level viewport centre of an element (adds same-origin iframe offsets). */
  function centerOf(el) {
    const rect = el.getBoundingClientRect();
    let x = rect.left + rect.width / 2;
    let y = rect.top + rect.height / 2;
    let win = el.ownerDocument ? el.ownerDocument.defaultView : null;
    while (win && win !== globalThis.window && win.frameElement) {
      const fr = win.frameElement.getBoundingClientRect();
      const cs = win.frameElement.ownerDocument.defaultView.getComputedStyle(win.frameElement);
      x += fr.left + (parseFloat(cs.borderLeftWidth) || 0) + (parseFloat(cs.paddingLeft) || 0);
      y += fr.top + (parseFloat(cs.borderTopWidth) || 0) + (parseFloat(cs.paddingTop) || 0);
      win = win.parent;
    }
    return { x, y, rect };
  }

  /**
   * The extension's own overlays (lock shield, agent cursor: ids __bc-*) are
   * transparent to hit-testing: a click is judged against the page underneath.
   */
  function isOwnOverlay(n) {
    return !!(n && typeof n.closest === 'function' && n.closest('[id^="__bc-"]'));
  }
  /** Topmost page element at a point in one document or shadow root. */
  function topAt(root, x, y) {
    let stack = null;
    if (typeof root.elementsFromPoint === 'function') stack = root.elementsFromPoint(x, y);
    else if (typeof root.elementFromPoint === 'function') stack = [root.elementFromPoint(x, y)];
    for (const n of stack || []) if (n && !isOwnOverlay(n)) return n;
    return null;
  }

  /** Composed hit-test: the deepest element at a top-level point (pierces shadow roots and same-origin frames). */
  function elementAt(x, y) {
    let doc = document;
    let px = x;
    let py = y;
    let hit = null;
    for (let guard = 0; guard < 8; guard++) {
      let h = topAt(doc, px, py);
      while (h) {
        const s = shadowOf(h);
        const inner = s ? topAt(s, px, py) : null;
        if (!inner || inner === h) break;
        h = inner;
      }
      if (!h) break;
      hit = h;
      const d = frameDoc(h);
      if (!d) break;
      const fr = h.getBoundingClientRect();
      px -= fr.left; py -= fr.top;
      doc = d;
    }
    return hit;
  }

  /** Disabled natively (incl. inside a disabled fieldset) or aria-disabled="true" on it or an ancestor. */
  function isDisabled(el) {
    try { if (el.matches && el.matches(':disabled')) return true; } catch { /* selector unsupported here */ }
    for (let n = el; n && n.nodeType === 1; n = n.parentElement || (n.getRootNode && n.getRootNode().host) || null) {
      if (attr(n, 'aria-disabled') === 'true') return true;
    }
    return false;
  }

  /** Controls a <label> can name: a click on the label reaches them. */
  const LABELABLE = new Set(['BUTTON', 'INPUT', 'METER', 'OUTPUT', 'PROGRESS', 'SELECT', 'TEXTAREA']);
  /**
   * The <label>s that name a form control (el.labels, which already includes an
   * enclosing <label> that names it). Not any enclosing <label>: one that names
   * another control does not activate this one.
   */
  function labelsOf(el) {
    if (!el || !LABELABLE.has(el.tagName)) return [];
    try { return Array.from(el.labels || []); } catch { return []; }
  }
  const isCheckable = (el) => el.tagName === 'INPUT' && ['checkbox', 'radio'].includes(String(el.type || attr(el, 'type') || '').toLowerCase());
  /** Displayed (display, visibility, ancestors), opacity ignored; the box itself may be empty. */
  function rendered(el) {
    try {
      if (typeof el.checkVisibility === 'function') return el.checkVisibility({ checkOpacity: false, checkVisibilityCSS: true, contentVisibilityAuto: true });
    } catch { /* old engine: read the style below */ }
    const st = styleOf(el);
    return !!st && st.display !== 'none' && st.visibility !== 'hidden';
  }
  /** Topmost element at a top-level point, or null (detached mid-measure). */
  function hitAt(at) {
    try { return elementAt(at.x, at.y); } catch { return null; }
  }
  /**
   * Does a click that lands on `hit` reach `el`? Yes for `el` itself, anything
   * inside it, and anything inside one of its labels (a click on a <label>
   * activates its control, as a person's click does). A null hit reaches it too.
   */
  function reachesControl(el, hit) {
    if (!hit || hit === el || composedContains(el, hit)) return true;
    return labelsOf(el).some((label) => composedContains(label, hit));
  }
  function coveredBy(el, hit) {
    return { message: `ELEMENT_COVERED: the click point of ${describe(el)} is covered by ${describe(hit)}; the click would land there instead.` };
  }

  /**
   * Why a real click on `el` would not reach it, or null when it would.
   * Checked before any click (CDP or synthetic) so a failed click reports
   * itself instead of "success". Returns { message } with a CODE prefix.
   */
  function clickBlocker(el) {
    const rect = el.getBoundingClientRect();
    if (!(rect.width > 0 && rect.height > 0) || !isVisible(el, { ignoreOpacity: true })) {
      return { message: `ELEMENT_HIDDEN: ${describe(el)} is not displayed (display:none, visibility:hidden or zero size); nothing was clicked.` };
    }
    if (isDisabled(el)) return { message: `ELEMENT_DISABLED: ${describe(el)} is disabled; nothing was clicked.` };
    const hit = hitAt(centerOf(el));
    if (!reachesControl(el, hit)) return coveredBy(el, hit);
    return null;
  }

  /**
   * Where a click on `el` goes: { node, x, y, via? } for a click that can reach
   * it, or { message } (the clickBlocker codes) when it cannot. A checkbox or
   * radio is often hidden under its styled <label> (an opacity:0 input, or no
   * box at all) and the label is the visible control: when the control's own
   * point is covered by its visible label, the click goes to the label's centre
   * and says so (via 'label'; the label's click toggles the control). Any other
   * cover is still ELEMENT_COVERED.
   */
  function clickTarget(el) {
    const label = isCheckable(el) ? labelsOf(el).find((l) => isVisible(l)) || null : null;
    if (label && rendered(el) && !isDisabled(el)) {
      const rect = el.getBoundingClientRect();
      const boxless = !(rect.width > 0 && rect.height > 0);
      if (boxless || composedContains(label, hitAt(centerOf(el)))) {
        const at = centerOf(label);
        const hit = hitAt(at);
        if (!hit || composedContains(label, hit) || composedContains(el, hit)) return { node: label, x: at.x, y: at.y, via: 'label' };
        return coveredBy(label, hit);
      }
    }
    const block = clickBlocker(el);
    if (block) return block;
    const at = centerOf(el);
    return { node: el, x: at.x, y: at.y };
  }

  function composedContains(a, b) {
    let cur = b;
    const seen = new Set();
    while (cur && !seen.has(cur)) {
      if (cur === a) return true;
      seen.add(cur);
      let root = null;
      try { root = cur.getRootNode(); } catch {}
      let frameEl = null;
      try { frameEl = root && root.nodeType === 9 && root.defaultView ? root.defaultView.frameElement : null; } catch {}
      cur = cur.parentElement || (root && root.host) || frameEl || null;
    }
    return false;
  }

  /**
   * Text of the table/grid row holding `el` (a TR or role="row" ancestor,
   * across shadow roots), minus the cell(s) that contain `el` itself: tells
   * apart look-alike controls such as one icon-only "Edit" button per row.
   * '' when `el` is not inside a row.
   */
  function rowContextOf(el, max = 80) {
    const up = (n) => {
      if (n.parentElement) return n.parentElement;
      let root = null;
      try { root = n.getRootNode(); } catch {}
      return root && root.host ? root.host : null;
    };
    let row = up(el);
    while (row && row.tagName !== 'TR' && roleOf(row) !== 'row') {
      if (row.tagName === 'TABLE' || row.tagName === 'BODY') return '';
      row = up(row);
    }
    if (!row) return '';
    const parts = [];
    for (const cell of flatChildren(row)) {
      if (cell.nodeType !== 1 || composedContains(cell, el)) continue;
      const st = styleOf(cell);
      if (st && (st.display === 'none' || st.visibility === 'hidden')) continue; // a hidden column is not what the user reads
      const t = composedText(cell, max);
      if (t) parts.push(t);
    }
    return clean(parts.join(' '), max);
  }

  function describe(el) {
    if (!el) return null;
    return el.tagName.toLowerCase() + (el.id ? `#${el.id}` : '')
      + (typeof el.className === 'string' && el.className.trim() ? `.${el.className.trim().split(/\s+/).slice(0, 2).join('.')}` : '');
  }

  const BLOCK_DISPLAY = /^(block|flex|grid|list-item|table|table-row|table-caption|flow-root|inline-block)$/;
  const ARTICLE_SKIP_ROLES = new Set(['navigation', 'banner', 'contentinfo', 'complementary', 'search', 'menu', 'menubar', 'toolbar', 'dialog', 'alertdialog']);
  const ARTICLE_SKIP_TAGS = new Set(['NAV', 'FOOTER', 'ASIDE', 'HEADER', 'FORM', 'BUTTON', 'DIALOG']);
  const ARTICLE_SKIP_HINT = /(^|[-_ ])(cookie|consent|sidebar|side-bar|menu|navbar|nav|footer|breadcrumbs?|share|social|advert|ads|promo|newsletter|related|comments?)([-_ ]|$)/i;

  /**
   * Visible text of the flat tree (shadow roots, slots, same-origin frames),
   * block elements on their own lines. `article` skips navigation, headers,
   * footers, sidebars, banners and similar page chrome.
   */
  function flatText(root, { article = false, max = 1e7 } = {}) {
    const parts = [];
    let len = 0;
    const push = (t) => { parts.push(t); len += t.length; };
    // pre: inside white-space:pre* the text keeps its own line breaks.
    const walk = (n, pre) => {
      if (len > max) return;
      if (n.nodeType === 3) {
        if (pre) { if (n.nodeValue.trim()) push(n.nodeValue.replace(/\n/g, '\u2029')); return; }
        const v = n.nodeValue.replace(/\s+/g, ' ');
        if (v.trim()) push(v);
        return;
      }
      if (n.nodeType === 11 || n.nodeType === 9) { for (const c of flatChildren(n)) walk(c, pre); return; }
      if (n.nodeType !== 1) return;
      if (EXTENSION_IDS.has(n.id)) return; // the lock shield's label is not page text
      const tag = n.tagName;
      if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT' || tag === 'TEMPLATE' || tag === 'svg' || tag === 'SVG') return;
      if (tag === 'BR') { push('\n'); return; }
      if (article && n !== root) {
        if (ARTICLE_SKIP_TAGS.has(tag) && !(tag === 'HEADER' && n.closest && n.closest('article, main'))) return;
        if (ARTICLE_SKIP_ROLES.has(roleOf(n))) return;
        const hint = `${n.id || ''} ${typeof n.className === 'string' ? n.className : ''}`;
        if (hint.trim() && ARTICLE_SKIP_HINT.test(hint)) return;
        if (attr(n, 'aria-hidden') === 'true') return;
      }
      const st = styleOf(n);
      if (st && (st.display === 'none' || st.visibility === 'hidden' || st.contentVisibility === 'hidden')) return;
      const block = st ? BLOCK_DISPLAY.test(st.display) : false;
      const inPre = st ? /^pre/.test(st.whiteSpace || '') : pre;
      if (block) push('\n');
      for (const c of flatChildren(n)) walk(c, inPre);
      if (st && st.display === 'table-cell') push(' \t ');
      if (block) push('\n');
    };
    walk(root, false);
    return parts.join('')
      .replace(/[ \t]*\n[ \t]*/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .replace(/[ \t]{2,}/g, ' ')
      .replace(/\u2029/g, '\n') // preformatted line breaks survive the collapsing above
      .trim();
  }



  /**
   * Agent cursor (user request): a visible pointer that glides to wherever the
   * agent's real (CDP) mouse input lands and ripples on clicks, so a person
   * watching the tab can follow the agent. Cosmetic only: pointer-events:none
   * (invisible to hit-testing), never throws, fades out after a few idle
   * seconds. Returns the glide's duration in ms so the caller can hold the
   * real input until the cursor arrives — 0 when there is nothing to wait for
   * (hidden tab, reduced motion, first appearance, no distance).
   *   effect: 'move' | 'click' (count rings) | 'down' / 'up' (drag press and
   *   release) | 'track' (snap to a re-measured point, no glide, no effect)
   */
  const CURSOR_ID = '__bc-agent-cursor';
  const CURSOR_IDLE_MS = 4000;
  const CURSOR_COLOR = '37,99,235'; // the agent-control frame's blue (lib/overlay.js)

  function makeCursor() {
    const el = document.createElement('div');
    el.id = CURSOR_ID;
    el.setAttribute('aria-hidden', 'true');
    // `all:initial` first: page CSS (resets like `svg { max-width:100% }`,
    // which would collapse the arrow inside this 0×0 box) must not reach it.
    el.style.cssText = 'all:initial;display:block;position:fixed;left:0;top:0;width:0;height:0;z-index:2147483647;'
      + 'pointer-events:none;transition:opacity .25s;will-change:transform;';
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('width', '25');
    svg.setAttribute('height', '30');
    svg.setAttribute('viewBox', '0 0 20 24');
    // The arrow's tip is (2, 2) at 1.25x: offset it so the tip sits exactly on the point.
    // pointer-events again: `all:initial` drops the inherited none, and the tip
    // sits exactly on the point the real click must reach.
    svg.style.cssText = 'all:initial;pointer-events:none;position:absolute;left:-2.5px;top:-2.5px;width:25px;height:30px;overflow:visible;'
      + 'transform-origin:2.5px 2.5px;transition:transform .12s;filter:drop-shadow(0 1px 2px rgba(0,0,0,.45));';
    const path = document.createElementNS(NS, 'path');
    path.setAttribute('d', 'M2 2 L2 19.5 L6.6 15.3 L9.7 22.2 L12.9 20.8 L9.9 14 L16 14 Z');
    path.style.cssText = `fill:rgb(${CURSOR_COLOR});stroke:#fff;stroke-width:1.6px;stroke-linejoin:round;`;
    svg.appendChild(path);
    el.appendChild(svg);
    return el;
  }

  function cursorEffect(el, effect, count) {
    try {
      const arrow = el.lastChild;
      if (effect === 'down') { arrow.style.transform = 'scale(.8)'; return; }
      if (effect === 'up') { arrow.style.transform = ''; return; }
      // click: one ring per click (double/triple-click), and the arrow presses in.
      const n = Math.min(Math.max(Number(count) || 1, 1), 3);
      for (let i = 0; i < n; i++) {
        const ring = document.createElement('div');
        ring.style.cssText = 'all:initial;position:absolute;left:-20px;top:-20px;width:40px;height:40px;box-sizing:border-box;'
          + `border-radius:50%;border:2px solid rgb(${CURSOR_COLOR});background:rgba(${CURSOR_COLOR},.18);`
          + 'pointer-events:none;opacity:0;';
        el.insertBefore(ring, arrow); // under the arrow
        const a = ring.animate(
          [{ transform: 'scale(.3)', opacity: 1 }, { transform: 'scale(1.5)', opacity: 0 }],
          { duration: 550, delay: i * 130, easing: 'ease-out' },
        );
        a.onfinish = () => ring.remove();
      }
      arrow.animate([{ transform: 'scale(1)' }, { transform: 'scale(.8)' }, { transform: 'scale(1)' }], { duration: 220 });
    } catch { /* cosmetic */ }
  }

  function cursor(x, y, effect = 'move', count = 1) {
    try {
      const root = document.documentElement;
      if (!root || !Number.isFinite(x) || !Number.isFinite(y)) return 0;
      let el = document.getElementById(CURSOR_ID);
      const from = el && el.__bcPos;
      const fresh = !el;
      if (fresh) el = makeCursor();
      // Same z-index as the agent-control shield, which is re-created per
      // action: the later sibling paints on top, so stay the last one.
      if (root.lastElementChild !== el) root.appendChild(el);
      const to = `translate(${x}px,${y}px)`;
      el.style.transform = to;
      el.style.display = 'block'; // back from a screenshot (lib/overlay.js)
      el.style.opacity = '1';
      el.__bcPos = { x, y };
      let still = document.visibilityState === 'hidden';
      try { still = still || matchMedia('(prefers-reduced-motion: reduce)').matches; } catch {}
      let ms = 0;
      if (effect === 'track') {
        // Re-measured after the glide: if the target moved, jump there now.
        const moved = from && Math.hypot(x - from.x, y - from.y) > 1;
        if (moved && el.getAnimations) for (const a of el.getAnimations()) a.cancel();
      } else if (from && !still) {
        const dist = Math.hypot(x - from.x, y - from.y);
        if (dist > 2) ms = Math.round(Math.min(350, 120 + dist * 0.25));
        if (ms) {
          // A drag ('up') glides linearly, in step with its evenly spaced real moves.
          el.animate([{ transform: `translate(${from.x}px,${from.y}px)` }, { transform: to }],
            { duration: ms, easing: effect === 'up' ? 'linear' : 'cubic-bezier(.3,.7,.4,1)' });
        }
      } else if (fresh && !still) {
        el.lastChild.animate([{ opacity: 0, transform: 'scale(.4)' }, { opacity: 1, transform: 'scale(1)' }], { duration: 160, easing: 'ease-out' });
      }
      if (effect !== 'move' && effect !== 'track') setTimeout(() => cursorEffect(el, effect, count), ms);
      clearTimeout(el.__bcIdle);
      el.__bcIdle = setTimeout(() => { el.style.opacity = '0'; }, ms + CURSOR_IDLE_MS);
      return ms;
    } catch {
      return 0; // cosmetic: never break the action it decorates
    }
  }


  const SENSITIVE_FIELD_HINT = /passw|passwd|pwd|secret|credential|token|api[\s_-]*key|(?:one[\s_-]*time|otp|2fa|mfa)|(?:verification|security|auth(?:entication)?)[\s_-]*(?:code|token|key)|(?:credit|debit)[\s_-]*card|(?:cc[\s_-]*(?:number|exp|csc|cvc))|card[\s_-]*(?:number|code|security)|cvv|cvc|iban|bank[\s_-]*account|routing[\s_-]*number/i;
  const sensitiveFieldValue = (el) => {
    if (typeof el?.value === 'string') return el.value;
    return el?.isContentEditable ? String(el.textContent || '') : '';
  };
  function looksLikeCardNumber(value) {
    const digits = String(value || '').replace(/[\s-]/g, '');
    if (!/^\d{13,19}$/.test(digits)) return false;
    let sum = 0;
    let double = false;
    for (let i = digits.length - 1; i >= 0; i--) {
      let digit = Number(digits[i]);
      if (double) { digit *= 2; if (digit > 9) digit -= 9; }
      sum += digit;
      double = !double;
    }
    return sum % 10 === 0;
  }
  function isSensitiveField(el) {
    if (!el || el.nodeType !== 1) return false;
    const tag = el.tagName;
    if (!['INPUT', 'TEXTAREA', 'SELECT'].includes(tag) && !el.isContentEditable && roleOf(el) !== 'textbox') return false;
    const type = String(el.type || attr(el, 'type') || '').toLowerCase();
    if (tag === 'INPUT' && type === 'password') return true;
    const autocomplete = attr(el, 'autocomplete').toLowerCase().split(/\s+/).filter(Boolean);
    if (autocomplete.some((part) => part.startsWith('cc-') || ['one-time-code', 'current-password', 'new-password'].includes(part))) return true;
    const hints = [type, attr(el, 'name'), attr(el, 'id'), attr(el, 'aria-label'), attr(el, 'placeholder'), attr(el, 'title'), nameOf(el), ...labelsOf(el).map((label) => label.textContent || '')].join(' ');
    if (SENSITIVE_FIELD_HINT.test(hints)) return true;
    return looksLikeCardNumber(sensitiveFieldValue(el));
  }
  function redactSensitiveText(text, root = document) {
    let output = String(text ?? '');
    const fields = queryAll('input,textarea,select,[contenteditable],[role="textbox"]', true) || [];
    if (root && root.nodeType === 1 && (root.matches?.('input,textarea,select,[contenteditable],[role="textbox"]'))) fields.push(root);
    const values = new Set();
    for (const field of fields) {
      if ((root === document || root === field || composedContains(root, field)) && isSensitiveField(field)) {
        const value = sensitiveFieldValue(field);
        // A short substring can erase unrelated prose; whole-token matches are safer.
        if (value.length >= 3) values.add(value);
        else if (value && output.trim() === value) output = '••••';
      }
    }
    for (const value of [...values].sort((a, b) => b.length - a.length)) {
      const escaped = [...value].map((char) => '.^$*+?()[]{}|\\'.includes(char) ? '\\' + char : char).join('');
      const pattern = value.length < 4
        ? '(?<![\\p{L}\\p{N}])' + escaped + '(?![\\p{L}\\p{N}])'
        : escaped;
      output = output.replace(new RegExp(pattern, 'gu'), '••••');
    }
    return output;
  }

  globalThis.__bcDom = Object.freeze({
    v: version,
    clean, attr, shadowOf, frameDoc, allRoots, queryAll, isVisible, flatChildren,
    roleOf, nameOf, composedText, isInteractive, preciseMatch, centerOf, elementAt,
    composedContains, rowContextOf, describe, registry, flatText, styleOf, connected, cursor,
    isExtensionNode, clickBlocker, clickTarget, labelsOf, byText, resolveTarget,
    peekRef, refFor, refIssued, refIsEarlier, pruneRegistry, ownText,
    isSensitiveField, redactSensitiveText,
  });
  return true;
}
