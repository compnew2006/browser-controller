/** browser_wait's page side (moved out of handlers/inspection.js to keep that module under the size gate). */
/** Page side of browser_wait: one poll of the condition. Self-contained (serialized into the page). */
export function waitPage(_t, _fb, _gone, _urlText, _urlRe) {
  if (_t == null) {
    const href = location.href;
    return { met: _urlRe != null ? new RegExp(_urlRe).test(href) : href.includes(_urlText) };
  }
  const D = globalThis.__bcDom;
  if (!D || !D.resolveTarget) return { __needDom: true };
  const r = D.resolveTarget(_t, _fb);
  if (r.error && /^INVALID_SELECTOR/.test(r.error)) return { error: r.error };
  // A ref this tab never issued cannot appear: a miss is an error in both modes, not "gone".
  if (r.error === 'REF_GONE' && !r.issued) return { error: 'REF_GONE', ref: r.ref, issued: false };
  // AMBIGUOUS means several visible matches: the target is there.
  let visible = !!r.error && /^AMBIGUOUS/.test(r.error);
  if (!r.error && r.el) visible = D.isVisible(r.el);
  return {
    met: _gone ? !visible : visible,
    // An issued ref whose element left: `gone` is met; visible keeps polling (the fallback may re-find it).
    refGone: r.error === 'REF_GONE',
    // A ref re-found by its snapshot descriptor: the reply says so.
    rebound: r.via === 'fallback' ? _t.ref : null,
    // Why the target is not visible, for the TIMEOUT text: a selector matching nothing is a wrong selector.
    miss: r.error && /^(NOT_FOUND|ELEMENT_HIDDEN)/.test(r.error) ? r.error.split(':')[0] : null,
  };
}
