/**
 * browser_inspect_element: why an element looks and behaves the way it does —
 * its computed styles (page side, no debugger), the CSS rules that match it
 * with what lost the cascade, and the event listeners on it and on its
 * ancestors (CDP). Shaping lives in lib/inspect-element.js.
 */
import { resolveTab, execDom, getFallback, requireTarget } from '../lib/page-exec.js';
import { withCdp, subscribeCdpEvents } from '../lib/cdp-session.js';
import { pathOfTarget } from '../lib/ax-native.js';
import {
  KEY_STYLES, pageInspect, nodesAtPath, describeNode, shapeMatchedStyles, shapeListeners, listenerTypes,
} from '../lib/inspect-element.js';

const OBJECT_GROUP = 'bc-inspect';
const MAX_ANCESTORS = 25;

function goneError(ref, selector, code) {
  if (code === 'INVALID_SELECTOR') return `Invalid CSS selector: ${selector}`;
  return ref ? `ref ${ref} is gone — take a new snapshot` : `No element matches ${selector}`;
}

async function matchedRules(tabId, send, found) {
  // styleSheetAdded (sent while CSS.enable runs) gives each sheet's URL and position in its document.
  const sheets = new Map();
  const off = subscribeCdpEvents(tabId, (method, p) => {
    if (method === 'CSS.styleSheetAdded') sheets.set(p.header.styleSheetId, { url: p.header.sourceURL, startLine: p.header.startLine });
  });
  try {
    const { nodeIds } = await send('DOM.pushNodesByBackendIdsToFrontend', { backendNodeIds: [found.target.backendNodeId] });
    await send('CSS.enable');
    const matched = await send('CSS.getMatchedStylesForNode', { nodeId: nodeIds[0] });
    // With a shadow tree on the way the inherited chain follows the flat tree: label by level.
    const ancestors = found.flatTreeDiffers ? [] : found.ancestors.map(describeNode);
    return shapeMatchedStyles(matched, { sheets, ancestors });
  } finally {
    off();
    send('CSS.disable').catch(() => {});
  }
}

async function listenersOf(send, found) {
  const listen = async (objectId) => (await send('DOMDebugger.getEventListeners', { objectId })).listeners || [];
  const { object } = await send('DOM.resolveNode', { backendNodeId: found.target.backendNodeId, objectGroup: OBJECT_GROUP });
  const own = await listen(object.objectId);
  // Delegation: the element's events bubble to its ancestors, the document and the window.
  const chain = await Promise.all(found.ancestors.slice(0, MAX_ANCESTORS).map(async (node) => {
    const { object: o } = await send('DOM.resolveNode', { backendNodeId: node.backendNodeId, objectGroup: OBJECT_GROUP });
    return { on: describeNode(node), listeners: await listen(o.objectId) };
  }));
  for (const [on, fn] of [['document', 'function () { return this.ownerDocument; }'], ['window', 'function () { return this.ownerDocument.defaultView; }']]) {
    const { result } = await send('Runtime.callFunctionOn', { objectId: object.objectId, functionDeclaration: fn, objectGroup: OBJECT_GROUP });
    chain.push({ on, listeners: await listen(result.objectId) });
  }
  const delegated = chain.filter((c) => c.listeners.length).map((c) => ({ on: c.on, types: listenerTypes(c.listeners) }));
  return { listeners: shapeListeners(own), ...(delegated.length ? { delegated } : {}) };
}

export async function handleInspectElement(params) {
  requireTarget(params);
  const { tabId, ref, selector, properties, include = ['styles', 'rules', 'listeners'] } = params;
  await resolveTab(tabId);
  const want = new Set(include);
  const fb = getFallback(tabId, ref);
  const page = await execDom(tabId, pageInspect, [ref ?? null, selector ?? null, fb, properties ?? null, KEY_STYLES]);
  if (!page || page.error) return { success: false, error: goneError(ref, selector, page?.error) };
  const out = { success: true, element: page.element, ...(want.has('styles') ? { styles: page.styles } : {}) };
  if (!want.has('rules') && !want.has('listeners')) return out;

  // Same element, located for CDP by its structural path (closed shadow roots and same-origin frames included).
  const target = await execDom(tabId, pathOfTarget, [ref ?? null, selector ?? null, fb, null]);
  if (!target || target.error) return { success: false, error: goneError(ref, selector, target?.error) };
  const cdp = await withCdp(tabId, async (send) => {
    try {
      const { root } = await send('DOM.getDocument', { depth: -1, pierce: true });
      const found = nodesAtPath(root, target.path, target.tag);
      if (!found) return null;
      return {
        ...(want.has('rules') ? await matchedRules(tabId, send, found) : {}),
        ...(want.has('listeners') ? await listenersOf(send, found) : {}),
      };
    } finally {
      send('Runtime.releaseObjectGroup', { objectGroup: OBJECT_GROUP }).catch(() => {});
      send('DOM.disable').catch(() => {}); // no DOM event traffic for the rest of the session
    }
  });
  if (!cdp) return { success: false, error: 'The element changed while it was being inspected — try again.' };
  return { ...out, ...cdp };
}
