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

  function computeNth(target, wantRole, wantText) {
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

    let seen = 0;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
    let node;
    while ((node = walker.nextNode())) {
      if (node === target) return seen;
      const nodeRole = node.getAttribute('role') || node.tagName.toLowerCase();
      if (nodeRole !== wantRole) continue;
      const style = getComputedStyle(node);
      if (style.display === 'none' || style.visibility === 'hidden' || parseFloat(style.opacity) === 0) continue;
      const rect = node.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      const nodeText = (node.innerText || node.textContent || '').split('\n')[0].trim();
      const accessibleName = (
        node.getAttribute('aria-label') || node.getAttribute('alt') || node.getAttribute('title') || ''
      ).trim();
      if (isTextMatch(nodeText) || isTextMatch(accessibleName)) seen++;
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
    nth: computeNth(el, role, text),
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

  // 2. text + role + tag scan. Collect ALL visible matches, then pick the nth
  //    one (default 0 = first). Without nth, several elements sharing text+role
  //    (e.g. 3 "Like" buttons) would resolve to the wrong one. Borrowed from
  //    BrowserOS's nth-recovery idea.
  if (fb.text) {
    const wantTag = fb.tag || null;
    const wantRole = fb.role || null;
    const textLow = fb.text.trim().toLowerCase();
    const wantNth = typeof fb.nth === 'number' ? fb.nth : 0;
    // Fix #3 (precise nth match): the old `includes()` matched too loosely —
    // "Save" matched "Saved", "Like" matched "Liked", picking the WRONG element
    // among duplicates. Now accept exact OR near-exact (wanted + NON-LETTER
    // suffix only — "Login »" yes, "Saved"/"Liked" no, since letter suffixes
    // like past-tense are indistinguishable and would match an already-pressed
    // "Liked" button when searching "Like"). Falls back to includes() if no
    // precise match exists (second pass). Mirrors isPreciseTextMatch (pure export).
    const isTextMatch = (candidate) => {
      const c = candidate.trim().toLowerCase();
      if (c === textLow) return true;
      if (textLow.length > 2 && c.length > textLow.length && c.startsWith(textLow)) {
        const suffix = c.slice(textLow.length);
        if (!/[a-zà-ÿ]/i.test(suffix)) return true;
      }
      return false;
    };
    const matches = [];
    const looseMatches = []; // second-pass fallback bucket
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
      const hit = isTextMatch(t) || isTextMatch(aria);
      if (hit) {
        matches.push(node);
        if (matches.length > wantNth) break; // got the nth precise match, stop early
      } else if (t.includes(textLow) || aria.includes(textLow)) {
        // remember loose matches in case no precise match is found at all
        looseMatches.push(node);
      }
    }
    if (matches.length > wantNth) return matches[wantNth];
    if (matches.length > 0) return matches[0]; // precise but nth exceeded
    // no precise match — fall back to the old loose behavior (better a likely
    // match than a hard failure), respecting nth within the loose bucket too.
    if (looseMatches.length > wantNth) return looseMatches[wantNth];
    if (looseMatches.length > 0) return looseMatches[0];
  }
  return null;
};

// ---------------------------------------------------------------------------
// Pure, DOM-free helpers exported ONLY for unit testing. These mirror the
// nth-selection + isNew logic embedded in the page functions above (which must
// stay self-contained for chrome.scripting injection). Keep them in sync.
// ---------------------------------------------------------------------------

/**
 * Pick the nth match from a list, with a best-effort fallback. Mirrors the
 * `matches[wantNth]` logic in PAGE_RESOLVE_FALLBACK_FN. Pure — no DOM.
 * @param {unknown[]} matches - ordered candidate elements (or any items)
 * @param {number} nth - zero-based ordinal to pick
 * @returns {unknown|null} the nth match, or the first if nth is out of range, or null
 */
export function pickNthMatch(matches, nth) {
  if (!Array.isArray(matches) || matches.length === 0) return null;
  const want = typeof nth === 'number' && nth >= 0 ? nth : 0;
  if (matches.length > want) return matches[want];
  return matches[0]; // best effort: nth exceeded (DOM shrank since snapshot)
}

/**
 * Precise text-match predicate used by the smart-selector fallback (Fix #3).
 * Accepts exact match OR near-exact (candidate starts with wanted text AND
 * length delta ≤ 2, covering "Save"/"Saved", "Login"/"Login »"). Rejects
 * loose supersets like "Like"/"Liked" (3-char delta) that the old includes()
 * wrongly matched, picking the WRONG element among duplicates.
 *
 * Pure — no DOM. Exported so the rule is unit-testable; the injected page
 * functions (PAGE_RESOLVE_FALLBACK_FN, computeNth) inline the SAME logic.
 * Keep them in sync (the test asserts this predicate's behavior).
 * @param {string} candidate - the element's text/aria, any case
 * @param {string} wanted - the text we're looking for, any case
 * @returns {boolean}
 */
export function isPreciseTextMatch(candidate, wanted) {
  const c = String(candidate || '').trim().toLowerCase();
  const w = String(wanted || '').trim().toLowerCase();
  if (!w) return false;
  if (c === w) return true; // exact
  // near-exact: candidate = wanted + a NON-LETTER suffix (punctuation, spaces,
  // symbols like " »", trailing "..."). We deliberately do NOT match letter
  // suffixes: "Save"→"Saved" and "Like"→"Liked" are indistinguishable as
  // strings (both +1 past-tense), so matching one means matching the other —
  // which would pick an already-pressed "Liked" button when searching "Like".
  // Rejecting letter suffixes is the only consistent rule. (Fix #3)
  if (w.length > 2 && c.length > w.length && c.startsWith(w)) {
    const suffix = c.slice(w.length);
    if (!/[a-zà-ÿ]/i.test(suffix)) return true; // suffix is non-letter (symbol/space/punct)
  }
  return false;
}

/**
 * Compute the set of "new" fingerprints present in `current` but not `previous`.
 * Mirrors the isNew logic in handleSnapshot (fingerprint = `${role}|${name}`).
 * Pure — no DOM. Used to test that the diff is correct.
 * @param {string[]} previous - fingerprints from the prior snapshot
 * @param {string[]} current - fingerprints from this snapshot
 * @returns {Set<string>} the fingerprints that are new (not in previous)
 */
export function computeNewFingerprints(previous, current) {
  const prevSet = new Set(previous || []);
  const isNew = new Set();
  for (const fp of current || []) {
    if (!prevSet.has(fp)) isNew.add(fp);
  }
  return isNew;
}


