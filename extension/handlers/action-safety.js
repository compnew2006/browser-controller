/**
 * Read-only preflight for the MCP session's optional action-safety policy.
 * Only action kind and target metadata cross back to the server; field values
 * and selected file paths are deliberately not inspected or returned.
 */
import { resolveTab, execDom, getFallback } from '../lib/page-exec.js';
import { parseTarget } from '../lib/target.js';

const ACTIONS = new Set(['browser_click', 'browser_type', 'browser_fill', 'browser_evaluate']);
const ENTER_KEY = /(?:^|\s|\+)enter(?:$|\s)/i;

/** Page side. This returns risk categories, never the page's label or field value. */
function pageActionCategories(_targets, _action, _submit, _key, _drag) {
  const D = globalThis.__bcDom;
  if (!D || !D.resolveTarget || !D.safetyFingerprint) return { __needDom: true };
  // Defined here, not at module level: chrome.scripting serializes this function alone.
  const DELETE_INTENT = /\b(delete|remove|destroy|erase|revoke|unsubscribe|cancel\s+(?:plan|account|subscription))\b/i;
  const SUBMIT_INTENT = /\b(submit|save|send|confirm|apply|place\s+order|checkout|pay|purchase|sign\s+in|log\s+in|register)\b/i;
  const ENTER_KEY = /(?:^|\s|\+)enter(?:$|\s)/i;
  const categories = new Set();
  const fingerprints = [];

  const focusedElement = () => {
    let active = document.activeElement;
    for (let depth = 0; active && depth < 10; depth++) {
      if (active.shadowRoot?.activeElement) { active = active.shadowRoot.activeElement; continue; }
      if (active.tagName === 'IFRAME' || active.tagName === 'FRAME') {
        try { if (active.contentDocument?.activeElement) { active = active.contentDocument.activeElement; continue; } } catch {}
      }
      break;
    }
    return active;
  };

  if (_action === 'browser_type' && (_submit || ENTER_KEY.test(String(_key || '')))) categories.add('submit');
  if (_action === 'browser_click' && _drag) categories.add('unknown');

  for (const item of _targets) {
    const resolved = item.focused ? { el: focusedElement() } : D.resolveTarget(item.target, item.fallback);
    if (resolved.error) return { error: resolved.error };
    const el = resolved.el;
    if (!el) {
      if (_action === 'browser_click') {
        categories.add('unknown');
        if (resolved.point) fingerprints.push(`point:${resolved.point.x},${resolved.point.y}`);
      }
      continue;
    }
    const tag = String(el.tagName || '').toLowerCase();
    const type = String(el.type || D.attr(el, 'type') || '').toLowerCase();
    const role = String(D.roleOf(el) || '').toLowerCase();
    fingerprints.push(D.safetyFingerprint(el));
    if (tag === 'input' && type === 'file') categories.add('upload');

    if (_action === 'browser_click') {
      const form = el.form || el.closest?.('form') || null;
      if ((tag === 'input' && ['submit', 'image'].includes(type))
        || (tag === 'button' && (type === 'submit' || (!D.attr(el, 'type') && !!form)))) {
        categories.add('submit');
      }

      const intent = [
        D.nameOf(el), el.textContent, D.attr(el, 'aria-label'), D.attr(el, 'title'),
        D.attr(el, 'id'), D.attr(el, 'name'), D.attr(el, 'class'), D.attr(el, 'data-action'),
        D.attr(el, 'formaction'), el.href, form?.action, form?.method,
      ].filter(Boolean).join(' ').replace(/\s+/g, ' ').slice(0, 1200);
      if (DELETE_INTENT.test(intent)) categories.add('delete');
      if (SUBMIT_INTENT.test(intent)) categories.add('submit');
      if (role === 'button' && !form && !intent.trim()) categories.add('unknown');
    }
  }
  return { categories: [...categories], fingerprints };
}

/** Internal wire action; not exposed as an MCP tool. */
export async function handleClassifyAction(params) {
  const { tabId, action, target, fields = [], submit = false, key, dragTo, hover = false } = params || {};
  if (!Number.isInteger(tabId) || !ACTIONS.has(action)) throw new Error('INVALID_ARGUMENT: invalid safety classification request');
  const tab = await resolveTab(tabId);
  let categories = [];
  let fingerprints = [];

  // Page JS cannot be classified: evaluate reports the site only, with no target and no page probe.
  if (!hover && action !== 'browser_evaluate') {
    if (action === 'browser_type' && (submit === true || ENTER_KEY.test(String(key || '')))) categories.push('submit');
    const targetValues = action === 'browser_fill'
      ? (Array.isArray(fields) ? fields.slice(0, 50).map((field) => field?.target) : [])
      : (target !== undefined ? [target] : []);
    if (action === 'browser_type' && targetValues.length === 0 && categories.includes('submit')) {
      const result = await execDom(tabId, pageActionCategories, [[{ focused: true }], action, false, null, false]);
      if (!result || result.__needDom || result.error) throw new Error(result?.error || 'the page could not be inspected');
      fingerprints = Array.isArray(result.fingerprints) ? result.fingerprints : [];
    }
    const parsedClickTarget = action === 'browser_click' && target !== undefined ? parseTarget(target) : null;
    if (action === 'browser_click' && (parsedClickTarget?.kind === 'point' || dragTo != null)) {
      categories.push('unknown');
    } else if (targetValues.length) {
      const targets = targetValues.map((value) => {
        const parsed = parseTarget(value);
        return { target: parsed, fallback: parsed.kind === 'ref' ? getFallback(tabId, parsed.ref) : null };
      });
      const result = await execDom(tabId, pageActionCategories, [targets, action, false, null, false]);
      if (result?.error) throw new Error(result.error);
      if (!result || result.__needDom) throw new Error('the page could not be inspected');
      categories.push(...(Array.isArray(result.categories) ? result.categories : []));
      if (Array.isArray(result.fingerprints)) fingerprints = result.fingerprints;
    }
  }

  // ENTER and submit are known from the tool request; the page probe only handles its target.
  if (action === 'browser_type' && (submit === true || ENTER_KEY.test(String(key || '')))) categories.push('submit');
  const unique = [...new Set(categories)];
  return {
    success: true,
    site: (() => { try { return new URL(tab.url || 'about:blank').hostname; } catch { return ''; } })(),
    categories: unique,
    fingerprints,
  };
}
