/**
 * browser_snapshot with source:"native": the tree comes from Chrome's own
 * accessibility engine (CDP Accessibility.getFullAXTree) instead of the DOM
 * walker. Every ref it returns is bound to the real element in the page's
 * shared ref registry, so click / type / hover / select / scroll / drag /
 * fill_form / find ... treat a native ref exactly like a DOM-snapshot ref
 * (including the smart-selector fallback that survives re-renders).
 *
 * How a CDP node becomes a registry element without touching the page:
 *   1. AX nodes carry `backendDOMNodeId`.
 *   2. The main world resolves that id to an object (DOM.resolveNode) and
 *      computes the element's structural path (lib/ax-native.js pathOfTarget).
 *   3. The isolated world walks the same path — through closed shadow roots
 *      and same-origin iframes via the shared runtime — verifies the tag, and
 *      registers the element. No attribute or other DOM mutation anywhere.
 */
import { resolveTab, execDom, safeExec, getFallback, assertResponsive, withTimeout } from '../lib/page-exec.js';
import { withCdp } from '../lib/cdp-session.js';
import { fallbackByTab, lastNativeFingerprints, persistSessionState, nextRefPrefix } from '../lib/state.js';
import { PAGE_FALLBACK_INSTALL } from '../utils/smart-selector.js';
import { mergeFrameTrees, shapeAxTree, applyBindings, backendIdAtPath, pathOfTarget } from '../lib/ax-native.js';

/** AX tree of a very large page can take seconds; a frozen renderer never answers. */
const AX_TIMEOUT_MS = 12_000;
/** Same-origin frames merged into one tree (each costs two CDP calls). */
const MAX_FRAMES = 20;
/** resolveNode calls in flight / objects passed to one callFunctionOn (per frame). */
const BRIDGE_CHUNK = 150;
const OBJECT_GROUP = 'bc-ax-native';

/** Main-world function: paths of every element passed in, in order. */
const PATHS_FUNCTION = `function (...els) { const f = ${pathOfTarget.toString()}; return els.map((el) => f(null, null, null, el)); }`;

/** Child frames below the top frame, depth-first, capped. */
function childFrames(frameTree) {
  const out = [];
  const visit = (t) => {
    for (const child of t.childFrames || []) {
      if (out.length >= MAX_FRAMES) return;
      out.push(child.frame);
      visit(child);
    }
  };
  visit(frameTree);
  return out;
}

/** Main frame + every same-process child frame, merged into one node list. */
async function fetchForest(send) {
  const { frameTree } = await send('Page.getFrameTree');
  const [main, ...rest] = await Promise.all([
    send('Accessibility.getFullAXTree'),
    ...childFrames(frameTree).map(async (frame) => {
      try {
        const [ax, owner] = await Promise.all([
          send('Accessibility.getFullAXTree', { frameId: frame.id }),
          send('DOM.getFrameOwner', { frameId: frame.id }),
        ]);
        return { nodes: ax.nodes || [], ownerBackendNodeId: owner.backendNodeId, url: frame.url };
      } catch {
        // Out-of-process (cross-origin) frame: its tree lives in another target.
        return { skipped: frame.url };
      }
    }),
  ]);
  const frames = rest.filter((f) => f.nodes);
  return {
    nodes: mergeFrameTrees(main.nodes || [], frames),
    skippedFrames: rest.filter((f) => f.skipped).map((f) => f.skipped),
  };
}

/**
 * backendNodeId -> { path, tag } for the entries that resolve to a live,
 * reachable element. Batched per frame: objects of different frames belong to
 * different JS contexts and cannot be passed to one callFunctionOn.
 */
async function resolvePaths(send, entries) {
  const out = new Map();
  const byFrame = new Map();
  for (const e of entries) {
    if (!byFrame.has(e.frame)) byFrame.set(e.frame, []);
    byFrame.get(e.frame).push(e.backendNodeId);
  }
  try {
    for (const ids of byFrame.values()) {
      for (let i = 0; i < ids.length; i += BRIDGE_CHUNK) {
        const chunk = ids.slice(i, i + BRIDGE_CHUNK);
        const objects = await Promise.all(chunk.map((backendNodeId) => send('DOM.resolveNode', { backendNodeId, objectGroup: OBJECT_GROUP })
          .then((r) => r?.object?.objectId || null, () => null)));
        const live = chunk.map((id, k) => ({ id, objectId: objects[k] })).filter((x) => x.objectId);
        if (!live.length) continue;
        const res = await send('Runtime.callFunctionOn', {
          objectId: live[0].objectId,
          functionDeclaration: PATHS_FUNCTION,
          arguments: live.map((x) => ({ objectId: x.objectId })),
          returnByValue: true,
          silent: true,
        });
        const values = res?.result?.value || [];
        live.forEach((x, k) => { if (values[k] && !values[k].error) out.set(x.id, values[k]); });
      }
    }
  } finally {
    await send('Runtime.releaseObjectGroup', { objectGroup: OBJECT_GROUP }).catch(() => {});
  }
  return out;
}

/**
 * Page side (isolated world): walk each path to its element, verify the tag,
 * register it under its ref and record its smart-selector fallback.
 * Self-contained: serialized into the page by chrome.scripting.
 */
function pageBindNative(entries) {
  const D = globalThis.__bcDom;
  if (!D) return { __needDom: true };
  const gen = (globalThis.__browserControllerFallbackRuntime || {}).generateFallback || null;
  const origin = location.origin;
  const bound = {};
  const fallbacks = {};
  for (const entry of entries) {
    let cur = document;
    for (const step of entry.path) {
      if (!cur) break;
      if (step === -1) cur = D.shadowOf(cur);
      else if (step === -2) cur = D.frameDoc(cur);
      else cur = cur.children ? cur.children[step] || null : null;
    }
    if (!cur || cur.nodeType !== 1 || cur.tagName !== entry.tag) continue; // moved/removed since the AX read
    D.registry.set(entry.ref, cur);
    bound[entry.ref] = {};
    if (cur.tagName === 'A' && typeof cur.href === 'string' && cur.href) {
      bound[entry.ref].href = cur.href.startsWith(origin + '/') ? cur.href.slice(origin.length) : cur.href;
    }
    try { if (gen) fallbacks[entry.ref] = gen(cur); } catch { /* descriptor is best-effort */ }
  }
  return { success: true, bound, fallbacks };
}

/**
 * @returns the snapshot result, or `{ __fallback: reason }` when Chrome's
 * accessibility tree is unavailable here (debugger can't attach, timeout…) so
 * the caller can serve the DOM snapshot instead.
 */
export async function handleNativeSnapshot(params, { compact, maxChars }) {
  const { tabId, selector, ref: rootRef, depth } = params;
  const tab = await resolveTab(tabId);
  if (/^(chrome|chrome-extension|devtools|edge|about):/i.test(tab.url || '')) {
    throw new Error(`Cannot access protected page (${tab.url}). Tab ${tabId} is a browser-internal page.`);
  }
  await assertResponsive(tabId);

  // Scope (selector / ref): resolve in the page, then locate the same node by path.
  let scope = null;
  if (rootRef || selector) {
    const hit = await execDom(tabId, pathOfTarget, [rootRef ?? null, selector ?? null, getFallback(tabId, rootRef), null]);
    if (hit?.error === 'INVALID_SELECTOR') return { success: false, error: `Invalid CSS selector: ${selector}` };
    if (!hit || hit.error) {
      return { success: false, error: rootRef ? `ref ${rootRef} is gone — take a new snapshot` : 'Root element not found' };
    }
    scope = hit;
  }

  const refPrefix = nextRefPrefix('s');
  const prev = lastNativeFingerprints.get(tabId);
  let stage;
  try {
    stage = await withCdp(tabId, async (send) => {
      const forest = await withTimeout(fetchForest(send), AX_TIMEOUT_MS, () => new Error('accessibility tree timed out'));
      let rootBackendNodeId;
      if (scope) {
        const { root } = await send('DOM.getDocument', { depth: -1, pierce: true });
        rootBackendNodeId = backendIdAtPath(root, scope.path, scope.tag);
        if (rootBackendNodeId == null) return { scopeLost: true };
      }
      const shaped = shapeAxTree(forest.nodes, {
        compact, depth, maxChars, rootBackendNodeId, refPrefix, prevFingerprints: prev ? new Set(prev) : null,
      });
      if (!shaped.rootFound) return { noAxNode: true };
      const paths = await resolvePaths(send, shaped.entries);
      return { shaped, paths, skippedFrames: forest.skippedFrames };
    });
  } catch (err) {
    if (err && err.code === 'TAB_WEDGED') throw err;
    return { __fallback: `Chrome accessibility tree unavailable (${String(err?.message || err)})` };
  }

  if (stage.scopeLost) {
    return { success: false, error: rootRef ? `ref ${rootRef} is gone — take a new snapshot` : 'Root element not found' };
  }
  if (stage.noAxNode) {
    return { success: false, error: 'Root element is not in the accessibility tree (hidden or aria-hidden) — scope to a visible element.' };
  }
  const { shaped, paths, skippedFrames } = stage;

  // Bind refs to elements in the page registry (after the fallback generator is installed).
  const bindEntries = shaped.entries
    .filter((e) => paths.has(e.backendNodeId))
    .map((e) => ({ ref: e.ref, path: paths.get(e.backendNodeId).path, tag: paths.get(e.backendNodeId).tag }));
  let bound = {};
  if (bindEntries.length) {
    await safeExec(tabId, PAGE_FALLBACK_INSTALL, []);
    const bind = await execDom(tabId, pageBindNative, [bindEntries]);
    bound = bind?.bound || {};
    if (bind?.fallbacks) {
      // Merged, not replaced: a scoped snapshot must not invalidate refs from the full one.
      const map = fallbackByTab.get(tabId) || new Map();
      for (const [ref, fb] of Object.entries(bind.fallbacks)) map.set(ref, fb);
      while (map.size > 3000) map.delete(map.keys().next().value);
      fallbackByTab.set(tabId, map);
      persistSessionState();
    }
  }
  const tree = applyBindings(shaped.tree, bound, { dropUnbound: compact });
  lastNativeFingerprints.set(tabId, shaped.fingerprints);

  const unbound = shaped.entries.length - Object.keys(bound).length;
  const current = await chrome.tabs.get(tabId).catch(() => tab);
  return {
    success: true,
    source: 'native',
    url: current.url,
    title: current.title || '',
    compact,
    tree,
    ...(shaped.truncated ? {
      truncated: true,
      hint: 'Output capped (maxChars/depth). Scope it with selector or ref (a subtree), or raise maxChars.',
    } : {}),
    ...(shaped.refLimited ? { refLimited: true } : {}),
    ...(unbound > 0 ? { unreachableNodes: unbound } : {}),
    ...(skippedFrames.length ? { skippedFrames } : {}),
  };
}
