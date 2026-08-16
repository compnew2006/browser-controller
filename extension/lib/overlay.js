/**
 * Page overlays (extracted from background.js): the transient per-action
 * badge overlay and the lock shield shown for a tab lock's lifetime.
 */

export async function showOverlay(tabId, label) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: (lbl) => {
        let el = document.getElementById('__bc-overlay');
        if (!el) {
          el = document.createElement('div');
          el.id = '__bc-overlay';
          el.style.cssText =
            'position:fixed;top:12px;right:12px;background:linear-gradient(135deg,#667eea,#764ba2);color:#fff;' +
            'padding:6px 14px;border-radius:16px;font:500 13px system-ui,sans-serif;z-index:2147483647;' +
            'display:flex;align-items:center;gap:6px;box-shadow:0 4px 12px rgba(0,0,0,.15);' +
            'animation:rbIn .2s ease-out';
          const s = document.createElement('style');
          s.textContent = '@keyframes rbIn{from{transform:translateX(80px);opacity:0}to{transform:none;opacity:1}}';
          document.head.appendChild(s);
          document.body.appendChild(el);
        }
        el.textContent = lbl;
      },
      args: [label],
    });
  } catch {}
}

export async function hideOverlay(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: () => document.getElementById('__bc-overlay')?.remove(),
    });
  } catch {}
}

// Lock-shield: a full-viewport transparent input-capture layer + a blue inner
// frame, shown for the lifetime of a tab lock (not the transient per-action
// badge above). It blocks REAL user input on the top frame; the agent's own
// synthetic events bypass hit-testing by construction (handleClick / handleType
// dispatch directly on the resolved element). See specs/tab-control-lock/.
export async function showLockShield(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        let el = document.getElementById('__bc-lock-shield');
        if (el) return; // idempotent — no stacked duplicates
        el = document.createElement('div');
        el.id = '__bc-lock-shield';
        el.style.cssText =
          'position:fixed;inset:0;z-index:2147483647;pointer-events:auto;' +
          'background:transparent;box-shadow:inset 0 0 0 4px #2563eb;';
        const block = (e) => {
          // Agent's own synthetic events (handleType/handlePressKey dispatch
          // KeyboardEvent directly on the target) have isTrusted===false and
          // MUST pass through — otherwise the capture-phase document listener
          // would swallow them before they reach the input, breaking typing on
          // locked tabs. Real user input is isTrusted===true (DOM invariant,
          // unforgeable) and gets blocked. (Fix-loop 3: audit C2.)
          if (e.isTrusted === false) return;
          e.preventDefault();
          e.stopImmediatePropagation();
        };
        // Mouse/pointer listeners attach to `el` (the overlay is the top-most
        // hit-target for pointer events, so capture listeners on `el` fire).
        for (const type of ['pointerdown', 'click', 'mousedown', 'mouseup', 'contextmenu']) {
          el.addEventListener(type, block, { capture: true });
        }
        // Keyboard/wheel/focus listeners attach to `document` instead: these
        // events target elements INSIDE <body> (e.g. document.activeElement),
        // and `el` is a SIBLING of <body> under <html> — NOT an ancestor — so a
        // capture-phase listener on `el` would never be on the propagation path.
        // `document` IS an ancestor of everything in <body>, so capture listeners
        // there fire site-wide. wheel/keydown/keyup need passive:false so
        // preventDefault() is honored.
        const docTypes = ['keydown', 'keyup', 'focus', 'wheel'];
        for (const type of docTypes) {
          const opts = type === 'wheel' || type === 'keydown' || type === 'keyup'
            ? { capture: true, passive: false }
            : { capture: true };
          document.addEventListener(type, block, opts);
        }
        // Stash the handler + types on `el` so hideLockShield can detach the
        // document-level listeners before removing `el` (el.remove() does NOT
        // auto-remove listeners bound to `document` — they would leak + keep
        // blocking keyboard/wheel/focus on the tab after unlock).
        el.__bcShieldDocListeners = { fn: block, types: docTypes };
        // document.documentElement exists even before <body> (early injection).
        document.documentElement.appendChild(el);
      },
    });
  } catch {} // swallow chrome:// / closed-tab / protected-page errors
}

export async function hideLockShield(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const el = document.getElementById('__bc-lock-shield');
        if (!el) return; // no-op if absent
        // Detach document-level listeners (mouse/pointer listeners on `el`
        // auto-remove with the element; document listeners do NOT, so detach
        // them explicitly to avoid leaking keyboard/wheel/focus blocks).
        const bound = el.__bcShieldDocListeners;
        if (bound && typeof bound.fn === 'function' && Array.isArray(bound.types)) {
          for (const type of bound.types) {
            const opts = type === 'wheel' || type === 'keydown' || type === 'keyup'
              ? { capture: true, passive: false }
              : { capture: true };
            document.removeEventListener(type, bound.fn, opts);
          }
          el.__bcShieldDocListeners = null;
        }
        el.remove();
      },
    });
  } catch {}
}
