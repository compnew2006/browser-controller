/**
 * Native Chrome accessibility tree (CDP `Accessibility.getFullAXTree`) →
 * the same compact/full tree shape `browser_snapshot` returns from the DOM
 * walker, so agents and ref tools work unchanged.
 *
 * Everything here is pure (no chrome.*, no page access) and unit tested. The
 * CDP and page plumbing lives in handlers/ax-snapshot.js.
 *
 * Why native: Chrome computes roles, accessible names and states itself —
 * `aria-labelledby` chains, `<label>`/`<fieldset>` rules, native widget roles,
 * `hidden`/`inert` exclusion, `aria-hidden` subtrees — exactly what assistive
 * technology sees. The DOM walker approximates that; this is the source.
 */

/**
 * Roles a user can act on. Standard ARIA names plus the Chrome-specific ones
 * observed from Accessibility.getFullAXTree for native widgets: `ColorWell`
 * (<input type=color>), `Date` / `DateTime` / `InputTime` (date and time
 * inputs), `DisclosureTriangle` (<summary>).
 */
export const AX_INTERACTIVE_ROLES = new Set([
  'button', 'link', 'textbox', 'searchbox', 'combobox', 'listbox', 'checkbox', 'radio',
  'switch', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'option', 'slider',
  'spinbutton', 'treeitem', 'ColorWell', 'Date', 'DateTime', 'InputTime', 'DisclosureTriangle',
]);

/** Landmarks/regions kept in compact mode (same set the DOM snapshot keeps). */
export const AX_LANDMARK_ROLES = new Set([
  'navigation', 'main', 'banner', 'contentinfo', 'form', 'search', 'complementary', 'region', 'dialog', 'alertdialog',
]);

/** Roles that only wrap other nodes: promoted away, never emitted themselves. */
const AX_TRANSPARENT_ROLES = new Set([
  'none', 'presentation', 'generic', 'RootWebArea', 'WebArea', 'Iframe', 'IframePresentational',
  'InlineTextBox', 'LineBreak', 'LabelText', 'ListMarker',
]);

/** Hard ceiling on nodes that get a ref (one CDP round-trip each). */
export const MAX_NATIVE_REFS = 1500;
const NAME_MAX = 80;

const val = (v) => (v && typeof v === 'object' && 'value' in v ? v.value : v);
const clean = (v, max = NAME_MAX) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max);

/** AX property list → plain object (`{ focusable: true, checked: 'mixed', level: 2 }`). */
export function axProps(node) {
  const out = {};
  for (const p of node.properties || []) out[p.name] = val(p.value);
  return out;
}

/** AX nodes use string ids that can repeat across frames: namespace each frame's ids. */
function namespaced(nodes, ns) {
  if (!ns) return nodes;
  return nodes.map((n) => ({
    ...n,
    nodeId: `${ns}:${n.nodeId}`,
    ...(n.parentId != null ? { parentId: `${ns}:${n.parentId}` } : {}),
    ...(n.childIds ? { childIds: n.childIds.map((c) => `${ns}:${c}`) } : {}),
  }));
}

/**
 * Join the per-frame AX forests. `getFullAXTree` stops at an <iframe>: the
 * frame appears as a childless `Iframe` node, and its content has to be fetched
 * with its own frameId. Graft each child frame's root under its owner node.
 *
 * @param {object[]} mainNodes nodes of the main frame
 * @param {Array<{nodes: object[], ownerBackendNodeId: number}>} frames child frames
 * @returns {object[]} one flat node list (ids unique)
 */
export function mergeFrameTrees(mainNodes, frames = []) {
  // Copies (the owner's childIds are rewritten) tagged with the frame they came
  // from: elements of different frames live in different JS contexts, so the
  // CDP bridge must batch per frame.
  const all = mainNodes.map((n) => ({ ...n, frameIndex: 0 }));
  const byBackend = new Map();
  for (const n of all) if (n.backendDOMNodeId != null) byBackend.set(n.backendDOMNodeId, n);

  frames.forEach((frame, i) => {
    const nodes = namespaced(frame.nodes || [], `f${i + 1}`).map((n) => ({ ...n, frameIndex: i + 1 }));
    if (!nodes.length) return;
    const owner = byBackend.get(frame.ownerBackendNodeId);
    if (!owner) return; // owner hidden/removed: its content is not reachable either
    const root = nodes.find((n) => n.parentId == null) || nodes[0];
    owner.childIds = [...(owner.childIds || []), root.nodeId];
    root.parentId = owner.nodeId;
    for (const n of nodes) {
      all.push(n);
      if (n.backendDOMNodeId != null) byBackend.set(n.backendDOMNodeId, n);
    }
  });
  return all;
}

/**
 * Accessible-name rules for a text leaf: Chrome gives every link/button a
 * StaticText child that repeats the parent's name. Dropping the repeats keeps
 * the tree from doubling in size.
 */
function repeatsAncestorName(text, ancestorName) {
  if (!text) return true;
  return !!ancestorName && ancestorName.includes(text);
}

function stateOf(props, role) {
  const s = {};
  if (props.disabled === true) s.disabled = true;
  if (props.focused === true) s.focused = true;
  const checked = props.checked;
  if (checked === 'mixed') s.checked = 'mixed';
  else if (checked === 'true' || checked === true) s.checked = true;
  else if (checked === 'false' || checked === false) s.checked = false;
  const pressed = props.pressed;
  if (pressed === 'mixed') s.pressed = 'mixed';
  else if (pressed === 'true' || pressed === true) s.pressed = true;
  if (props.expanded === true) s.expanded = true;
  else if (props.expanded === false) s.expanded = false;
  if (props.selected === true) s.selected = true;
  if (props.required === true) s.required = true;
  if (props.readonly === true) s.readOnly = true;
  // CDP spells it as a token: "true" | "false" | "grammar" | "spelling".
  if (props.invalid && props.invalid !== 'false') s.invalid = props.invalid === true || props.invalid === 'true' ? true : props.invalid;
  if (props.modal === true) s.modal = true;
  if (Number.isFinite(props.level) && role === 'heading') s.level = props.level;
  return s;
}

/** Plain-text value of a control (checkbox state lives in `checked`, not here). */
function valueOf(node, role) {
  if (role === 'checkbox' || role === 'radio' || role === 'switch') return undefined;
  const v = val(node.value);
  if (v == null || v === '') return undefined;
  return clean(v, 200);
}

/**
 * Shape the AX forest into the snapshot tree.
 *
 * @param {object[]} nodes flat CDP nodes (after mergeFrameTrees)
 * @param {object} [opts]
 * @param {boolean} [opts.compact=true] interactive + landmarks + headings only
 * @param {number} [opts.depth] max nesting of emitted nodes (0 = top level)
 * @param {number} [opts.maxChars] output budget in serialized characters
 * @param {number} [opts.rootBackendNodeId] scope to this DOM node's subtree
 * @param {Set<string>|null} [opts.prevFingerprints] role|name keys of the previous native snapshot
 * @returns {{tree: object|object[]|null, entries: Array<{ref: string, backendNodeId: number, frame: number}>, fingerprints: string[], truncated: boolean, refLimited: boolean, rootFound: boolean}}
 *   `entries` are the nodes that want a ref; the caller binds them to page
 *   elements and drops the refs it could not bind (stripRefs).
 */
export function shapeAxTree(nodes, opts = {}) {
  const {
    compact = true,
    depth,
    maxChars,
    rootBackendNodeId,
    prevFingerprints = null,
    refPrefix = 'n',
  } = opts;
  const maxDepth = Number.isInteger(depth) && depth >= 0 ? depth : Infinity;
  let budget = Number.isInteger(maxChars) && maxChars > 0 ? maxChars : Infinity;
  let truncated = false;
  let refLimited = false;

  const byId = new Map();
  for (const n of nodes) byId.set(n.nodeId, n);
  const childrenOf = (n) => (n.childIds || []).map((id) => byId.get(id)).filter(Boolean);

  const entries = [];
  const fingerprints = [];
  let refSeq = 0;

  let rootNodes;
  let rootFound = true;
  if (rootBackendNodeId != null) {
    const hit = nodes.find((n) => n.backendDOMNodeId === rootBackendNodeId);
    rootNodes = hit ? [hit] : [];
    rootFound = !!hit;
  } else {
    // Roots: nodes whose parent is absent (the main frame's RootWebArea).
    rootNodes = nodes.filter((n) => n.parentId == null || !byId.has(n.parentId));
  }

  /**
   * What `node` contributes, or null when it only passes its children through.
   * compact: interactive + landmarks + headings (the DOM snapshot's set).
   * full: everything with meaning — structural wrappers (generic, RootWebArea,
   * Iframe…) are still promoted away, text repeating its parent's name is dropped.
   */
  function ownRecord(role, name, props, ancestorName) {
    if (role === 'StaticText') {
      if (compact) return null;
      return repeatsAncestorName(name, ancestorName) ? null : { role: 'text' };
    }
    // A clickable <div tabindex=0> is just "generic" to Chrome: keep it when it has a name.
    const interactive = AX_INTERACTIVE_ROLES.has(role) || (role === 'generic' && props.focusable === true && !!name);
    if (compact) {
      return interactive || AX_LANDMARK_ROLES.has(role) || role === 'heading' ? { role } : null;
    }
    if (interactive) return { role };
    return AX_TRANSPARENT_ROLES.has(role) ? null : { role };
  }

  function walk(node, d, ancestorName) {
    if (budget <= 0) { truncated = true; return null; }
    const role = val(node.role) || '';
    if (role === 'InlineTextBox' || role === 'ListMarker') return null;
    const name = clean(val(node.name));
    const props = axProps(node);

    // Ignored nodes and wrappers contribute only their children.
    const passThrough = node.ignored === true;
    const own = passThrough ? null : ownRecord(role, name, props, ancestorName);

    let rec = null;
    if (own) {
      if (d > maxDepth) { truncated = true; return null; }
      rec = { role: own.role };
      if (name) rec.name = name;
      if (own.role !== 'text') {
        const value = valueOf(node, role);
        if (value !== undefined) rec.value = value;
        Object.assign(rec, stateOf(props, role));
        const desc = clean(val(node.description), NAME_MAX);
        if (desc && !compact) rec.description = desc;
        if (node.backendDOMNodeId != null) {
          if (entries.length >= MAX_NATIVE_REFS) {
            refLimited = true;
          } else {
            rec.ref = `${refPrefix}${refSeq++}`;
            entries.push({ ref: rec.ref, backendNodeId: node.backendDOMNodeId, frame: node.frameIndex || 0 });
          }
        }
        fingerprints.push(`${own.role}|${name}`);
        if (prevFingerprints && !prevFingerprints.has(`${own.role}|${name}`)) rec.isNew = true;
      }
      budget -= JSON.stringify(rec).length + 16;
    }

    const kids = [];
    if (!(own && d >= maxDepth)) {
      const nextName = own && own.role !== 'text' && name ? name : ancestorName;
      for (const child of childrenOf(node)) {
        const c = walk(child, own ? d + 1 : d, nextName);
        if (c) Array.isArray(c) ? kids.push(...c) : kids.push(c);
      }
    } else if (childrenOf(node).length) {
      truncated = true;
    }

    if (!rec) return kids.length === 0 ? null : kids.length === 1 ? kids[0] : kids;
    if (kids.length) rec.children = kids;
    return rec;
  }

  const parts = [];
  for (const root of rootNodes) {
    const r = walk(root, 0, '');
    if (r) Array.isArray(r) ? parts.push(...r) : parts.push(r);
  }
  const tree = parts.length === 0 ? null : parts.length === 1 ? parts[0] : parts;
  return { tree, entries, fingerprints, truncated, refLimited, rootFound };
}

/**
 * Settle the tree after the page bound what it could: attach hrefs, remove refs
 * that did not bind. With `dropUnbound` (compact mode) an interactive node that
 * did not bind is omitted and its children promoted: those are Chrome-internal
 * controls with no element to act on (the sub-fields and picker button inside a
 * date input live in a user-agent shadow root) or elements that vanished
 * mid-snapshot. Returns the new root (null when nothing is left).
 */
export function applyBindings(tree, bound, { dropUnbound = false } = {}) {
  const settle = (list) => {
    const out = [];
    for (const node of list) {
      if (node.children) {
        node.children = settle(node.children);
        if (!node.children.length) delete node.children;
      }
      if (node.ref && !bound[node.ref]) {
        if (dropUnbound && (AX_INTERACTIVE_ROLES.has(node.role) || node.role === 'generic')) {
          out.push(...(node.children || []));
          continue;
        }
        delete node.ref;
      } else if (node.ref && bound[node.ref].href) {
        node.href = bound[node.ref].href;
      }
      out.push(node);
    }
    return out;
  };
  const settled = settle(Array.isArray(tree) ? tree : tree ? [tree] : []);
  return settled.length === 0 ? null : settled.length === 1 ? settled[0] : settled;
}

/**
 * Locate a DOM node in a `DOM.getDocument({pierce:true})` dump by the same
 * structural path the page-side `pathOf` produced, and return its backendNodeId.
 *
 * Path grammar (identical in both worlds): a number is an index among the
 * parent's ELEMENT children; -1 enters the author shadow root of the current
 * element; -2 enters the content document of the current <iframe>.
 */
export function backendIdAtPath(root, path, tag) {
  let cur = root;
  for (const step of path) {
    if (!cur) return null;
    if (step === -1) {
      cur = (cur.shadowRoots || []).find((r) => r.shadowRootType !== 'user-agent') || null;
    } else if (step === -2) {
      cur = cur.contentDocument || null;
    } else {
      cur = (cur.children || []).filter((c) => c.nodeType === 1)[step] || null;
    }
  }
  if (!cur || cur.nodeType !== 1) return null;
  if (tag && String(cur.nodeName).toUpperCase() !== String(tag).toUpperCase()) return null;
  return cur.backendNodeId ?? null;
}

/**
 * Structural path of an element from its top document. ONE definition, run in
 * both worlds (serialized with Function#toString, so it must stay
 * self-contained and close over nothing):
 *   - main world via CDP `Runtime.callFunctionOn`, with `element` given;
 *   - the extension's isolated world via chrome.scripting, resolving
 *     `ref` / `selector` / `fb` through the shared page runtime (scoped snapshots).
 * Returns `{ path, tag }`, or `{ error }` (INVALID_SELECTOR, REF_GONE, DETACHED).
 */
export function pathOfTarget(ref, selector, fb, element) {
  let el = element || null;
  if (!el) {
    const D = globalThis.__bcDom;
    if (!D) return { __needDom: true };
    const hit = D.resolve(ref, selector, fb);
    if (hit.error) return { error: hit.error };
    el = hit.el;
  }
  if (!el || el.nodeType !== 1) return { error: 'REF_GONE' };
  const path = [];
  let node = el;
  for (let guard = 0; guard < 400; guard++) {
    if (!node) return { error: 'DETACHED' };
    if (node.nodeType === 9) {
      let frame;
      try { frame = node.defaultView && node.defaultView.frameElement; } catch { frame = null; }
      if (!frame) return { path, tag: el.tagName };
      path.unshift(-2);
      node = frame;
      continue;
    }
    const parent = node.parentNode;
    if (!parent) return { error: 'DETACHED' };
    const index = Array.prototype.indexOf.call(parent.children, node);
    if (index < 0) return { error: 'DETACHED' };
    if (parent.nodeType === 11) {
      if (!parent.host) return { error: 'DETACHED' };
      path.unshift(-1, index);
      node = parent.host;
    } else {
      path.unshift(index);
      node = parent;
    }
  }
  return { error: 'DETACHED' };
}
