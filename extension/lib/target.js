/**
 * The one target locator contract of Browser Controller 3.0 (contract principle 2).
 * Pure: no chrome global, so the service worker and the tests share it. The page
 * side resolves the parsed object (lib/page-dom.js resolveTarget).
 *
 *   "x,y"           viewport point in CSS px      → { kind:'point', x, y }
 *   "text=<words>"  visible element by name/text   → { kind:'text', text }
 *   {role,name,nth?} exact accessible role/name      → { kind:'role', role, name, nth? }
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
  if (target && typeof target === 'object' && !Array.isArray(target)) {
    const keys = Object.keys(target);
    if (keys.some((key) => !['role', 'name', 'nth'].includes(key))) {
      throw new Error('INVALID_ARGUMENT: structured target only accepts role, name and nth');
    }
    if (typeof target.role !== 'string' || !target.role.trim() || target.role.trim().length > 80) {
      throw new Error('INVALID_ARGUMENT: structured target role must be non-empty and at most 80 characters');
    }
    if (typeof target.name !== 'string' || !target.name.trim() || target.name.trim().length > 500) {
      throw new Error('INVALID_ARGUMENT: structured target name must be non-empty and at most 500 characters');
    }
    if (target.nth !== undefined && (!Number.isSafeInteger(target.nth) || target.nth < 0)) {
      throw new Error('INVALID_ARGUMENT: structured target nth must be a non-negative integer');
    }
    const parsed = {
      kind: 'role',
      role: target.role.trim().toLowerCase(),
      name: target.name.replace(/\s+/g, ' ').trim(),
    };
    if (target.nth !== undefined) parsed.nth = target.nth;
    return parsed;
  }
  if (target == null || (typeof target === 'string' && target.trim() === '')) throw new Error('INVALID_ARGUMENT: target is empty');
  if (typeof target !== 'string') throw new Error('INVALID_ARGUMENT: target must be a string or {role, name, nth?}');
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

/** Human-readable locator label for action receipts and errors. */
export function targetLabel(target) {
  if (typeof target === 'string') return target;
  if (target && typeof target === 'object' && !Array.isArray(target)) {
    const parsed = parseTarget(target);
    return `role=${parsed.role} name=${JSON.stringify(parsed.name)}${parsed.nth === undefined ? '' : ` nth=${parsed.nth}`}`;
  }
  return String(target ?? '(no target)');
}
