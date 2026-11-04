/**
 * Page overlays (extracted from background.js). The lock shield is a
 * translucent full-viewport input-capture layer with a blue inner frame. The
 * router blocks user input only while an agent tool call runs on a tab. When
 * the cursor is enabled, the frame remains as a visual cue during the control
 * linger, without its input-blocking listeners. A tab lock draws no frame alone.
 * The agent cursor (drawn by the shared page runtime, lib/page-dom.js) is opt-in
 * (popup setting, see agentCursorEnabled) and only needs hiding from screenshots.
 */

/** chrome.storage.local key of the popup's "Show agent cursor" switch. */
export const AGENT_CURSOR_KEY = 'agentCursor';

/**
 * The agent cursor is opt-in (popup → Settings): its glide holds mouse
 * actions up to 650 ms on a visible tab. Read per action, so the switch applies
 * at once; off when the setting can't be read.
 */
export async function agentCursorEnabled() {
  try {
    return (await chrome.storage.local.get(AGENT_CURSOR_KEY))?.[AGENT_CURSOR_KEY] === true;
  } catch {
    return false;
  }
}

// Lock-shield: a full-viewport translucent frame with a blue inner glow. The frame is
// visual only: pointer-events:none keeps it out of hit-testing, so the page
// keeps its own hover state (JS menus stay open while the agent works) and the
// agent's trusted CDP input lands on the page elements directly.
// The USER's input is blocked by capture-phase listeners on `document`, which
// cancel pointer, key and wheel events before any page handler sees them. The
// agent's own synthetic events (isTrusted:false) and its CDP input (isTrusted,
// inside the window lib/trusted-input.js opens with __bcAgentInputUntil) pass
// through. Focus events are not intercepted: swallowing them broke the page's
// focus handlers. See specs/tab-control-lock/.
// `label` (optional) renders a status badge INSIDE the frame (the router passes
// the agent's name). Returns whether the injection succeeded — on protected pages
// (chrome:// …) it silently never appears, and callers must be able to say so
// instead of reporting a protected lock (audit HIGH #4).
export async function showLockShield(tabId, label, keepCursor = false) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: (lbl, cursorActive) => {
        let el = document.getElementById('__bc-lock-shield');
        // An idle visual frame has no input listeners; replace it with a fresh
        // active shield so the next call gets its own blocking lifetime.
        if (el && !el.__bcShieldDocListeners) {
          clearTimeout(el.__bcVisualTimer);
          el.remove();
          el = null;
        }
        if (cursorActive) {
          const cursor = document.getElementById('__bc-agent-cursor');
          if (cursor) {
            clearTimeout(cursor.__bcIdle);
            cursor.style.opacity = '1';
          }
        }
        if (!el) {
          el = document.createElement('div');
          el.id = '__bc-lock-shield';
          // Blue spectrum fading from the viewport edges toward the center
          // Narrow edge bands keep the control cue visible without covering
          // much of the page; the inset glow follows the same scale.
          el.style.cssText =
            'position:fixed;inset:0;z-index:2147483647;pointer-events:none;' +
            'background:' +
              'linear-gradient(to right,  rgba(37,99,235,.48) 0%, transparent 4%),' +
              'linear-gradient(to left,   rgba(37,99,235,.48) 0%, transparent 4%),' +
              'linear-gradient(to bottom,rgba(37,99,235,.48) 0%, transparent 5%),' +
              'linear-gradient(to top,    rgba(37,99,235,.48) 0%, transparent 5%);' +
            'box-shadow:inset 0 0 35px 7.5px rgba(37,99,235,.25);';
          const block = (e) => {
            // Synthetic events (isTrusted===false, dispatched by a page script such
            // as browser_evaluate) MUST pass through — otherwise the capture-phase
            // document listener would swallow them before they reach the page.
            // Real user input is isTrusted===true (DOM invariant, unforgeable) and
            // gets blocked. (Fix-loop 3: audit C2.)
            if (e.isTrusted === false) return;
            // The agent's own CDP input (trusted-input.js) is isTrusted===true
            // too: it opens a short pass-through window around each action.
            if (window.__bcAgentInputUntil > Date.now()) return;
            // The owner answers a vault approval card even while an agent call runs (specs/006).
            // The mark is set in this isolated world, so a page element cannot claim it.
            if (typeof e.composedPath === 'function' && e.composedPath().some((node) => node && node.__bcVaultHost === true)) return;
            e.preventDefault();
            e.stopImmediatePropagation();
          };
          // Every listener sits on `document` in the capture phase. The frame
          // never receives events itself (pointer-events:none), and `document`
          // is an ancestor of everything in <body>, so these fire site-wide.
          // The `el` node is a sibling of <body> under <html>, so listeners on
          // it would never be on the propagation path of page events.
          const pointerTypes = ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click', 'dblclick', 'auxclick', 'contextmenu'];
          const keyWheelTypes = ['keydown', 'keyup', 'wheel'];
          for (const type of pointerTypes) document.addEventListener(type, block, { capture: true });
          // wheel/keydown/keyup need passive:false so preventDefault() is honored.
          for (const type of keyWheelTypes) document.addEventListener(type, block, { capture: true, passive: false });
          // Stash the handler + types on `el` so hideLockShield can detach them
          // before removing `el` (el.remove() does NOT auto-remove listeners
          // bound to `document` — they would keep blocking input after unlock).
          el.__bcShieldDocListeners = { fn: block, types: [...pointerTypes, ...keyWheelTypes] };
          // document.documentElement exists even before <body> (early injection).
          document.documentElement.appendChild(el);
        }
        // Status label inside the frame (the old corner badge, folded into the
        // shield so agent control shows ONE element: the blue frame). Passing
        // no label clears it, leaving the bare frame.
        let badge = el.querySelector('.__bc-shield-label');
        if (lbl) {
          if (!badge) {
            badge = document.createElement('div');
            badge.className = '__bc-shield-label';
            badge.style.cssText =
              'position:fixed;top:12px;right:12px;background:linear-gradient(135deg,#667eea,#764ba2);color:#fff;' +
              'padding:6px 14px;border-radius:16px;font:500 13px system-ui,sans-serif;' +
              'box-shadow:0 4px 12px rgba(0,0,0,.15);pointer-events:none;';
            el.appendChild(badge);
          }
          badge.textContent = lbl;
          // Self-expiry: if the service worker dies mid-action, nothing ever
          // runs the hide step and this badge would stick forever on a tab the
          // agent is no longer touching (seen live in production use). The
          // page self-heals — a label not refreshed within 60s removes
          // itself. The FRAME's lifetime is the call's (router).
          clearTimeout(window.__bcShieldBadgeTimer);
          window.__bcShieldBadgeTimer = setTimeout(() => badge.remove(), 60000);
        } else if (badge) {
          clearTimeout(window.__bcShieldBadgeTimer);
          badge.remove();
        }
      },
      args: keepCursor ? [label ?? null, true] : [label ?? null],
    });
    return Array.isArray(results);
  } catch {
    return false; // protected page / closed tab — caller decides how to report
  }
}

export async function hideLockShield(tabId, lingerMs = 0) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: (linger) => {
        const el = document.getElementById('__bc-lock-shield');
        if (!el) return; // no-op if absent
        clearTimeout(el.__bcVisualTimer);
        // Detach the input-blocking listeners (all of them sit on `document`,
        // and removing `el` does not remove those, so detach them explicitly
        // to avoid leaking pointer/keyboard/wheel blocks after unlock).
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
        if (linger) {
          // Keep only the visual cue while the agent is thinking. The capture
          // listeners have already been detached, so the owner can use the page.
          if (linger > 0) el.__bcVisualTimer = setTimeout(() => el.remove(), linger);
          const cursor = document.getElementById('__bc-agent-cursor');
          if (cursor) {
            clearTimeout(cursor.__bcIdle);
            if (linger > 0) cursor.__bcIdle = setTimeout(() => { cursor.style.opacity = '0'; }, linger);
          }
        } else {
          el.remove();
        }
      },
      ...(lingerMs !== 0 ? { args: [lingerMs] } : {}),
    });
  } catch {}
}

/** Temporarily hide the visual frame during screenshots without changing input protection. */
export async function setLockShieldHidden(tabId, hidden) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: (hide) => {
        const frame = document.getElementById('__bc-lock-shield');
        if (frame) frame.style.display = hide ? 'none' : '';
      },
      args: [hidden],
    });
  } catch {}
}

/** Remove the pointer when its controlling session or tab lock is released. */
export async function clearAgentCursor(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const cursor = document.getElementById('__bc-agent-cursor');
        if (cursor) {
          clearTimeout(cursor.__bcIdle);
          cursor.remove();
        }
      },
    });
  } catch {}
}

/**
 * Hide or restore the agent cursor (lib/page-dom.js) around a screenshot, so
 * it never covers what the agent is looking at. Cosmetic: never throws, and
 * bounded so a page that stops answering can't hold the screenshot hostage.
 */
export async function setAgentCursorHidden(tabId, hidden) {
  let timer;
  const toggle = (async () => {
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        func: (h) => {
          // display, not visibility: the cursor's parts reset inherited styles.
          const el = document.getElementById('__bc-agent-cursor');
          if (el) el.style.display = h ? 'none' : 'block';
        },
        args: [hidden],
      });
    } catch {}
  })();
  await Promise.race([toggle, new Promise((r) => { timer = setTimeout(r, 1000); })]);
  clearTimeout(timer);
}
