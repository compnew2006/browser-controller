/**
 * browser_inspect_element, pure parts: the page-side read (computed styles and the
 * element's structural path; serialized into the page, so self-contained), the
 * shaping of CDP CSS.getMatchedStylesForNode / DOMDebugger.getEventListeners
 * results, and the lines the agent reads.
 *
 * Cascade (as DevTools shows it): matched rules come lowest priority first,
 * user-agent ones included, then the inline style. A declaration is
 * overridden when every longhand it sets is won by another entry: a later
 * one, or an !important one anywhere.
 */

const MAX_RULES = 40;
const MAX_INHERITED = 20;
const MAX_PSEUDO = 10;
const MAX_LISTENERS = 30;
const MAX_RULE_CHARS = 600;
const MAX_VALUE_CHARS = 200;
const MAX_ALL_PROPERTIES = 120;

// Properties an element inherits from its ancestors (custom properties too, but
// they are left out: design systems set hundreds on :root and computed values
// already resolve var()).
const INHERITED = /^(color|cursor|direction|visibility|white-space|word-spacing|letter-spacing|line-height|quotes|writing-mode|hyphens|word-break|overflow-wrap|tab-size|caret-color|accent-color|text-(align|align-last|indent|transform|shadow|rendering|justify|decoration-color|underline-position|wrap)|font(-.+)?|list-style(-.+)?|-webkit-text-fill-color|-webkit-text-stroke(-.+)?)$/;

/**
 * Computed styles the default view returns, each with the value it has when
 * nothing sets it (omitted then, to save tokens); null = always shown.
 */
export const KEY_STYLES = [
  ['display', null], ['position', 'static'], ['top', 'auto'], ['right', 'auto'], ['bottom', 'auto'], ['left', 'auto'],
  ['z-index', 'auto'], ['width', null], ['height', null], ['min-width', ['auto', '0px']], ['max-width', 'none'],
  ['min-height', ['auto', '0px']], ['max-height', 'none'], ['box-sizing', 'content-box'], ['margin', '0px'], ['padding', '0px'],
  ['border-width', '0px'], ['border-style', 'none'], ['border-radius', '0px'], ['overflow', 'visible'], ['opacity', '1'],
  ['visibility', 'visible'], ['pointer-events', 'auto'], ['cursor', 'auto'], ['color', null], ['background-color', 'rgba(0, 0, 0, 0)'],
  ['background-image', 'none'], ['font-family', null], ['font-size', null], ['font-weight', '400'], ['line-height', 'normal'],
  ['text-align', 'start'], ['white-space', 'normal'], ['flex-direction', 'row'], ['flex-wrap', 'nowrap'], ['justify-content', 'normal'],
  ['align-items', 'normal'], ['gap', 'normal'], ['flex', '0 1 auto'], ['align-self', 'auto'], ['grid-template-columns', 'none'],
  ['grid-template-rows', 'none'], ['transform', 'none'], ['transition', 'all'], ['animation-name', 'none'], ['outline-style', 'none'],
];

/**
 * Page side (isolated world, via execDom; self-contained — it is serialized). The
 * element `t` (a parseTarget object) resolves to (lib/page-dom.js resolveTarget), its
 * box, its computed styles and its structural path. `properties` picks the styles
 * (["*"] = all); without it, KEY_STYLES that differ from their default. A CSS
 * selector that names only hidden elements is still inspected: "why is it hidden"
 * is a question too.
 */
export function pageInspect(t, fb, properties, keyStyles) {
  const D = globalThis.__bcDom;
  if (!D || !D.resolveTarget) return { __needDom: true };
  const hit = D.resolveTarget(t, fb);
  let el = hit.el || null;
  if (hit.error) {
    // A ref miss carries what the page knows of it (issued in this tab or not): the handler words it.
    if (!(t.kind === 'selector' && /^ELEMENT_HIDDEN\b/.test(hit.error))) return { error: hit.error, ref: hit.ref, issued: hit.issued, earlier: hit.earlier };
    el = D.queryAll(t.selector, true)?.[0] || null;
  }
  if (!el || el.nodeType !== 1) {
    return { error: t.kind === 'ref' ? 'REF_GONE' : `NOT_FOUND: nothing at ${t.kind === 'point' ? `${t.x},${t.y}` : 'the target'}` };
  }
  const cs = getComputedStyle(el);
  const styles = {};
  if (properties && properties.length) {
    const names = properties.includes('*') ? Array.from(cs) : properties;
    for (const name of names) styles[name] = cs.getPropertyValue(name);
  } else {
    for (const [name, initial] of keyStyles) {
      const value = cs.getPropertyValue(name);
      if (value === '' || (initial !== null && (Array.isArray(initial) ? initial.includes(value) : value === initial))) continue;
      styles[name] = value;
    }
  }
  // Structural path (the grammar nodesAtPath reads): child indexes; -1 and an index
  // into a shadow root; -2 into a frame. null when the element is detached.
  let path = null;
  let node = el;
  const steps = [];
  for (let guard = 0; guard < 400 && node && !path; guard++) {
    if (node.nodeType === 9) {
      let frame = null;
      try { frame = node.defaultView && node.defaultView.frameElement; } catch { /* cross-origin: no frame element to climb to */ }
      if (!frame) { path = { path: steps, tag: el.tagName }; break; }
      steps.unshift(-2);
      node = frame;
      continue;
    }
    const parent = node.parentNode;
    if (!parent) break;
    const index = Array.prototype.indexOf.call(parent.children, node);
    if (index < 0) break;
    if (parent.nodeType === 11) {
      if (!parent.host) break;
      steps.unshift(-1, index);
      node = parent.host;
    } else {
      steps.unshift(index);
      node = parent;
    }
  }
  const r = el.getBoundingClientRect();
  const rawText = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
  const safeText = D.redactSensitiveText ? D.redactSensitiveText(rawText, el) : rawText;
  const text = safeText.slice(0, 80);
  return {
    rebound: hit.via === 'fallback' ? t.ref : null,
    element: {
      tag: el.tagName.toLowerCase(),
      ...(el.id ? { id: el.id } : {}),
      ...(el.classList.length ? { classes: Array.from(el.classList) } : {}),
      ...(text ? { text } : {}),
      box: { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) },
    },
    styles,
    path,
  };
}

/** "button#go.btn.primary" from a CDP DOM.Node. */
export function describeNode(node) {
  const attrs = node.attributes || []; // [name, value, name, value, …]
  const get = (name) => { for (let i = 0; i < attrs.length; i += 2) if (attrs[i] === name) return attrs[i + 1] || ''; return ''; };
  const id = get('id');
  const classes = get('class').split(/\s+/).filter(Boolean);
  return `${String(node.nodeName).toLowerCase()}${id ? `#${id}` : ''}${classes.map((c) => `.${c}`).join('')}`;
}

const hasAuthorShadow = (node) => (node.shadowRoots || []).some((r) => r.shadowRootType !== 'user-agent');

/**
 * Follow a structural path (pageInspect's `path`) in a DOM.getDocument pierce
 * dump: the target node and its ancestor elements within its own document, nearest
 * first. `flatTreeDiffers` when a shadow tree is on the way (entered, or a host's
 * light children slotted elsewhere): CSS inheritance then follows the flat tree, so
 * these ancestors are not the ones it lists. null when the path no longer leads to `tag`.
 */
export function nodesAtPath(root, path, tag) {
  let cur = root;
  let chain = [];
  let flatTreeDiffers = false;
  for (const step of path) {
    if (!cur) return null;
    if (step === -1) {
      cur = (cur.shadowRoots || []).find((r) => r.shadowRootType !== 'user-agent') || null;
      flatTreeDiffers = true;
    } else if (step === -2) {
      cur = cur.contentDocument || null;
      chain = []; // a frame's elements inherit nothing from the embedding page
      flatTreeDiffers = false;
    } else {
      if (hasAuthorShadow(cur)) flatTreeDiffers = true;
      cur = (cur.children || []).filter((c) => c.nodeType === 1)[step] || null;
      if (cur) chain.push(cur);
    }
  }
  if (!cur || cur.nodeType !== 1) return null;
  if (tag && String(cur.nodeName).toUpperCase() !== String(tag).toUpperCase()) return null;
  return { target: cur, ancestors: chain.slice(0, -1).reverse(), flatTreeDiffers };
}

function cap(text, max) {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function sourceOf(rule, sheets) {
  const sheet = sheets.get(rule.styleSheetId);
  if (!sheet?.url) return undefined;
  const range = rule.style?.range;
  return range ? `${sheet.url}:${(sheet.startLine || 0) + range.startLine + 1}` : sheet.url;
}

/** Declarations written in the source (implicit longhand expansions have no range). */
const declared = (style) => (style?.cssProperties || []).filter((p) => p.range && !p.disabled);
/** Longhands the entry sets, declared or expanded from a shorthand. */
const longhands = (style) => (style?.cssProperties || []).filter((p) => !p.longhandProperties && !p.disabled && p.parsedOk !== false);
const longhandsOf = (p) => (p.longhandProperties ? p.longhandProperties.map((l) => l.name) : [p.name]);

/** Ascending-priority entries of one element: matched rules, then its inline style. */
function entriesOf(matchedRules, inlineStyle) {
  const entries = (matchedRules || []).map(({ rule, matchingSelectors }) => ({ rule, style: rule.style, matchingSelectors }));
  if (declared(inlineStyle).length) entries.push({ inline: true, style: inlineStyle });
  return entries;
}

/** Longhand name -> index of the entry that wins it. */
function cascadeWinners(entries) {
  const winners = new Map();
  entries.forEach((entry, i) => {
    for (const p of longhands(entry.style)) {
      const cur = winners.get(p.name);
      if (!cur || !cur.important || p.important) winners.set(p.name, { i, important: !!p.important });
    }
  });
  return winners;
}

/** One entry in the agent's view; `keep` filters its declarations, `lost` marks overridden ones. */
function view(entry, sheets, keep, lost) {
  const props = declared(entry.style).filter(keep);
  if (!props.length) return null;
  const selectors = entry.inline ? null : entry.rule.selectorList.selectors;
  const out = {
    selector: entry.inline ? 'element.style' : (entry.matchingSelectors || []).map((i) => selectors[i]?.text).filter(Boolean).join(', ') || entry.rule.selectorList.text,
  };
  const source = entry.inline ? undefined : sourceOf(entry.rule, sheets);
  if (source) out.source = source;
  if (entry.rule?.media?.length) out.media = entry.rule.media.map((m) => m.text).join(' and ');
  out.decls = props.map((p) => ({
    name: p.name,
    value: cap(String(p.value ?? ''), MAX_VALUE_CHARS),
    ...(p.important ? { important: true } : {}),
    ...(p.parsedOk === false ? { invalid: true } : (lost(p) ? { overridden: true } : {})),
  }));
  return out;
}

const isAuthor = (entry) => entry.inline || entry.rule.origin === 'regular';

/**
 * `matched` is a CSS.getMatchedStylesForNode result; `sheets` maps styleSheetId
 * to { url, startLine }; `ancestors[k]` labels matched.inherited[k] (null: unknown).
 * Returns { rules, inherited?, pseudo? }: each entry has selector, source?, media?
 * and decls [{ name, value, important?, overridden?, invalid? }].
 */
export function shapeMatchedStyles(matched, { sheets, ancestors }) {
  const own = entriesOf(matched.matchedCSSRules, matched.inlineStyle);
  const winners = cascadeWinners(own);
  const rules = own
    .map((entry, i) => isAuthor(entry) && view(entry, sheets, () => true, (p) => longhandsOf(p).every((n) => winners.get(n)?.i !== i)))
    .filter(Boolean)
    .reverse()
    .slice(0, MAX_RULES);

  // Inherited: an ancestor's inheritable declaration applies unless the element
  // or a nearer ancestor sets that property (user-agent rules count: a button's
  // own `color: buttontext` beats a parent's color).
  const taken = new Set(winners.keys());
  const inherited = [];
  (matched.inherited || []).forEach((level, k) => {
    const entries = entriesOf(level.matchedCSSRules, level.inlineStyle);
    const levelWinners = cascadeWinners(entries);
    entries.forEach((entry, i) => {
      if (!isAuthor(entry)) return;
      const out = view(entry, sheets, (p) => longhandsOf(p).some((n) => INHERITED.test(n)),
        (p) => longhandsOf(p).every((n) => taken.has(n) || levelWinners.get(n)?.i !== i));
      if (out) inherited.push({ ...(ancestors[k] ? { from: ancestors[k] } : { level: k + 1 }), ...out });
    });
    for (const name of levelWinners.keys()) if (INHERITED.test(name)) taken.add(name);
  });

  const pseudo = [];
  for (const { pseudoType, matches } of matched.pseudoElements || []) {
    for (const entry of entriesOf(matches, null)) {
      if (!isAuthor(entry)) continue;
      const out = view(entry, sheets, () => true, () => false);
      if (out) pseudo.push({ pseudo: `::${pseudoType}`, ...out });
    }
  }

  return {
    rules,
    ...(inherited.length ? { inherited: inherited.slice(0, MAX_INHERITED) } : {}),
    ...(pseudo.length ? { pseudo: pseudo.slice(0, MAX_PSEUDO) } : {}),
  };
}

/**
 * The element's own listeners and those on its ancestors (`on` names the ancestor),
 * with the script URL and line each handler was written on. `scripts` maps a CDP
 * scriptId to its URL (Debugger.scriptParsed).
 */
export function shapeListeners(listeners, scripts = new Map(), on = null) {
  return listeners.map((l) => {
    const url = scripts.has(l.scriptId) ? (scripts.get(l.scriptId) || 'inline') : 'unknown script';
    return {
      type: l.type,
      where: `${url}:${l.lineNumber + 1}`,
      flags: [l.useCapture && 'capture', l.passive && 'passive', l.once && 'once', on && `on ${on}`].filter(Boolean),
    };
  });
}

/** Text: one line per declaration, with what overrode it or made it invalid. */
function declLines(decls) {
  const out = [];
  let used = 0;
  for (let i = 0; i < decls.length; i++) {
    const d = decls[i];
    const line = `  ${d.name}: ${d.value}${d.important ? ' !important' : ''}${d.overridden ? ' (overridden)' : ''}${d.invalid ? ' (invalid, ignored)' : ''}`;
    if (used + line.length > MAX_RULE_CHARS) {
      out.push(`  … ${decls.length - i} more`);
      break;
    }
    out.push(line);
    used += line.length;
  }
  return out;
}

/** Head line of a rule: `selector  file:line  @media …`. */
const ruleHead = (e) => [e.selector, e.source, e.media && `@media ${e.media}`].filter(Boolean).join('  ');

/** The shaped rules as lines: { rules, inherited, pseudo } (each an array of lines). */
export function formatRules(shaped) {
  const block = (head, e) => [head, ...declLines(e.decls)];
  return {
    rules: shaped.rules.length ? shaped.rules.flatMap((e) => block(ruleHead(e), e)) : ['(no author rules match)'],
    inherited: (shaped.inherited || []).flatMap((e) => block(`${ruleHead(e)}  (inherited from ${e.from || `level ${e.level}`})`, e)),
    pseudo: (shaped.pseudo || []).flatMap((e) => block(ruleHead(e), e)),
  };
}

/** Own listeners first, then the ancestors' (the event bubbles up to them). */
export function formatListeners({ own, delegated }) {
  const all = [...own, ...delegated];
  if (!all.length) return ['(no listeners)'];
  const lines = all.slice(0, MAX_LISTENERS).map((l) => `${l.type}  ${l.where}${l.flags.length ? ` (${l.flags.join(', ')})` : ''}`);
  if (all.length > MAX_LISTENERS) lines.push(`… ${all.length - MAX_LISTENERS} more`);
  return lines;
}

/** Computed styles as `prop: value` lines. `all` (["*"]) is capped and says so. */
export function formatStyles(styles, all = false) {
  const entries = Object.entries(styles);
  if (!entries.length) return [all ? '(no properties)' : '(no computed style differs from the defaults)'];
  const shown = all ? entries.slice(0, MAX_ALL_PROPERTIES) : entries;
  const lines = shown.map(([name, value]) => `${name}: ${value === '' ? '(unknown property)' : value}`);
  if (shown.length < entries.length) lines.push(`… ${entries.length - shown.length} more properties not shown: name the ones you need in properties`);
  return lines;
}

/**
 * The whole answer: the element's header line, then the sections. A lone styles
 * section is printed bare; with more, each section gets its title line.
 */
export function renderInspect(element, sections) {
  const sel = `${element.tag}${element.id ? `#${element.id}` : ''}${(element.classes || []).map((c) => `.${c}`).join('')}`;
  const head = `${sel}${element.text ? ` "${element.text}"` : ''} box ${element.box.x},${element.box.y} ${element.box.width}x${element.box.height}`;
  const bare = sections.length === 1 && sections[0].title === 'styles';
  return [head, ...sections.flatMap((s) => (bare ? s.lines : [`${s.title}:`, ...s.lines]))].join('\n');
}
