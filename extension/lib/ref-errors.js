/**
 * The one wording of a stale or unknown ref, shared by every ref tool. Handlers
 * return the bare code (REF_GONE) from the page; the extension side turns it into
 * this message, so no tool words it differently.
 *
 * `known` is the fallback descriptor the ref was issued with, when the extension
 * still holds it (fallbackByTab). Known but gone: REF_GONE (the element was
 * re-rendered, virtualized or navigated away). Never issued here (mistyped, or
 * from an old snapshot): REF_NOT_FOUND.
 */
export function refErrorMessage(ref, known) {
  return known
    ? `REF_GONE: ref ${ref} is no longer on the page (re-rendered, virtualized or navigated). Take a new browser_snapshot.`
    : `REF_NOT_FOUND: ref ${ref} is not on this page (mistyped, or from an older snapshot). Take a new browser_snapshot.`;
}

/**
 * A CSS selector that matches nothing on the page: a plain not-found message, not
 * a ref code (the selector is the agent's own text, there is no ref to refresh).
 */
export function selectorErrorMessage(selector, url) {
  return `No element matches selector ${selector} on the current page (${url || 'navigated?'}).`;
}
