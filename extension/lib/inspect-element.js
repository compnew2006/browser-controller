/**
 * browser_inspect_element, pure parts: the page-side computed-style reader,
 * and the shaping of CDP CSS.getMatchedStylesForNode / DOMDebugger
 * .getEventListeners results into the compact view the agent reads.
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
const MAX_TYPES = 30;
const MAX_STYLE_CHARS = 600;
const MAX_HANDLER_CHARS = 120;

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
 * Page side (isolated world, via execDom; self-contained — it is serialized):
 * the element's description, box and computed styles. `properties` picks the
 * styles (["*"] = all); without it, KEY_STYLES that differ from their default.
 */
export function pageInspect(ref, selector, fb, properties, keyStyles) {
  const D = globalThis.__bcDom;
  if (!D) return { __needDom: true };
  const hit = D.resolve(ref, selector, fb);
  if (hit.error) return { error: hit.error };
  const el = hit.el;
  if (!el || el.nodeType !== 1) return { error: 'REF_GONE' };
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
  const r = el.getBoundingClientRect();
  const text = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80);
  return {
    element: {
      tag: el.tagName.toLowerCase(),
      ...(el.id ? { id: el.id } : {}),
      ...(el.classList.length ? { classes: Array.from(el.classList) } : {}),
      ...(text ? { text } : {}),
      box: { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) },
    },
    styles,
  };
}

/** "button#go.btn.primary" from a CDP DOM.Node. */
export function describeNode(node) {
  const attrs = node.attributes || [];
  const get = (name) => { const i = attrs.indexOf(name); return i >= 0 && i % 2 === 0 ? attrs[i + 1] : ''; };
  const id = get('id');
  const classes = get('class').split(/\s+/).filter(Boolean);
  return `${String(node.nodeName).toLowerCase()}${id ? `#${id}` : ''}${classes.map((c) => `.${c}`).join('')}`;
}

/**
 * Follow a structural path (lib/ax-native.js grammar) in a DOM.getDocument
 * pierce dump: the target node and its ancestor elements within its own
 * document, nearest first. null when the path no longer leads to `tag`.
 */
export function nodesAtPath(root, path, tag) {
  let cur = root;
  let chain = [];
  let crossesShadow = false;
  for (const step of path) {
    if (!cur) return null;
    if (step === -1) {
      cur = (cur.shadowRoots || []).find((r) => r.shadowRootType !== 'user-agent') || null;
      crossesShadow = true;
    } else if (step === -2) {
      cur = cur.contentDocument || null;
      chain = []; // a frame's elements inherit nothing from the embedding page
      crossesShadow = false;
    } else {
      cur = (cur.children || []).filter((c) => c.nodeType === 1)[step] || null;
      if (cur) chain.push(cur);
    }
  }
  if (!cur || cur.nodeType !== 1) return null;
  if (tag && String(cur.nodeName).toUpperCase() !== String(tag).toUpperCase()) return null;
  return { target: cur, ancestors: chain.slice(0, -1).reverse(), crossesShadow };
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
  out.style = cap(props.map((p) => `${p.name}: ${p.value}`).join('; '), MAX_STYLE_CHARS);
  const overridden = props.filter((p) => p.parsedOk !== false && lost(p)).map((p) => p.name);
  const invalid = props.filter((p) => p.parsedOk === false).map((p) => p.name);
  if (overridden.length) out.overridden = overridden;
  if (invalid.length) out.invalid = invalid;
  return out;
}

const isAuthor = (entry) => entry.inline || entry.rule.origin === 'regular';

/**
 * `matched` is a CSS.getMatchedStylesForNode result; `sheets` maps styleSheetId
 * to { url, startLine }; `ancestors[k]` labels matched.inherited[k] (null: unknown).
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

/** The element's own listeners (DOMDebugger.getEventListeners, with an objectGroup so handlers are described). */
export function shapeListeners(listeners) {
  return listeners.slice(0, MAX_LISTENERS).map((l) => ({
    type: l.type,
    ...(l.useCapture ? { capture: true } : {}),
    ...(l.passive ? { passive: true } : {}),
    ...(l.once ? { once: true } : {}),
    ...(l.handler?.description ? { handler: cap(l.handler.description.replace(/\s+/g, ' '), MAX_HANDLER_CHARS) } : {}),
    line: l.lineNumber + 1,
    column: l.columnNumber + 1,
  }));
}

/** Event types an ancestor, the document or the window listens to (they see the element's bubbling events). */
export function listenerTypes(listeners) {
  const types = [...new Set(listeners.map((l) => (l.useCapture ? `${l.type} (capture)` : l.type)))];
  return types.length > MAX_TYPES ? [...types.slice(0, MAX_TYPES), `…+${types.length - MAX_TYPES} more`] : types;
}
