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
export function refErrorMessage(ref, known, earlier = false) {
  // Issued by an earlier page of the tab (a navigation or reload since): the agent must not look for it here.
  if (earlier) return `REF_GONE: ref ${ref} is from an earlier page (the page navigated or reloaded). Take a new browser_snapshot.`;
  return known
    ? `REF_GONE: ref ${ref} is no longer on the page (re-rendered, virtualized or navigated). Take a new browser_snapshot.`
    : `REF_NOT_FOUND: ref ${ref} is not on this page (mistyped, or from an older snapshot). Take a new browser_snapshot.`;
}

/**
 * The note a reply carries when a stale ref was re-found by its snapshot descriptor
 * (the page changed under it, the ref still means the same element).
 */
export function reboundNote(ref) {
  return `note: ${ref} was re-found after the page changed`;
}

/**
 * The highest ref number a page result shows the agent: the refs of a snapshot and
 * the candidates of an AMBIGUOUS reply (the only two places refs are issued and
 * shown). 0 when the result shows none. The service worker keeps the tab's maximum
 * so a new document starts its counter above every ref an earlier one showed.
 */
export function highestRefIn(res) {
  let max = 0;
  if (res && Array.isArray(res.refs)) {
    for (const r of res.refs) {
      const m = /^e(\d+)$/.exec(String(r && r.ref || ''));
      if (m) max = Math.max(max, Number(m[1]));
    }
  }
  if (res && typeof res.error === 'string' && res.error.startsWith('AMBIGUOUS')) {
    for (const m of res.error.matchAll(/\be(\d+) "/g)) max = Math.max(max, Number(m[1]));
  }
  return max;
}
