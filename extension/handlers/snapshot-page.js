/**
 * Page side of browser_snapshot. Self-contained: chrome.scripting serializes this function,
 * so helpers live inside it. Two passes: the printable tree (items), then the lines in page
 * order up to the budget. Refs are issued only for the lines that are printed.
 */
export function snapshotPage(_target, _fb, _query, _max, _delta) {
  const D = globalThis.__bcDom;
  if (!D || !D.labelsOf || !D.refFor || !D.peekRef || !D.resolveTarget || !D.pruneRegistry || !D.snapshotNameOf || !D.isSnapshotLandmark) return { __needDom: true };
  const genFallback = (globalThis.__browserControllerFallbackRuntime || {}).generateFallback || null;
  const url = location.href;
  const title = document.title || '';
  let root = document.body || null;
  let rebound = null;
  if (_target) {
    const r = D.resolveTarget(_target, _fb);
    if (r.error) return { success: false, error: r.error, ref: r.ref, issued: r.issued, earlier: r.earlier };
    root = r.el || null;
    if (r.via === 'fallback') rebound = _target.ref;
    if (!root) return { success: false, error: 'NOT_FOUND: no element at that point' };
    if (!D.isVisible(root)) return { success: false, error: `ELEMENT_HIDDEN: ${D.describe(root)} is not displayed; nothing to snapshot` };
  }
  if (!root) return { success: false, error: 'NOT_FOUND: the page has no body' };
  D.pruneRegistry();

  // A document identity includes same-origin frame documents, so a frame reload
  // resets a baseline even if the replacement renders identical text.
  let epoch = null;
  let epochState = null;
  const documentIds = [];
  if (_delta && globalThis.crypto?.getRandomValues) {
    epochState = globalThis.__bcSnapshotEpoch;
    if (!epochState || epochState.document !== document) {
      const random = new Uint32Array(4);
      globalThis.crypto.getRandomValues(random);
      epochState = { document, id: Array.from(random), docs: new WeakMap(), next: 0 };
      globalThis.__bcSnapshotEpoch = epochState;
    }
  }
  const recordDocument = (doc) => {
    if (!epochState || !doc) return;
    let id = epochState.docs.get(doc);
    if (!id) { id = ++epochState.next; epochState.docs.set(doc, id); }
    documentIds.push(id);
  };
  recordDocument(root.ownerDocument || document);

  const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'PATH', 'BR', 'HR', 'WBR', 'META', 'LINK', 'HEAD']);
  // Structural containers: an explicit label only, and their children keep their own text lines. `article`
  // is included by the shared page-DOM snapshot-name helper so it prints as an unnamed line by default.
  const BUTTON_TYPES = ['button', 'submit', 'reset', 'image'];
  const isCheckable = (el) => el.tagName === 'INPUT' && ['checkbox', 'radio'].includes(String(el.type || '').toLowerCase());
  const kidsOf = (el) => D.flatChildren(el).filter((c) => c.nodeType === 1);

  /** Name for the line, shared with role/name target matching. */
  function nameOf(el, r) {
    return D.snapshotNameOf(el, r);
  }

  /** A native checkbox/radio drawn over by its visible label is the control a person clicks. */
  function labelledCheckable(el) {
    if (!isCheckable(el)) return false;
    if (!D.isVisible(el, { ignoreOpacity: true })) return false;
    return D.labelsOf(el).some((label) => D.isVisible(label));
  }

  /** 'show' = a line of its own, 'pass' = no box of its own (children still count), false = hidden subtree. */
  function vis(el) {
    if (D.isExtensionNode(el)) return false;
    if (D.attr(el, 'aria-hidden') === 'true' || el.inert === true || (el.hasAttribute && el.hasAttribute('inert'))) return false;
    const s = D.styleOf(el);
    if (!s || s.display === 'none') return false;
    if (parseFloat(s.opacity) === 0 && !labelledCheckable(el)) return false;
    if (s.display === 'contents' || el.tagName === 'SLOT') return 'pass';
    if (s.visibility === 'hidden' || s.visibility === 'collapse') return 'pass';
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) return 'show';
    return el.childElementCount > 0 || D.shadowOf(el) ? 'pass' : false;
  }

  /** A same-origin frame is walked; one whose document cannot be read is named, not dropped. */
  function crossOriginOf(el) {
    if (el.tagName !== 'IFRAME' && el.tagName !== 'FRAME') return null;
    if (D.frameDoc(el)) return null;
    let origin = '';
    try { origin = new URL(D.attr(el, 'src') || '', location.href).origin; } catch { /* no usable src */ }
    return origin && origin !== 'null' ? `cross-origin ${origin}` : 'cross-origin';
  }

  const valueOf = (el) => {
    const type = String(el.type || '').toLowerCase();
    if (D.isSensitiveField?.(el)) return el.value ? '••••' : undefined;
    if (el.tagName === 'INPUT' && (isCheckable(el) || BUTTON_TYPES.includes(type))) return undefined;
    if (el.value !== undefined && el.value !== '' && typeof el.value !== 'object') return String(el.value).slice(0, 200);
    return undefined;
  };

  /** Flags that apply, in the order the line prints them. */
  function flagsOf(el) {
    const out = [];
    const aria = (n) => D.attr(el, n);
    const checked = isCheckable(el) ? !!el.checked : aria('aria-checked') === 'true';
    if (checked) out.push('checked');
    else if (aria('aria-checked') === 'mixed') out.push('checked=mixed');
    if (el.disabled || aria('aria-disabled') === 'true') out.push('disabled');
    if (aria('aria-expanded') === 'true') out.push('expanded');
    else if (aria('aria-expanded') === 'false') out.push('collapsed');
    if (aria('aria-selected') === 'true') out.push('selected');
    const h = /^H([1-6])$/.exec(el.tagName || '');
    if (h) out.push(`level=${h[1]}`);
    else if (aria('aria-level')) out.push(`level=${aria('aria-level')}`);
    if (el.required || aria('aria-required') === 'true') out.push('required');
    return out;
  }

  // Pass 1: the printable tree. An item per printed node; wrappers print nothing and
  // their children take their place. `inText`: inside a node whose name already says it.
  const items = [];
  const visit = (el, depth, parent, inText, forced) => {
    if (!el || el.nodeType !== 1 || SKIP.has(el.tagName)) return;
    const v = forced ? 'show' : vis(el);
    if (!v) return;
    if (el.tagName === 'IFRAME' || el.tagName === 'FRAME') recordDocument(D.frameDoc(el));
    if (v === 'pass') {
      for (const c of kidsOf(el)) visit(c, depth, parent, inText, false);
      return;
    }
    const xo = crossOriginOf(el);
    if (xo) {
      items.push({ el, role: 'iframe', name: xo, depth, parent, ia: false, xo: true });
      return;
    }
    const r = D.roleOf(el);
    if (r === 'none') return;
    const ia = D.isInteractive(el);
    const name = nameOf(el, r);
    const printed = forced || ia || r !== 'generic' || (name !== '' && !inText);
    let childDepth = depth;
    let childParent = parent;
    let childText = inText;
    if (printed) {
      items.push({ el, role: r, name, depth, parent, ia, xo: false });
      childDepth = depth + 1;
      childParent = items.length - 1;
      childText = inText || (r !== 'generic' && !D.isSnapshotLandmark(r));
    }
    for (const c of kidsOf(el)) visit(c, childDepth, childParent, childText, false);
  };
  visit(root, 0, -1, false, !!_target);

  // Look-alike controls (same role and name) get their table row's text as context.
  const twins = new Map();
  for (const it of items) {
    if (!it.ia || it.xo) continue;
    const key = `${it.role}|${it.name}`;
    twins.set(key, (twins.get(key) || 0) + 1);
  }

  // A query keeps the elements that hold EVERY word of it (in their role, name or value): the
  // whole-word matches or, when there are none, the substring matches. Each keeps its ancestors.
  let keep = null;
  if (_query) {
    const words = String(_query).toLowerCase().split(/\s+/).filter(Boolean);
    const wholes = words.map((w) => new RegExp(`(?<![\\p{L}\\p{N}])${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}])`, 'iu'));
    const wholeHits = [];
    const partHits = [];
    items.forEach((it, i) => {
      const hay = `${it.role}\n${it.name}\n${valueOf(it.el) || ''}`;
      if (wholes.every((re) => re.test(hay))) {
        wholeHits.push(i);
        return;
      }
      const low = hay.toLowerCase();
      if (words.every((w) => low.includes(w))) partHits.push(i);
    });
    keep = new Set();
    for (const i of wholeHits.length ? wholeHits : partHits) {
      for (let j = i; j >= 0 && !keep.has(j); j = items[j].parent) keep.add(j);
    }
  }
  const indexes = items.map((_, i) => i).filter((i) => !keep || keep.has(i));

  const lineOf = (it, ref, ctx) => {
    const pad = '  '.repeat(it.depth);
    if (it.xo) return `${pad}${it.role} ${JSON.stringify(it.name)} (not readable)`;
    let s = it.role + (it.name ? ` ${JSON.stringify(it.name)}` : '') + ` [${ref}]`;
    const v = valueOf(it.el);
    if (v !== undefined) s += ` value=${JSON.stringify(v)}`;
    for (const f of flagsOf(it.el)) s += ` ${f}`;
    if (ctx) s += ` context=${JSON.stringify(ctx)}`;
    return pad + s;
  };

  // Pass 2: lines in page order until the budget; a line that does not fit stops the cut.
  const header = `page: ${title || '(untitled)'} — ${url}`;
  const out = [header];
  let size = header.length;
  let truncated = false;
  let more = 0;
  const refs = [];
  const fallbacks = {};
  const pass = {};
  for (const i of indexes) {
    const it = items[i];
    const ctx = !truncated && it.ia && !it.xo && (twins.get(`${it.role}|${it.name}`) || 0) > 1 ? D.rowContextOf(it.el) : '';
    const ref = it.xo ? null : D.peekRef(it.el);
    const line = lineOf(it, ref, ctx);
    if (!truncated && size + line.length + 1 <= _max) {
      const issued = it.xo ? null : D.refFor(it.el);
      out.push(it.xo ? line : lineOf(it, issued, ctx));
      size += line.length + 1;
      if (!it.xo) {
        refs.push({ ref: issued, role: it.role, name: it.name.slice(0, 60) });
        try { if (genFallback) fallbacks[issued] = genFallback(it.el, pass); } catch { /* no descriptor: the ref still works while the element lives */ }
      }
    } else {
      truncated = true;
      more += line.length + 1;
    }
  }
  if (truncated) out.push(`… truncated (${more} more chars): narrow with query or target`);
  else if (keep && indexes.length === 0) out.push(`(no element matches ${JSON.stringify(_query)})`);
  const output = out.join('\n');
  const safeOutput = D.redactSensitiveText ? D.redactSensitiveText(output, root) : output;
  if (epochState) epoch = [...epochState.id, ...documentIds];
  return { success: true, url, title, text: safeOutput, truncated, refs, __fallbacks: fallbacks, rebound, __snapshotEpoch: epoch };
}

