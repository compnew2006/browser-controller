/**
 * Resource-type names shared by browser_network (filter) and browser_intercept
 * (rule conditions). Both APIs spell types the webRequest / declarativeNetRequest
 * way ("xmlhttprequest", "main_frame"); agents may also say "xhr", "fetch", "document".
 * Pure: no chrome global, so the handlers and tests import it freely.
 */

export const RESOURCE_TYPES = [
  'main_frame', 'sub_frame', 'stylesheet', 'script', 'image', 'font', 'object', 'xmlhttprequest',
  'ping', 'csp_report', 'media', 'websocket', 'webtransport', 'webbundle', 'other',
];

/** Friendly names -> the real type(s). fetch() is reported as xmlhttprequest by Chrome. */
export const TYPE_ALIASES = {
  xhr: ['xmlhttprequest'], fetch: ['xmlhttprequest'], document: ['main_frame', 'sub_frame'],
  frame: ['sub_frame'], css: ['stylesheet'], js: ['script'], img: ['image'],
};

/** Expand a type name or list (aliases allowed) to deduplicated real types; throws on an unknown name. */
export function resolveTypes(type) {
  const wanted = new Set();
  for (const raw of Array.isArray(type) ? type : [type]) {
    const t = String(raw).toLowerCase();
    if (Object.hasOwn(TYPE_ALIASES, t)) TYPE_ALIASES[t].forEach((x) => wanted.add(x));
    else if (RESOURCE_TYPES.includes(t)) wanted.add(t);
    else throw new Error(`Unknown resource type "${raw}". Use ${[...Object.keys(TYPE_ALIASES), ...RESOURCE_TYPES].join(', ')}.`);
  }
  return [...wanted];
}
