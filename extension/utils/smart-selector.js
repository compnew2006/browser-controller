/**
 * Smart Selector — ref-break fallback for browsing dynamic sites (React/Vue SPAs).
 *
 * PROBLEM: snapshot returns `ref:e5`; React re-renders; `click e5` → null.
 *
 * SOLUTION: at snapshot time, capture a STABLE description of each ref'd element
 * (robust CSS selector + text + role + tag + stable attrs). When a ref no longer
 * resolves, the click/type handler tries, in order:
 *   1. the robust CSS selector,
 *   2. a text+role+tag scan.
 * If either works, the action succeeds and the agent gets a "via: fallback"
 * hint so it knows the ref is stale and may re-snapshot when convenient.
 *
 * The only export is PAGE_FALLBACK_INSTALL, a self-contained page-runtime installer
 * injected via chrome.scripting `func:`. Injected source cannot reference extension
 * modules, and eval-rebuilding from a string is impossible under MV3's extension CSP
 * (script-src 'self', no unsafe-eval), so every helper lives inside the installed
 * function. The stale-ref resolver is in lib/page-dom.js (byFallback).
 */

// ---------------------------------------------------------------------------
// Page-side runtime. Self-contained inside PAGE_FALLBACK_INSTALL — injected
// via chrome.scripting `func:`. generateFallback returns
// { robustSelector, text, role, tag, attrs, nth } for one ref'd element.
// ---------------------------------------------------------------------------

export function PAGE_FALLBACK_INSTALL() {
  if (globalThis.__browserControllerFallbackRuntime) return false;

  /**
   * Snapshot-side: capture a stable fallback descriptor for a ref'd element.
   * `pass` is one object per snapshot (or find) pass, shared by all its refs: it
   * holds the sibling index that nth is computed from, so the page is walked once
   * per pass, not once per ref.
   */
  function generateFallback(el, pass) {
  if (!el || !el.tagName) return null;

  function isStableId(id) {
    if (!id || typeof id !== 'string') return false;
    const s = id.trim();
    if (s.length === 0 || s.length > 80) return false;
    if (/[:]/.test(s)) return false;
    if (/^__/.test(s)) return false;
    if (/^(react|aria|headlessui|rc|radix|react-aria|floating-ui)[-_:]/i.test(s)) return false;
    if (/-[a-f0-9]{6,}$/i.test(s) || /-[a-z0-9]{8,}$/i.test(s)) return false;
    if (!/[a-z]/i.test(s)) return false;
    return true;
  }
  function isGeneratedClass(cls) {
    if (!cls || typeof cls !== 'string') return false;
    const c = cls.trim();
    if (/^sc-[a-z0-9]/i.test(c)) return true;
    if (/__sc-/i.test(c)) return true;
    if (/^css-[a-z0-9]{4,}$/i.test(c)) return true;
    if (/^emotion-\d+$/i.test(c)) return true;
    if (/^_?[a-z0-9]{6,}$/i.test(c) && /[0-9]/.test(c) && !/^(_|fx|px|py|m|p|w|h|z|gap)-/.test(c)) return true;
    return false;
  }
  const STABLE_ATTRS = ['data-testid', 'data-test', 'data-cy', 'data-qa', 'aria-label', 'name', 'data-id'];

  function esc(value) {
    try { return CSS.escape(String(value)); } catch { return String(value).replace(/["\\]/g, '\\$&'); }
  }

  function buildSelector(el) {
    const tag = el.tagName.toLowerCase();
    for (const attr of STABLE_ATTRS) {
      const v = el.getAttribute(attr);
      if (v) return `${tag}[${attr}=${esc(v)}]`;
    }
    if (isStableId(el.id)) return `#${esc(el.id)}`;
    const stableClasses = (el.getAttribute('class') || '')
      .split(/\s+/)
      .filter((c) => c && !isGeneratedClass(c))
      .slice(0, 3);
    let selfPart = tag;
    if (stableClasses.length) selfPart = `${tag}.${stableClasses.map((c) => esc(c)).join('.')}`;
    const parts = [selfPart];
    let cur = el.parentElement;
    let climbed = 0;
    while (cur && climbed < 3) {
      if (isStableId(cur.id)) { parts.unshift(`#${esc(cur.id)}`); return parts.join(' > '); }
      const arole = cur.getAttribute('role');
      const lm = cur.tagName.toLowerCase();
      const isLandmark = arole && ['navigation', 'main', 'banner', 'contentinfo', 'form', 'search', 'region'].includes(arole);
      const isSemanticLandmark = ['nav', 'main', 'header', 'footer', 'section', 'aside', 'form'].includes(lm);
      if (isLandmark) { parts.unshift(`${lm}[role=${esc(arole)}]`); return parts.join(' > '); }
      if (isSemanticLandmark) { parts.unshift(lm); return parts.join(' > '); }
      let anchored = false;
      for (const attr of STABLE_ATTRS) {
        const v = cur.getAttribute(attr);
        if (v) { parts.unshift(`${lm}[${attr}=${esc(v)}]`); anchored = true; break; }
      }
      if (anchored) return parts.join(' > ');
      cur = cur.parentElement;
      climbed++;
    }
    return stableClasses.length ? parts.join(' > ') : null;
  }

  // text: prefer aria-label/alt/title, else first line of innerText (trimmed, capped)
  let text = '';
  const named = el.getAttribute('aria-label') || el.getAttribute('alt') || el.getAttribute('title') || el.getAttribute('placeholder');
  if (named) {
    text = named.trim().slice(0, 120);
  } else if (el.innerText) {
    text = (el.innerText.split('\n')[0] || '').trim().slice(0, 120);
  }

  const role = el.getAttribute('role') || el.tagName.toLowerCase();

  /**
   * nth = how many visible same-role elements before `target` (document order)
   * share its text. The pass indexes the body once, grouped by role; each
   * candidate's visibility and text are read once per pass and cached. So a ref
   * costs string comparisons over its same-role predecessors, never a page walk
   * or a style read per ref (a 1,000-row table froze when every ref re-walked it).
   */
  function computeNth(target, wantRole, wantText, pass) {
    if (!wantText) return 0;
    const textLow = wantText.trim().toLowerCase();
    const isTextMatch = (candidate) => {
      const normalized = candidate.trim().toLowerCase();
      if (normalized === textLow) return true;
      if (textLow.length > 2 && normalized.length > textLow.length && normalized.startsWith(textLow)) {
        return !/[a-zà-ÿ]/i.test(normalized.slice(textLow.length));
      }
      return false;
    };

    if (!pass.byRole) {
      pass.byRole = new Map();
      pass.text = new Map();
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const nodeRole = node.getAttribute('role') || node.tagName.toLowerCase();
        let list = pass.byRole.get(nodeRole);
        if (!list) { list = []; pass.byRole.set(nodeRole, list); }
        list.push(node);
      }
    }
    // Visible text of one candidate, read at most once per pass (null when hidden).
    const textOf = (node) => {
      if (pass.text.has(node)) return pass.text.get(node);
      let out = null;
      const style = getComputedStyle(node);
      if (!(style.display === 'none' || style.visibility === 'hidden' || parseFloat(style.opacity) === 0)) {
        const rect = node.getBoundingClientRect();
        if (rect.width !== 0 && rect.height !== 0) {
          out = {
            nodeText: (node.innerText || node.textContent || '').split('\n')[0].trim(),
            accessibleName: (node.getAttribute('aria-label') || node.getAttribute('alt') || node.getAttribute('title') || '').trim(),
          };
        }
      }
      pass.text.set(node, out);
      return out;
    };

    let seen = 0;
    for (const node of pass.byRole.get(wantRole) || []) {
      if (node === target) return seen;
      const t = textOf(node);
      if (t && (isTextMatch(t.nodeText) || isTextMatch(t.accessibleName))) seen++;
    }
    return seen;
  }

  const attrs = {};
  for (const attr of STABLE_ATTRS) {
    const v = el.getAttribute(attr);
    if (v != null) attrs[attr] = v;
  }

  return {
    robustSelector: buildSelector(el),
    text,
    role,
    tag: el.tagName,
    attrs,
    // nth: zero-based ordinal of this element among all visible elements sharing
    // the same (role+name). Captured at snapshot time so the resolver can pick
    // the CORRECT sibling when several elements share text+role (e.g. 3 "Like"
    // buttons). Borrowed from BrowserOS's nth-recovery idea.
    nth: computeNth(el, role, text, pass || {}),
  };
  }

  globalThis.__browserControllerFallbackRuntime = Object.freeze({ generateFallback });
  return true;
}
