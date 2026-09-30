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
    const genFallback = (globalThis.__browserControllerFallbackRuntime || {}).generateFallback || null;
    const fallbacks = {};

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
    const words = String(_q).toLowerCase().split(/[^\p{L}\p{N}_-]+/u).filter((w) => w && !STOP.has(w));
    const roleHints = new Set();
    const content = [];
    for (const w of words) {
      if (ROLE_WORDS[w]) ROLE_WORDS[w].forEach((r) => roleHints.add(r));
      else content.push(w);
    }
    // "search" names the purpose AND a role.
    if (words.includes('search')) roleHints.add('searchbox');
    const phrase = content.join(' ');
    const wantRole = _role ? String(_role).toLowerCase() : null;

    const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'META', 'LINK', 'HEAD', 'HTML', 'BODY', 'BR', 'PATH']);
    const cands = [];
    for (const root of D.allRoots(true)) {
      let els = [];
      try { els = root.querySelectorAll('*'); } catch {}
      for (const el of els) {
        if (SKIP.has(el.tagName)) continue;
        const r = D.roleOf(el);
        if (r === 'none') continue;
        if (wantRole && r !== wantRole) continue;
        const name = D.nameOf(el).toLowerCase();
        const attrs = [el.id, D.attr(el, 'name'), D.attr(el, 'type'), D.attr(el, 'placeholder'), D.attr(el, 'data-testid'),
          D.attr(el, 'title'), typeof el.className === 'string' ? el.className : ''].join(' ').toLowerCase();
        const interactive = D.isInteractive(el);
        let score = 0;
        let covered = 0;
        for (const w of content) {
          const inName = name.includes(w);
          const inAttr = attrs.includes(w);
          if (inName) score += new RegExp(`(^|[^\\p{L}\\p{N}])${w.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&')}([^\\p{L}\\p{N}]|$)`, 'u').test(name) ? 6 : 4;
          else if (inAttr) score += 3;
          if (inName || inAttr) covered++;
        }
        if (content.length && covered === 0) continue;
        if (phrase && name === phrase) score += 12;
        else if (phrase && content.length > 1 && name.includes(phrase)) score += 6;
        if (roleHints.size) {
          if (roleHints.has(r) || (roleHints.has('searchbox') && /search/.test(attrs) && ['textbox', 'searchbox', 'combobox'].includes(r))) score += 8;
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
        cands.push({ el, r, name, score, interactive });
      }
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
      try { if (genFallback) fallbacks[ref] = genFallback(c.el); } catch {}
      const rect = D.centerOf(c.el).rect;
      matches.push({
        ref, role: c.r, name: D.nameOf(c.el).slice(0, 80), tag: c.el.tagName.toLowerCase(), score: c.score,
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
