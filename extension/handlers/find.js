/**
 * browser_find: natural-language element search (tokenized, role-aware,
 * shadow DOM + same-origin iframes, wrapper/echo suppression). Refs go into
 * the shared page registry so every ref tool can use them.
 */
import { safeExec, execDom, resolveTab } from '../lib/page-exec.js';
import { fallbackByTab, persistSessionState, nextRefPrefix } from '../lib/state.js';
import { PAGE_FALLBACK_INSTALL } from '../utils/smart-selector.js';

export async function handleFind(params) {
  const { tabId, query, limit = 10, role } = params;
  await resolveTab(tabId);
  await safeExec(tabId, PAGE_FALLBACK_INSTALL, []);
  const refPrefix = nextRefPrefix('f');

  return execDom(tabId, (_q, _lim, _refPrefix, _role) => {
    const D = globalThis.__bcDom;
    if (!D) return { __needDom: true };
    D.beginRefGeneration?.(_refPrefix);
    const genFallback = (globalThis.__browserControllerFallbackRuntime || {}).generateFallback || null;
    const fallbacks = {};
    const fallbackPass = {};

    // Words that describe the KIND of element, mapped to the roles they mean.
    const ROLE_WORDS = {
      button: ['button'], btn: ['button'], link: ['link'], anchor: ['link'],
      input: ['textbox', 'searchbox', 'combobox', 'spinbutton'], field: ['textbox', 'searchbox', 'combobox', 'spinbutton'],
      textbox: ['textbox', 'searchbox'], box: ['textbox', 'searchbox', 'combobox', 'checkbox'], textarea: ['textbox'],
      searchbox: ['searchbox'], checkbox: ['checkbox'], check: ['checkbox'], radio: ['radio'],
      dropdown: ['combobox', 'listbox', 'button'], select: ['combobox', 'listbox'], combobox: ['combobox'],
      tab: ['tab'], menu: ['menu', 'menubar', 'button'], menuitem: ['menuitem'], option: ['option'],
      heading: ['heading'], title: ['heading'], image: ['img'], img: ['img'], icon: ['img', 'button'],
      dialog: ['dialog', 'alertdialog'], modal: ['dialog', 'alertdialog'], switch: ['switch'], toggle: ['switch', 'button', 'checkbox'],
      slider: ['slider'], list: ['list', 'listbox'], table: ['table', 'grid'], row: ['row'], cell: ['cell', 'gridcell'],
    };
    const STOP = new Set(['the', 'a', 'an', 'to', 'of', 'for', 'on', 'in', 'with', 'and', 'that', 'this', 'element', 'please']);
    const query = String(_q);
    // Words are letters, digits, "_" and "-" ("e-mail" stays one word). Nothing
    // here is a regex: any query text is just text.
    const words = query.toLowerCase().split(/[^\p{L}\p{N}_-]+/u).filter((w) => w && !STOP.has(w));
    const roleHints = new Set();
    const content = [];
    for (const w of words) {
      // hasOwnProperty: "constructor" or "toString" must not hit Object.prototype.
      if (Object.prototype.hasOwnProperty.call(ROLE_WORDS, w)) ROLE_WORDS[w].forEach((r) => roleHints.add(r));
      else content.push(w);
    }
    // A query of symbols only ("[beta]", "🚀") has no words: match it as one phrase.
    if (!words.length && query.trim()) content.push(query.trim().toLowerCase());
    // "search" names the purpose AND a role.
    if (words.includes('search')) roleHints.add('searchbox');
    const phrase = content.join(' ');
    const wantRole = _role ? String(_role).toLowerCase() : null;

    const isWordChar = (ch) => !!ch && /[\p{L}\p{N}]/u.test(ch);
    /**
     * Whole-word hit: `w` occurs in `text` with no letter or digit on either side.
     * Plain indexOf, so a hyphen or bracket in the query needs no escaping.
     */
    const wholeWord = (text, w) => {
      if (!w) return false;
      for (let i = text.indexOf(w); i !== -1; i = text.indexOf(w, i + 1)) {
        if (!isWordChar(text[i - 1]) && !isWordChar(text[i + w.length])) return true;
      }
      return false;
    };

    const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'META', 'LINK', 'HEAD', 'HTML', 'BODY', 'BR', 'PATH']);
    // Phase 1: which query words each element matches, and how. Ranking rule: a
    // whole-word hit ("cart" in "Cart") always beats a word found only inside a
    // longer one ("cart" in "Scarter"). Inside-a-longer-word hits count only for a
    // word that has no whole-word hit anywhere on the page.
    const rows = [];
    for (const root of D.allRoots(true)) {
      let els = [];
      try { els = root.querySelectorAll('*'); } catch {}
      for (const el of els) {
        if (SKIP.has(el.tagName) || D.isExtensionNode?.(el)) continue;
        const r = D.roleOf(el);
        if (r === 'none') continue;
        if (wantRole && r !== wantRole) continue;
        const name = D.nameOf(el).toLowerCase();
        const attrs = [el.id, D.attr(el, 'name'), D.attr(el, 'type'), D.attr(el, 'placeholder'), D.attr(el, 'data-testid'),
          D.attr(el, 'title'), typeof el.className === 'string' ? el.className : ''].join(' ').toLowerCase();
        const hits = content.map((w) => ({
          nameWord: wholeWord(name, w), attrWord: wholeWord(attrs, w),
          nameAny: name.includes(w), attrAny: attrs.includes(w),
        }));
        if (content.length && !hits.some((h) => h.nameAny || h.attrAny)) continue;
        rows.push({ el, r, name, attrs, interactive: D.isInteractive(el), hits });
      }
    }
    const wordHasWholeHit = content.map((_, i) => rows.some((row) => row.hits[i].nameWord || row.hits[i].attrWord));

    // Phase 2: score the rows that match at least one word.
    const cands = [];
    for (const row of rows) {
      const { el, r, name, interactive } = row;
      let score = 0;
      let covered = 0;
      const missing = [];
      content.forEach((w, i) => {
        const h = row.hits[i];
        if (h.nameWord) { score += 6; covered++; }
        else if (h.attrWord) { score += 3; covered++; }
        else if (!wordHasWholeHit[i] && h.nameAny) { score += 2; covered++; }
        else if (!wordHasWholeHit[i] && h.attrAny) { score += 1; covered++; }
        else missing.push(w);
      });
      if (content.length && covered === 0) continue;
      // "Edit carton": the name says Edit, the table row says which one. Only a
      // control the name already matched may borrow words from its row.
      let context = '';
      if (missing.length && interactive) {
        context = D.rowContextOf(el);
        for (const w of missing) if (wholeWord(context.toLowerCase(), w)) { score += 3; covered++; }
      }
      if (phrase && name === phrase) score += 12;
      else if (phrase && content.length > 1 && wholeWord(name, phrase)) score += 6;
      if (roleHints.size) {
        if (roleHints.has(r) || (roleHints.has('searchbox') && /search/.test(row.attrs) && ['textbox', 'searchbox', 'combobox'].includes(r))) score += 8;
        else if (!content.length) continue;
        else score -= 2;
      }
      if (interactive) score += 4;
      else if (r === 'generic') score -= 3;
      // A container whose text merely CONTAINS the words is a weak match.
      if (name.length > 120) score -= 4;
      const coverage = content.length ? covered / content.length : 1;
      if (coverage < 0.5) continue;
      score = Math.round(score * coverage * 10) / 10;
      if (score <= 0) continue;
      cands.push({ el, r, name, score, interactive, context });
    }
    cands.sort((a, b) => b.score - a.score);
    // Visibility is the expensive check: only for the best-scoring pool.
    const pool = [];
    for (const c of cands) {
      if (pool.length >= _lim * 6) break;
      if (D.isVisible(c.el)) pool.push(c);
    }
    // Drop wrappers (an ancestor scoring no better than a descendant) and echoes
    // (a descendant repeating the name of the control that contains it).
    const kept = pool.filter((c) => !pool.some((o) => o !== c && (
      (o.score >= c.score && D.composedContains(c.el, o.el))
      || (o.interactive && !c.interactive && o.score >= c.score && o.name === c.name && D.composedContains(o.el, c.el)))));

    const matches = [];
    kept.slice(0, _lim).forEach((c, i) => {
      const ref = `${_refPrefix}${i}`;
      D.registry.set(ref, c.el);
      try { if (genFallback) fallbacks[ref] = genFallback(c.el, fallbackPass); } catch {}
      const rect = D.centerOf(c.el).rect;
      matches.push({
        ref, role: c.r, name: D.nameOf(c.el).slice(0, 80), tag: c.el.tagName.toLowerCase(), score: c.score,
        ...(c.context ? { context: c.context } : {}),
        bounds: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
      });
    });
    return {
      success: true, query: _q, matches,
      ...(matches.length === 0 ? { hint: 'No match. Try fewer/other words, a role filter, browser_snapshot, or browser_text.' } : {}),
      __fallbacks: fallbacks,
    };
  }, [query, limit, refPrefix, role || null]).then((res) => {
    if (res && res.__fallbacks) {
      const map = fallbackByTab.get(tabId) || new Map();
      for (const [ref, fbEntry] of Object.entries(res.__fallbacks)) map.set(ref, fbEntry);
      fallbackByTab.set(tabId, map);
      delete res.__fallbacks;
      persistSessionState();
    }
    return res;
  });
}
