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
export const AGENT_MOUSE_MOVEMENT_LOCK_KEY = 'agentMouseMovementLock';

const activeShields = new Map();
const activeShieldAliases = new Map();
const AGENT_INPUT_PERMIT_MS = 500;
let nextAgentInputPermitId = 0;

function agentInputEventTypes(method, params) {
  if (method === 'Input.dispatchMouseEvent') {
    switch (params?.type) {
      case 'mouseMoved': return ['pointermove', 'mousemove', 'pointerover', 'pointerout', 'pointerenter', 'pointerleave', 'mouseover', 'mouseout', 'mouseenter', 'mouseleave'];
      case 'mousePressed': return ['pointerdown', 'mousedown'];
      case 'mouseReleased': return ['pointerup', 'mouseup', 'click', 'dblclick', 'auxclick', 'contextmenu'];
      case 'mouseWheel': return ['wheel'];
      default: return [];
    }
  }
  if (method === 'Input.dispatchDragEvent') {
    const type = { dragEnter: 'dragenter', dragOver: 'dragover', dragLeave: 'dragleave', dragStart: 'dragstart', drop: 'drop', cancel: 'dragend' }[params?.type];
    return type ? [type] : [];
  }
  if (method === 'Input.dispatchKeyEvent') {
    switch (params?.type) {
      case 'rawKeyDown': return ['keydown'];
      case 'keyDown': return ['keydown', 'keypress', 'beforeinput', 'input'];
      case 'char': return ['keypress', 'beforeinput', 'input'];
      case 'keyUp': return ['keyup'];
      default: return [];
    }
  }
  if (method === 'Input.insertText') return ['beforeinput', 'input'];
  return [];
}

function resolveShieldTabId(tabId) {
  return activeShieldAliases.get(tabId) ?? tabId;
}

async function clearAgentInputPermit(tabId, permitId, { restoreMouseTarget, frameIds = [] }) {
  await chrome.scripting.executeScript({
    target: frameIds.length ? { tabId, frameIds } : { tabId, allFrames: true },
    func: (id, restoreMouse) => {
      if (window.__bcAgentInputPermit?.id !== id) return;
      window.__bcAgentInputPermit = null;
      window.__bcAgentInputUntil = 0;
      clearTimeout(window.__bcAgentPermitTimer);
      const shield = document.getElementById('__bc-lock-shield');
      if (restoreMouse && shield?.__bcBlockMouseMovement) shield.style.pointerEvents = 'auto';
    },
    args: [permitId, restoreMouseTarget],
  });
}

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

/** The optional pointer-movement shield, read once when each tool call starts. */
export async function agentMouseMovementLockEnabled() {
  return (await chrome.storage.local.get(AGENT_MOUSE_MOVEMENT_LOCK_KEY))?.[AGENT_MOUSE_MOVEMENT_LOCK_KEY] === true;
}

function createAgentInputPermit(method, params) {
  const permitId = `${Date.now()}-${++nextAgentInputPermitId}`;
  const mouseDispatch = method === 'Input.dispatchMouseEvent' || method === 'Input.dispatchDragEvent';
  const permit = {
    id: permitId,
    durationMs: AGENT_INPUT_PERMIT_MS,
    eventTypes: agentInputEventTypes(method, params),
    x: Number.isFinite(params?.x) ? params.x : null,
    y: Number.isFinite(params?.y) ? params.y : null,
    allowMouseTarget: mouseDispatch,
  };
  if (!permit.eventTypes.length) throw new Error(`AGENT_INPUT_PERMIT_UNSUPPORTED: ${method} ${String(params?.type ?? '')}`);
  return permit;
}

async function installAgentInputPermit(tabId, permit) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: (incomingPermit) => {
        const until = Date.now() + incomingPermit.durationMs;
        const activePermit = { ...incomingPermit, until };
        window.__bcAgentInputPermit = activePermit;
        window.__bcAgentInputUntil = until;
        clearTimeout(window.__bcAgentPermitTimer);
        window.__bcAgentPermitTimer = setTimeout(() => {
          if (window.__bcAgentInputPermit?.id !== incomingPermit.id) return;
          window.__bcAgentInputPermit = null;
          window.__bcAgentInputUntil = 0;
          const shield = document.getElementById('__bc-lock-shield');
          if (incomingPermit.allowMouseTarget && shield?.__bcBlockMouseMovement) shield.style.pointerEvents = 'auto';
        }, incomingPermit.durationMs);
        const shield = document.getElementById('__bc-lock-shield');
        if (incomingPermit.allowMouseTarget && shield?.__bcBlockMouseMovement) shield.style.pointerEvents = 'none';
      },
      args: [permit],
    });
    if (!Array.isArray(results) || results.length === 0) throw new Error('No frame accepted the input permit.');
    return results.map((result) => result.frameId).filter(Number.isInteger);
  } catch (error) {
    try { await clearAgentInputPermit(tabId, permit.id, { restoreMouseTarget: permit.allowMouseTarget, frameIds: [] }); } catch { /* a partial frame injection may already be gone */ }
    throw new Error(`AGENT_INPUT_PERMIT_FAILED: ${String(error?.message || error)}`, { cause: error });
  }
}

/** Dispatch one CDP input while briefly letting it reach the page through the shield. */
export async function dispatchAgentInput(tabId, send, method, params) {
  const targetTabId = resolveShieldTabId(tabId);
  const shieldState = activeShields.get(targetTabId);
  if (!shieldState?.options.blockMouseMovement) return send(method, params);
  if (!shieldState.readiness || !await shieldState.readiness) {
    throw new Error('AGENT_INPUT_SHIELD_UNAVAILABLE: the movement shield is not installed in the current tab.');
  }

  const permit = createAgentInputPermit(method, params);
  const frameIds = await installAgentInputPermit(targetTabId, permit);

  try {
    return await send(method, params);
  } finally {
    try {
      await clearAgentInputPermit(targetTabId, permit.id, { restoreMouseTarget: permit.allowMouseTarget, frameIds });
    } catch {
      // The page may have navigated or closed while the input was in flight.
    }
  }
}

// Lock-shield: a full-viewport translucent frame with a blue inner glow. The frame is
// normally visual only: pointer-events:none keeps it out of hit-testing, so
// the page keeps its hover state. The optional movement lock switches hit-
// testing on to suppress CSS :hover, and temporarily switches it off for one
// trusted agent CDP dispatch.
// The USER's input is blocked by capture-phase listeners on `document`, which
// cancel pointer, key and wheel events before any page handler sees them. The
// agent's own synthetic events (isTrusted:false) and its CDP input pass through.
// Focus events are not intercepted: swallowing them broke the page's
// focus handlers. See specs/tab-control-lock/.
// `label` (optional) renders a status badge INSIDE the frame (the router passes
// the agent's name). Returns whether the injection succeeded — on protected pages
// (chrome:// …) it silently never appears, and callers must be able to say so
// instead of reporting a protected lock (audit HIGH #4).
async function injectLockShield(tabId, options, frameId = null) {
  try {
    const results = await chrome.scripting.executeScript({
      target: frameId != null
        ? { tabId, frameIds: [frameId] }
        : options.blockMouseMovement ? { tabId, allFrames: true } : { tabId },
      func: (lbl, cursorActive, blockMouse) => {
        const isTopFrame = window === window.top;
        const root = document.documentElement;
        const previous = root.__bcShieldDocListeners;
        if (previous && typeof previous.fn === 'function' && Array.isArray(previous.types)) {
          for (const type of previous.types) {
            const opts = type === 'wheel' || type === 'keydown' || type === 'keyup'
              ? { capture: true, passive: false }
              : { capture: true };
            document.removeEventListener(type, previous.fn, opts);
          }
        }
        root.__bcShieldDocListeners = null;

        let el = isTopFrame ? document.getElementById('__bc-lock-shield') : null;
        // An idle visual frame has no input listeners; replace it with a fresh
        // active shield so this call gets its own blocking lifetime.
        if (el && !previous) {
          clearTimeout(el.__bcVisualTimer);
          el.remove();
          el = null;
        }
        if (isTopFrame && cursorActive) {
          const cursor = document.getElementById('__bc-agent-cursor');
          if (cursor) {
            clearTimeout(cursor.__bcIdle);
            cursor.style.opacity = '1';
          }
        }
        if (isTopFrame && !el) {
          el = document.createElement('div');
          el.id = '__bc-lock-shield';
          el.style.cssText =
            'position:fixed;inset:0;z-index:2147483647;pointer-events:none;' +
            'background:' +
              'linear-gradient(to right,  rgba(37,99,235,.48) 0%, transparent 4%),' +
              'linear-gradient(to left,   rgba(37,99,235,.48) 0%, transparent 4%),' +
              'linear-gradient(to bottom,rgba(37,99,235,.48) 0%, transparent 5%),' +
              'linear-gradient(to top,    rgba(37,99,235,.48) 0%, transparent 5%);' +
            'box-shadow:inset 0 0 35px 7.5px rgba(37,99,235,.25);';
          root.appendChild(el);
        }
        if (el) {
          el.__bcBlockMouseMovement = blockMouse;
          // Hit-testing this transparent frame suppresses page :hover styles as
          // well as mouse events. Agent CDP dispatches briefly pass through it.
          el.style.pointerEvents = blockMouse ? 'auto' : 'none';
        }
        window.__bcMouseMovementLockActive = blockMouse;

        const block = (e) => {
          // Synthetic page events remain available to browser_evaluate.
          if (e.isTrusted === false) return;
          // Agent CDP events are admitted only for the current dispatch.
          const permit = window.__bcAgentInputPermit;
          const matchesPermit = permit
            && permit.until > Date.now()
            && Array.isArray(permit.eventTypes)
            && permit.eventTypes.includes(e.type)
            && (window !== window.top || permit.x == null || (
              Number.isFinite(e.clientX) && Number.isFinite(e.clientY)
              && Math.abs(e.clientX - permit.x) <= 1
              && Math.abs(e.clientY - permit.y) <= 1
            ));
          if (matchesPermit) {
            e.__bcAgentInputPermitId = permit.id;
            return;
          }
          if (!blockMouse && window.__bcAgentInputUntil > Date.now()) return;
          // An owner can still answer a vault approval card during an agent call.
          if (typeof e.composedPath === 'function' && e.composedPath().some((node) => node && node.__bcVaultHost === true)) return;
          e.preventDefault();
          e.stopImmediatePropagation();
        };
        const pointerTypes = ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click', 'dblclick', 'auxclick', 'contextmenu'];
        const movementTypes = blockMouse ? [
          'pointermove', 'pointerover', 'pointerout', 'pointerenter', 'pointerleave',
          'mousemove', 'mouseover', 'mouseout', 'mouseenter', 'mouseleave',
          'dragstart', 'drag', 'dragend', 'dragenter', 'dragleave', 'dragover', 'drop',
        ] : [];
        const keyWheelTypes = ['keydown', 'keyup', 'wheel'];
        for (const type of [...pointerTypes, ...movementTypes]) document.addEventListener(type, block, { capture: true });
        for (const type of keyWheelTypes) document.addEventListener(type, block, { capture: true, passive: false });
        // Store per frame: document listeners survive removing the visual element.
        root.__bcShieldDocListeners = { fn: block, types: [...pointerTypes, ...movementTypes, ...keyWheelTypes] };

        if (!isTopFrame) return;
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
          clearTimeout(window.__bcShieldBadgeTimer);
          window.__bcShieldBadgeTimer = setTimeout(() => badge.remove(), 60000);
        } else if (badge) {
          clearTimeout(window.__bcShieldBadgeTimer);
          badge.remove();
        }
      },
      args: [options.label, options.keepCursor, options.blockMouseMovement],
    });
    return Array.isArray(results) && results.length > 0;
  } catch {
    return false; // protected page / closed tab — caller decides how to report
  }
}

export async function showLockShield(tabId, label, keepCursor = false, movementLockOverride = undefined) {
  const options = {
    label: label ?? null,
    keepCursor: keepCursor === true,
    blockMouseMovement: typeof movementLockOverride === 'boolean'
      ? movementLockOverride
      : await agentMouseMovementLockEnabled(),
  };
  const shieldState = { options, readiness: null };
  activeShields.set(tabId, shieldState);
  const installation = injectLockShield(tabId, options);
  shieldState.readiness = installation;
  if (!await installation) {
    await hideLockShield(tabId);
    return false;
  }
  const activeTabId = resolveShieldTabId(tabId);
  if (activeShields.get(activeTabId) === shieldState && shieldState.readiness === installation) {
    shieldState.readiness = Promise.resolve(true);
  }
  return true;
}

/** Reapply the in-flight call shield when a top-level or child document commits. */
export async function refreshLockShield(tabId, frameId = null) {
  const shieldState = activeShields.get(tabId);
  if (!shieldState) return false;
  const { options } = shieldState;
  if (!options.blockMouseMovement && frameId != null && frameId !== 0) return true;
  const installation = injectLockShield(tabId, options, frameId);
  shieldState.readiness = installation;
  const installed = await installation;
  if (activeShields.get(tabId) !== shieldState) {
    await hideLockShield(tabId);
    return false;
  }
  if (shieldState.readiness === installation) shieldState.readiness = Promise.resolve(installed);
  return installed;
}

/** Move the in-flight shield state before Chrome completes its tab replacement. */
export function moveLockShield(fromTabId, toTabId) {
  if (fromTabId === toTabId) return false;
  const shieldState = activeShields.get(fromTabId);
  if (!shieldState) return false;
  activeShields.delete(fromTabId);
  activeShields.set(toTabId, shieldState);
  for (const [alias, target] of activeShieldAliases) {
    if (target === fromTabId) activeShieldAliases.set(alias, toTabId);
  }
  activeShieldAliases.set(fromTabId, toTabId);
  return true;
}

export function forgetLockShield(tabId) {
  activeShields.delete(tabId);
  // A removed source tab may still be the id captured by an in-flight router
  // finally block. Keep that alias until hideLockShield resolves its replacement.
  for (const [alias, target] of activeShieldAliases) {
    if (target === tabId) activeShieldAliases.delete(alias);
  }
}

export function discardLockShieldState(tabId) {
  const targetTabId = resolveShieldTabId(tabId);
  activeShields.delete(tabId);
  activeShields.delete(targetTabId);
  for (const [alias, target] of activeShieldAliases) {
    if (alias === tabId || target === targetTabId) activeShieldAliases.delete(alias);
  }
}

export async function hideLockShield(tabId, lingerMs = 0) {
  const targetTabId = resolveShieldTabId(tabId);
  discardLockShieldState(tabId);
  try {
    await chrome.scripting.executeScript({
      // The service worker may have restarted and lost which frames held the active shield.
      target: { tabId: targetTabId, allFrames: true },
      func: (linger) => {
        window.__bcMouseMovementLockActive = false;
        window.__bcAgentInputPermit = null;
        window.__bcAgentInputUntil = 0;
        clearTimeout(window.__bcAgentPermitTimer);
        const root = document.documentElement;
        const bound = root?.__bcShieldDocListeners;
        if (bound && typeof bound.fn === 'function' && Array.isArray(bound.types)) {
          for (const type of bound.types) {
            const opts = type === 'wheel' || type === 'keydown' || type === 'keyup'
              ? { capture: true, passive: false }
              : { capture: true };
            document.removeEventListener(type, bound.fn, opts);
          }
          root.__bcShieldDocListeners = null;
        }
        if (window !== window.top) return;
        const el = document.getElementById('__bc-lock-shield');
        if (!el) return;
        clearTimeout(el.__bcVisualTimer);
        clearTimeout(el.__bcAgentPermitTimer);
        el.style.pointerEvents = 'none';
        el.__bcBlockMouseMovement = false;
        if (linger) {
          // The frame may remain as a visual cue, but never retains hit-testing.
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
        if (frame) frame.style.opacity = hide ? '0' : '';
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
