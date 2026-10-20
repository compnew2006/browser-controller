/**
 * browser_inspect_element: why an element looks and behaves the way it does.
 * Its computed styles that differ from the defaults (page side, no debugger); with
 * `rules`, the CSS rules that match it, with the source line and what lost the
 * cascade; with `listeners`, the event listeners on it and on its ancestors, with
 * the script URL and line (CDP). Shaping and text live in lib/inspect-element.js.
 */
import { resolveTab, execDom, getFallback } from '../lib/page-exec.js';
import { withCdp, subscribeCdpEvents } from '../lib/cdp-session.js';
import { parseTarget } from '../lib/target.js';
import { refErrorMessage, reboundNote } from '../lib/ref-errors.js';
import {
  KEY_STYLES, pageInspect, nodesAtPath, describeNode, shapeMatchedStyles, shapeListeners,
  formatStyles, formatRules, formatListeners, renderInspect,
} from '../lib/inspect-element.js';

const OBJECT_GROUP = 'bc-inspect';
const MAX_ANCESTORS = 25;
/** Options 2.x took that 3.0 replaced by target / removed: refused, never answered with a different element. */
const REMOVED_OPTIONS = ['ref', 'selector', 'include'];

function coded(code, message) {
  const err = new Error(`${code}: ${message}`);
  err.code = code;
  return err;
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

async function listenersOf(tabId, send, found) {
  // A listener names its script by id; Debugger.scriptParsed (sent when the domain is enabled) gives the URL.
  const scripts = new Map();
  const off = subscribeCdpEvents(tabId, (method, p) => {
    if (method === 'Debugger.scriptParsed') scripts.set(p.scriptId, p.url || '');
  });
  try {
    await send('Debugger.enable');
    // A `debugger;` statement in the page must not freeze it while it is inspected.
    await send('Debugger.setSkipAllPauses', { skip: true });
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
    return {
      own: shapeListeners(own, scripts),
      // An entry that cannot name its ancestor is dropped rather than shown unlabelled.
      delegated: chain.filter((c) => c.on && c.listeners.length).flatMap((c) => shapeListeners(c.listeners, scripts, c.on)),
    };
  } finally {
    off();
    send('Debugger.setSkipAllPauses', { skip: false }).catch(() => {});
    send('Debugger.disable').catch(() => {});
  }
}

/**
 * A CDP error once the debugger is attached, worded by what it says: a node the page no
 * longer has is NOT_FOUND, a session that went away is DEBUGGER_UNAVAILABLE, anything else
 * INSPECT_FAILED with the protocol's message.
 */
function inspectCdpFailure(err) {
  const msg = String(err?.message || err).replace(/\s+/g, ' ').trim().slice(0, 200);
  if (/No node with given id|Could not find node|does not belong to the document|No object with given id/i.test(msg)) {
    return coded('NOT_FOUND', 'the element changed while it was being inspected; try again.');
  }
  if (/detach|Target closed|Inspected target|not attached/i.test(msg)) return coded('DEBUGGER_UNAVAILABLE', msg);
  return coded('INSPECT_FAILED', msg);
}

/**
 * The CDP reads for the element at `path` (pageInspect's path): rules and/or listeners; null when the DOM moved on.
 * A debugger that cannot attach is DEBUGGER_UNAVAILABLE; once attached, a failing read is worded by inspectCdpFailure.
 */
async function debuggerInspect(tabId, path, want) {
  let attached = false;
  try {
    return await withCdp(tabId, async (send) => {
      attached = true;
      try {
        // Same element, located for CDP by its structural path (closed shadow roots and same-origin frames included).
        const { root } = await send('DOM.getDocument', { depth: -1, pierce: true });
        const found = nodesAtPath(root, path.path, path.tag);
        if (!found) return null;
        return {
          ...(want.rules ? { rules: await matchedRules(tabId, send, found) } : {}),
          ...(want.listeners ? { listeners: await listenersOf(tabId, send, found) } : {}),
        };
      } catch (err) {
        throw inspectCdpFailure(err);
      } finally {
        send('Runtime.releaseObjectGroup', { objectGroup: OBJECT_GROUP }).catch(() => {});
        send('DOM.disable').catch(() => {}); // no DOM event traffic for the rest of the session
      }
    });
  } catch (err) {
    if (attached) throw err;
    throw coded('DEBUGGER_UNAVAILABLE', String(err?.message || err).slice(0, 200));
  }
}

export async function handleInspectElement(params) {
  for (const name of REMOVED_OPTIONS) {
    if (params[name] !== undefined && params[name] !== null) {
      throw coded('INVALID_ARGUMENT', `${name} is not a browser_inspect_element option in 3.0. Use target (a ref, text=<words>, x,y or a CSS selector).`);
    }
  }
  if (params.target == null) throw coded('INVALID_ARGUMENT', 'target is required: a ref from browser_snapshot, text=<words>, x,y or a CSS selector.');
  const parsed = parseTarget(params.target);
  const { tabId, rules = false, listeners = false } = params;
  const properties = params.properties?.length ? params.properties : null;
  await resolveTab(tabId);
  const fb = parsed.kind === 'ref' ? getFallback(tabId, parsed.ref) : null;
  const page = await execDom(tabId, pageInspect, [parsed, fb, properties, KEY_STYLES]);
  if (!page || page.error) {
    // The page says whether the ref was issued in this tab (REF_GONE) or never (REF_NOT_FOUND).
    if (page?.error === 'REF_GONE') throw new Error(refErrorMessage(parsed.ref, !!page.issued, !!page.earlier));
    throw new Error(page?.error || 'NOT_FOUND: no element for that target.');
  }

  // Styles are the default view; `properties`, `rules` and `listeners` each ask for a section (no flag: styles).
  const sections = [];
  if (properties || (!rules && !listeners)) {
    sections.push({ title: 'styles', lines: formatStyles(page.styles, !!properties?.includes('*')) });
  }
  if (rules || listeners) {
    if (!page.path) throw coded('NOT_FOUND', 'the element changed while it was being inspected; try again.');
    const cdp = await debuggerInspect(tabId, page.path, { rules, listeners });
    if (!cdp) throw coded('NOT_FOUND', 'the element changed while it was being inspected; try again.');
    if (rules) {
      const f = formatRules(cdp.rules);
      sections.push({ title: 'rules', lines: f.rules });
      if (f.inherited.length) sections.push({ title: 'inherited', lines: f.inherited });
      if (f.pseudo.length) sections.push({ title: 'pseudo', lines: f.pseudo });
    }
    if (listeners) sections.push({ title: 'listeners', lines: formatListeners(cdp.listeners) });
  }
  // A ref re-found by its snapshot descriptor: the reply says so, on its own line at the end.
  const notes = page.rebound ? [reboundNote(page.rebound)] : [];
  return { success: true, text: [renderInspect(page.element, sections), ...notes].join('\n') };
}
