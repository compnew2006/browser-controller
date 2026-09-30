/**
 * Shared page-side DOM runtime: one element resolver and one composed-tree
 * walker for every tool, installed once per document (v2 install-once pattern,
 * see observation-v2.js — injected source can't import modules).
 *
 * Why: refs used to be looked up by a `[data-mcp-ref]` attribute nothing
 * writes any more, so every ref action fell through to the smart-selector
 * fallback, whose first step returned the FIRST querySelector match — clicks
 * "succeeded" on the wrong element. Selectors also acted on the first match
 * even when it was hidden, and nothing looked inside shadow roots.
 *
 * Resolution order: ref registry → selector (first VISIBLE match across the
 * composed tree: open/closed shadow roots + same-origin iframes) → verified
 * fallback (unique, or nth among exact role/tag/name matches). Anything
 * ambiguous is reported as gone instead of guessed.
 */

export const PAGE_DOM_VERSION = 1;

export function PAGE_DOM_INSTALL(version) {
  if (globalThis.__bcDom && globalThis.__bcDom.v === version) return false;
  const REGISTRY_KEY = '__browserControllerLegacyRefRegistry';
  const registry = globalThis[REGISTRY_KEY] instanceof Map ? globalThis[REGISTRY_KEY] : new Map();
  globalThis[REGISTRY_KEY] = registry;

  /** Computed style from the element's own window (frames have their own). */
  function styleOf(el) {
    try { return ((el.ownerDocument && el.ownerDocument.defaultView) || globalThis).getComputedStyle(el); } catch { return null; }
  }
  const connected = (el) => !!el && el.isConnected !== false;

  const clean = (v, max = 160) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max);
  const attr = (el, n) => (el && el.getAttribute ? el.getAttribute(n) || '' : '');

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

  /** Composed-ancestor aware: display/visibility/opacity/content-visibility + a real box. */
  function isVisible(el) {
    if (!connected(el)) return false;
    // An element in a hidden/transparent/zero-size iframe is not visible either.
    let frameEl;
    try { frameEl = el.ownerDocument && el.ownerDocument.defaultView ? el.ownerDocument.defaultView.frameElement : null; } catch { frameEl = null; }
    if (frameEl && !isVisible(frameEl)) return false;
    try {
      if (typeof el.checkVisibility === 'function'
        && !el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true, contentVisibilityAuto: true })) return false;
    } catch { /* old engine */ }
    let r;
    try { r = el.getBoundingClientRect(); } catch { return false; }
    if (r.width > 0 && r.height > 0) return true;
    // display:contents hosts / slots have no box of their own: visible if a child is.
    try {
      const st = styleOf(el);
      if (st && st.display === 'contents') {
        for (const c of flatChildren(el)) if (c.nodeType === 1 && isVisible(c)) return true;
      }
    } catch {}
    return false;
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

  function hasShadowHosts() {
    for (const root of allRoots(false)) {
      let els = [];
      try { els = root.querySelectorAll('*'); } catch {}
      for (const el of els) if (shadowOf(el)) return true;
    }
    return false;
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

  /** Composed text (includes shadow content) — innerText misses shadow roots. */
  function composedText(el, max = 300) {
    let out = '';
    let budget = max * 4; // raw chars incl. whitespace; stops long before a big container's full text
    const walk = (n) => {
      if (budget <= 0) return;
      if (n.nodeType === 3) { out += n.nodeValue; budget -= n.nodeValue.length; return; }
      if (n.nodeType === 1 && n.childNodes === undefined && !shadowOf(n)) {
        const t = String(n.textContent ?? n.innerText ?? ''); out += t; budget -= t.length; return; // minimal DOMs
      }
      if (n.nodeType !== 1 && n.nodeType !== 11) return;
      if (n.nodeType === 1 && (n.tagName === 'SCRIPT' || n.tagName === 'STYLE')) return;
      for (const c of flatChildren(n)) walk(c);
    };
    walk(el);
    return clean(out, max);
  }

  function nameOf(el) {
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
    return composedText(el, 200);
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

  /** Exact, or wanted + non-letter suffix ("Login »"). Mirrors isPreciseTextMatch. */
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

  function bySelector(sel) {
    let all = queryAll(sel, false);
    if (all === null) return { error: 'INVALID_SELECTOR' };
    let el = firstVisible(all);
    if (el) return { el, count: all.length };
    const deep = queryAll(sel, true) || [];
    el = firstVisible(deep) || deep[0] || all[0] || null;
    return el ? { el, count: deep.length || all.length, hidden: !isVisible(el) } : null;
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
    const same = (el) => (!wantTag || el.tagName === wantTag) && (!wantRole || effRole(el) === wantRole);

    if (fb.robustSelector) {
      const cands = (queryAll(fb.robustSelector, true) || []).filter((el) => same(el) && isVisible(el));
      const named = fb.text ? cands.filter(textOk) : cands;
      if (named.length === 1) return named[0];
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
    if (matches.length === 1) return matches[0];
    return null;
  }

  /**
   * ref → selector → verified fallback. Returns { el, via } or { error, url }.
   * via: 'ref' | 'selector' | 'fallback'.
   */
  function resolve(ref, sel, fb) {
    if (ref) {
      const el = registry.get(ref);
      if (connected(el)) return { el, via: 'ref' };
      if (el) registry.delete(ref);
    }
    if (sel) {
      const hit = bySelector(sel);
      if (hit && hit.error) return { error: hit.error, url: location.href };
      if (hit) return { el: hit.el, via: 'selector', ...(hit.hidden ? { hidden: true } : {}) };
    }
    if (fb) {
      const el = byFallback(fb);
      if (el) {
        if (ref) registry.set(ref, el); // re-bind so the next call is a direct hit
        return { el, via: 'fallback' };
      }
    }
    return { error: 'REF_GONE', url: location.href };
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

  /** Composed hit-test: the deepest element at a top-level point (pierces shadow roots and same-origin frames). */
  function elementAt(x, y) {
    let doc = document;
    let px = x;
    let py = y;
    let hit = null;
    for (let guard = 0; guard < 8; guard++) {
      let h = doc.elementFromPoint(px, py);
      while (h) {
        const s = shadowOf(h);
        const inner = s && s.elementFromPoint ? s.elementFromPoint(px, py) : null;
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

  /** Main-content root for article mode: the visible <article>/<main>/[role=main] with the most text. */
  function articleRoot() {
    let best = null;
    let bestLen = 0;
    for (const root of allRoots(false)) {
      let els = [];
      try { els = root.querySelectorAll('article, main, [role="main"], [itemprop="articleBody"]'); } catch {}
      for (const el of els) {
        const l = (el.textContent || '').length;
        if (l > bestLen && isVisible(el)) { best = el; bestLen = l; }
      }
    }
    return best || document.body;
  }

  /** Page text: native innerText when there is no shadow DOM (fast), the flat-tree walker otherwise. */
  function pageText(root, { article = false, max = 1e7 } = {}) {
    if (!article && root.ownerDocument === document && typeof root.innerText === 'string' && !hasShadowHosts()) {
      return root.innerText.replace(/\t/g, ' ').replace(/\n\s*\n/g, '\n\n').replace(/ +/g, ' ').trim();
    }
    return flatText(root, { article, max });
  }

  globalThis.__bcDom = Object.freeze({
    v: version,
    clean, attr, shadowOf, frameDoc, allRoots, queryAll, isVisible, flatChildren, hasShadowHosts,
    roleOf, nameOf, composedText, isInteractive, preciseMatch, resolve, centerOf, elementAt,
    composedContains, describe, registry, flatText, articleRoot, pageText, styleOf, connected,
  });
  return true;
}
