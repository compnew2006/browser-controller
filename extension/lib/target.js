/**
 * The one `target` locator string of Browser Controller 3.0 (contract principle 2).
 * Pure: no chrome global, so the service worker and the tests share it. The page
 * side resolves the parsed object (lib/page-dom.js resolveTarget).
 *
 *   "x,y"           viewport point in CSS px      → { kind:'point', x, y }
 *   "text=<words>"  visible element by name/text   → { kind:'text', text }
 *   "<ref>"         snapshot ref (e12)            → { kind:'ref', ref }
 *   anything else   CSS selector                   → { kind:'selector', selector }
 *
 * Refs are `e<n>` only (3.0). A name with a hyphen, like the custom element "x-1",
 * is a CSS selector.
 */

const POINT = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/;
const REF = /^e\d+$/;
const TEXT_PREFIX = 'text=';

export function parseTarget(target) {
  if (target == null || String(target).trim() === '') throw new Error('INVALID_ARGUMENT: target is empty');
  if (typeof target !== 'string') throw new Error('INVALID_ARGUMENT: target must be a string');
  const s = target.trim();
  const point = POINT.exec(s);
  if (point) return { kind: 'point', x: Number(point[1]), y: Number(point[2]) };
  if (s.startsWith(TEXT_PREFIX)) {
    const text = s.slice(TEXT_PREFIX.length).replace(/\s+/g, ' ').trim();
    if (!text) throw new Error('INVALID_ARGUMENT: text= needs words, e.g. text=Sign in');
    return { kind: 'text', text };
  }
  if (REF.test(s)) return { kind: 'ref', ref: s };
  return { kind: 'selector', selector: s };
}
