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
 * This file has TWO layers:
 *   - Pure heuristic helpers (exported) — unit-testable in node, no DOM needed.
 *   - PAGE_FALLBACK_FN — the function actually injected into the page via
 *     chrome.scripting. It is self-contained (no imports) because the page world
 *     cannot import extension modules. The heuristics are duplicated verbatim
 *     inside it so there is a SINGLE readable source for the algorithm.
 */

// ---------------------------------------------------------------------------
// Pure heuristics (exported for unit testing). DOM-free where possible.
// ---------------------------------------------------------------------------

/**
 * Is an id stable enough to select on? We reject:
 *   - React/Awesome id generation: `:r5:`, `:R3aq:`, `__BVID__123`, `rc-...`
 *   - Hashed ids: `react-aria-1-abc23`, `headlessui-...`
 *   - Empty / whitespace.
 * Stable examples: `submit-btn`, `login-form`, `nav-header`, `btn-cta`.
 * @param {string} id
 * @returns {boolean}
 */
export function isStableId(id) {
  if (!id || typeof id !== 'string') return false;
  const s = id.trim();
  if (s.length === 0 || s.length > 80) return false;
  // colons = React/Aria managed id (`:r5:`, `:R3:`)
  if (/[:]/.test(s)) return false;
  // double-underscore frameworks (Bootstrap Vue __BVID__, MUI __BVID__)
  if (/^__/.test(s)) return false;
  // known generated prefixes
  if (/^(react|aria|headlessui|rc|radix|react-aria|floating-ui)[-_:]/i.test(s)) return false;
  // hash-like suffix: ends in a long hex/base32 run (styled-components, Emotion)
  if (/-[a-f0-9]{6,}$/i.test(s) || /-[a-z0-9]{8,}$/i.test(s)) return false;
  // must contain at least one letter (reject pure numbers, uuids)
  if (!/[a-z]/i.test(s)) return false;
  return true;
}

/**
 * Is a class name generated/unstable? styled-components & Emotion emit hashed
 * classes like `css-1a2b3c`, `sc-jgyyrt`, `StyledButton-sc-1a2b3c`, `emotion-0`.
 * Tailwind/utility classes (`flex`, `px-4`, `text-red-500`) ARE stable and useful.
 * @param {string} cls
 * @returns {boolean} true if the class is a hashed/generated one to IGNORE
 */
export function isGeneratedClass(cls) {
  if (!cls || typeof cls !== 'string') return false;
  const c = cls.trim();
  // styled-components: sc-xxxxx, Styled*__sc-*
  if (/^sc-[a-z0-9]/i.test(c)) return true;
  if (/__sc-/i.test(c)) return true;
  // emotion / css-in-js: css-<hash>, emotion-<n>
  if (/^css-[a-z0-9]{4,}$/i.test(c)) return true;
  if (/^emotion-\d+$/i.test(c)) return true;
  // generic 6+ char hash-only segment as a class: `jss1234`, `_1a2b3c`
  if (/^_?[a-z0-9]{6,}$/i.test(c) && /[0-9]/.test(c) && !/^(_|fx|px|py|m|p|w|h|z|gap)-/.test(c)) return true;
  return false;
}

/**
 * Stable attribute names that are strong selectors (testing frameworks rely on
 * these precisely because they survive re-renders).
 */
export const STABLE_ATTRS = ['data-testid', 'data-test', 'data-cy', 'data-qa', 'aria-label', 'name', 'data-id'];

/**
 * Build a robust CSS selector from a DOM element, walking up at most 3 ancestors.
 * Preference order:
 *   1. a stable test/aria attribute on the element itself,
 *   2. a stable id on the element,
 *   3. tag + stable (non-generated) classes on the element, anchored by the
 *      nearest ancestor that has a stable id or landmark role.
 * @param {Element} el
 * @returns {string|null} null if nothing stable could be built
 */
export function buildRobustSelectorFromPath(el) {
  if (!el || !el.tagName) return null;
  const tag = el.tagName.toLowerCase();

  // 1. stable attribute on the element
  for (const attr of STABLE_ATTRS) {
    const v = el.getAttribute(attr);
    if (v) return `${tag}[${attr}=${cssEscape(v)}]`;
  }

  // 2. stable id on the element
  if (isStableId(el.id)) return `#${cssEscape(el.id)}`;

  // 3. tag + stable classes, anchored up to 3 ancestors
  const stableClasses = (el.getAttribute('class') || '')
    .split(/\s+/)
    .filter((c) => c && !isGeneratedClass(c))
    .slice(0, 3);
  let selfPart = tag;
  if (stableClasses.length) selfPart = `${tag}.${stableClasses.map((c) => cssEscape(c)).join('.')}`;

  // climb ancestors looking for an anchor (stable id, or a landmark/stable role)
  const parts = [selfPart];
  let cur = el.parentElement;
  let climbed = 0;
  while (cur && climbed < 3) {
    if (isStableId(cur.id)) {
      parts.unshift(`#${cssEscape(cur.id)}`);
      return parts.join(' > ');
    }
    const arole = cur.getAttribute('role');
    const landmark = cur.tagName.toLowerCase();
    const isLandmark =
      arole && ['navigation', 'main', 'banner', 'contentinfo', 'form', 'search', 'region'].includes(arole);
    const isSemanticLandmark = ['nav', 'main', 'header', 'footer', 'section', 'aside', 'form'].includes(landmark);
    if (isLandmark) {
      // landmark BY ROLE on a non-semantic tag: keep the role so the anchor
      // stays specific (e.g. `div[role=main]`, not a bare `div`).
      parts.unshift(`${landmark}[role=${cssEscape(arole)}]`);
      return parts.join(' > ');
    }
    if (isSemanticLandmark) {
      parts.unshift(landmark);
      return parts.join(' > ');
    }
    // also accept a stable attr on an ancestor
    let anchored = false;
    for (const attr of STABLE_ATTRS) {
      const v = cur.getAttribute(attr);
      if (v) {
        parts.unshift(`${landmark}[${attr}=${cssEscape(v)}]`);
        anchored = true;
        break;
      }
    }
    if (anchored) return parts.join(' > ');
    cur = cur.parentElement;
    climbed++;
  }
  // no anchor found — the selector is weak; only return it if it had stable classes
  return stableClasses.length ? parts.join(' > ') : null;
}

/** Minimal CSS.escape polyfill-safe helper (works in node tests without DOM). */
function cssEscape(value) {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(value);
  // simple escape: wrap in quotes if it contains special chars
  return String(value).replace(/["\\]/g, '\\$&');
}

// ---------------------------------------------------------------------------
// PAGE-side function. Self-contained — injected via chrome.scripting.executeScript.
// The heuristics above are duplicated here verbatim (page world can't import).
// Keep them in sync. Returns { robustSelector, text, role, tag, attrs }.
// ---------------------------------------------------------------------------

export const PAGE_FALLBACK_FN = function generateFallback(el) {
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
  };
};

/**
 * Page-side resolver (plan task 3). Given a fallback descriptor, find the
 * element again after a re-render. Tries robustSelector first, then a
 * text+role+tag scan. Self-contained for injection via chrome.scripting.
 * @param {object} fb - the fallback descriptor from PAGE_FALLBACK_FN
 * @returns {Element|null}
 */
export const PAGE_RESOLVE_FALLBACK_FN = function resolveFallback(fb) {
  if (!fb) return null;

  // 1. robust CSS selector (may be null if nothing stable was found)
  if (fb.robustSelector) {
    try {
      const el = document.querySelector(fb.robustSelector);
      if (el) return el;
    } catch { /* malformed selector — fall through */ }
  }

  // 2. text + role + tag scan. Walk visible elements, match on tag/role and
  //    innerText containment. This survives class/id churn entirely.
  if (fb.text) {
    const wantTag = fb.tag || null;
    const wantRole = fb.role || null;
    const textLow = fb.text.toLowerCase();
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
    let node;
    while ((node = walker.nextNode())) {
      if (wantTag && node.tagName !== wantTag) continue;
      const role = node.getAttribute('role');
      const effRole = role || node.tagName.toLowerCase();
      if (wantRole && effRole !== wantRole) continue;
      // skip invisible
      const s = getComputedStyle(node);
      if (s.display === 'none' || s.visibility === 'hidden' || parseFloat(s.opacity) === 0) continue;
      const r = node.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      const t = (node.innerText || node.textContent || '').split('\n')[0].trim().toLowerCase();
      const aria = (node.getAttribute('aria-label') || node.getAttribute('alt') || node.getAttribute('title') || '').trim().toLowerCase();
      if (t.includes(textLow) || aria.includes(textLow)) return node;
    }
  }
  return null;
};

