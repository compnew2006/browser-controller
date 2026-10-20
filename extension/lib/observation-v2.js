export const AGENT_ACTIONS = Object.freeze([
  'click', 'type', 'select', 'hover', 'scroll', 'keypress', 'focus', 'upload',
]);

export function actionError(error, message, details = {}) {
  return { success: false, ok: false, error, message, ...details };
}

/** Pure semantic policy shared by observation and action revalidation. */
export function inferAllowedActions(descriptor = {}) {
  PAGE_V2_INSTALL();
  return globalThis.__browserControllerV2Runtime.inferAllowedActions(descriptor);
}

export function validateActionArguments(params = {}) {
  const invalid = (field, message = `${field} has an invalid value.`) => actionError(
    'INVALID_ACTION_ARGUMENTS', message, { invalid: field },
  );
  const action = params.action;
  if (!AGENT_ACTIONS.includes(action)) {
    return actionError('INVALID_ACTION_ARGUMENTS', 'Unsupported action.', {
      requestedAction: action ?? null,
      supportedActions: [...AGENT_ACTIONS],
    });
  }
  if (action !== 'scroll' && (params.ref == null || params.ref === '')) {
    return actionError('INVALID_ACTION_ARGUMENTS', 'ref is required for this action.', { missing: 'ref' });
  }
  if (params.ref != null && (typeof params.ref !== 'string' || !params.ref.trim())) return invalid('ref');
  if (action === 'type' && typeof params.text !== 'string') {
    return actionError('INVALID_ACTION_ARGUMENTS', 'text is required for type.', { missing: 'text' });
  }
  if (action === 'type' && params.clear != null && typeof params.clear !== 'boolean') return invalid('clear');
  if (action === 'keypress' && (typeof params.key !== 'string' || !params.key)) {
    if (params.key == null) {
      return actionError('INVALID_ACTION_ARGUMENTS', 'key is required for keypress.', { missing: 'key' });
    }
    return invalid('key');
  }
  if (action === 'keypress' && params.modifiers != null
    && (!Array.isArray(params.modifiers)
      || params.modifiers.some((modifier) => !['ctrl', 'alt', 'shift', 'meta'].includes(modifier)))) {
    return invalid('modifiers');
  }
  if (action === 'select' && params.index != null
    && (!Number.isInteger(params.index) || params.index < 0)) return invalid('index');
  if (action === 'select' && params.value != null && typeof params.value !== 'string') return invalid('value');
  if (action === 'select' && params.label != null && typeof params.label !== 'string') return invalid('label');
  if (action === 'select'
    && params.value == null && params.label == null && !Number.isInteger(params.index)) {
    return actionError('INVALID_ACTION_ARGUMENTS', 'value, label, or index is required for select.', { missing: 'value' });
  }
  if (action === 'scroll') {
    if (params.deltaX != null && !Number.isFinite(params.deltaX)) return invalid('deltaX');
    if (params.deltaY != null && !Number.isFinite(params.deltaY)) return invalid('deltaY');
  }
  if (action === 'upload') {
    if (params.filePath == null && params.files == null) {
      return actionError('INVALID_ACTION_ARGUMENTS', 'filePath or files is required for upload.', { missing: 'filePath' });
    }
    if (params.filePath != null && (typeof params.filePath !== 'string' || !params.filePath.trim())) {
      return invalid('filePath');
    }
    if (params.files != null && (!Array.isArray(params.files)
      || params.files.length === 0
      || params.files.some((file) => typeof file !== 'string' || !file.trim()))) {
      return invalid('files');
    }
  }
  return { ok: true };
}

export function validateElementGeometry(geometry = {}) {
  if (!geometry.connected) return actionError('STALE_STATE', 'The observed target is detached.');
  const values = [geometry.x, geometry.y, geometry.width, geometry.height];
  if (!geometry.visible
    || values.some((value) => !Number.isFinite(value))
    || geometry.width <= 0
    || geometry.height <= 0) {
    return actionError('TARGET_NOT_VISIBLE', 'The target has no usable visible geometry.');
  }
  return { ok: true };
}

function composedAncestors(node) {
  const seen = new Set();
  const out = [];
  let current = node;
  while (current && !seen.has(current)) {
    seen.add(current);
    out.push(current);
    const root = typeof current.getRootNode === 'function' ? current.getRootNode() : null;
    current = current.parentElement || root?.host || null;
  }
  return out;
}

export function isAcceptableComposedHit(target, hit) {
  if (!target || !hit) return false;
  const hitChain = composedAncestors(hit);
  if (hitChain.includes(target)) return true;
  const targetChain = composedAncestors(target);
  return targetChain.includes(hit);
}

export function validateFreshness(observed = {}, current = {}) {
  const semanticKeys = ['role', 'name', 'tagName'];
  const semanticMatch = semanticKeys.every((key) => String(observed[key] || '') === String(current[key] || ''));
  const stableIdMatch = !observed.stableId || observed.stableId === current.stableId;
  if (current.sameNode === true && semanticMatch && stableIdMatch) return { ok: true };
  if (!semanticMatch || !observed.stableId || !stableIdMatch) {
    return actionError('STALE_STATE', 'The target no longer matches the observed element.');
  }
  return { ok: true, recovered: true };
}

/**
 * Hermetic page runtime installer, injected with chrome.scripting `func:` so
 * Chrome executes its source natively. Rebuilding these functions with eval()
 * of a source string instead would throw in every isolated world: their CSP is
 * script-src 'self' without unsafe-eval (developer.chrome.com — Content
 * scripts), so the page-side observe/act entrypoints must never eval. The
 * function deliberately has no extension-scope dependencies.
 */
export function PAGE_V2_INSTALL() {
  // Bump when the helpers change: a document keeps the runtime an older build
  // installed. A literal, because this source is serialized into the page.
  const RUNTIME_VERSION = 3;
  if (globalThis.__browserControllerV2Runtime?.version === RUNTIME_VERSION) return false;

  /** Pure semantic policy shared by observation and action revalidation. */
  function inferAllowedActions(descriptor = {}) {
    if (descriptor.disabled) return [];
    const role = String(descriptor.role || '').toLowerCase();
    const tag = String(descriptor.tagName || '').toLowerCase();
    const inputType = String(descriptor.inputType || '').toLowerCase();
    if (tag === 'input' && inputType === 'file') return ['upload'];

    const actions = [];
    const add = (action) => { if (!actions.includes(action)) actions.push(action); };
    const isText = descriptor.contentEditable
      || tag === 'textarea'
      || (tag === 'input' && !['button', 'submit', 'reset', 'checkbox', 'radio', 'range', 'color', 'file', 'hidden'].includes(inputType));
    const isSelect = tag === 'select';
    const isClickable = ['button', 'link', 'checkbox', 'radio', 'switch', 'menuitem', 'tab', 'option'].includes(role)
      || tag === 'button'
      || tag === 'a'
      || (tag === 'input' && ['button', 'submit', 'reset', 'checkbox', 'radio'].includes(inputType));

    if (isText) {
      add('focus');
      if (!descriptor.readOnly) add('type');
      add('keypress');
      add('hover');
    } else if (isSelect) {
      add('select');
      add('focus');
      add('hover');
    } else if (isClickable) {
      add('click');
      add('focus');
      add('hover');
    } else if (descriptor.focusable) {
      add('focus');
      add('hover');
    }
    if (descriptor.scrollable) add('scroll');
    return actions;
  }

  const clean = (value, max = 160) => String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
  const attr = (element, name) => clean(element?.getAttribute?.(name));

  function roleOf(element) {
    const explicit = attr(element, 'role').split(' ')[0];
    if (explicit) return explicit;
    const tag = String(element?.tagName || '').toLowerCase();
    const type = String(element?.type || attr(element, 'type') || '').toLowerCase();
    if (tag === 'button') return 'button';
    if (tag === 'a' && element?.hasAttribute?.('href')) return 'link';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'select') return element?.multiple ? 'listbox' : 'combobox';
    if (tag === 'option') return 'option';
    if (tag === 'summary') return 'button';
    if (tag === 'input') {
      if (['button', 'submit', 'reset', 'image'].includes(type)) return 'button';
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio';
      if (type === 'range') return 'slider';
      if (type === 'search') return 'searchbox';
      return 'textbox';
    }
    if (element?.isContentEditable) return 'textbox';
    return tag === 'nav' ? 'navigation' : tag === 'main' ? 'main' : tag === 'form' ? 'form' : 'generic';
  }

  function nameOf(element) {
    const labelledBy = attr(element, 'aria-labelledby');
    if (labelledBy) {
      let root = null;
      try { root = element.getRootNode?.(); } catch {}
      const text = labelledBy.split(/\s+/)
        .map((id) => {
          const label = root?.getElementById?.(id) || element.ownerDocument?.getElementById?.(id);
          return clean(label?.innerText || label?.textContent);
        })
        .filter(Boolean)
        .join(' ');
      if (text) return clean(text);
    }
    const aria = attr(element, 'aria-label');
    if (aria) return aria;
    const labels = Array.from(element?.labels || []).map((label) => clean(label.innerText || label.textContent)).filter(Boolean);
    if (labels.length) return clean(labels.join(' '));
    const tag = String(element?.tagName || '').toLowerCase();
    const type = String(element?.type || attr(element, 'type') || '').toLowerCase();
    const buttonValue = tag === 'input' && ['button', 'submit', 'reset', 'image'].includes(type) ? element?.value : '';
    for (const candidate of [element?.alt, attr(element, 'alt'), element?.title, attr(element, 'title'), element?.placeholder, attr(element, 'placeholder'), buttonValue, element?.innerText, element?.textContent]) {
      const value = clean(candidate);
      if (value) return value;
    }
    return '';
  }

  function stableIdentity(element) {
    const id = clean(element?.id, 120);
    const stableId = id
      && !/^\d+$/.test(id)
      && !/:/.test(id)
      && !/^(react-|headlessui-|radix-|__)/i.test(id)
      && !/[a-f0-9]{8,}$/i.test(id)
      ? id
      : null;
    const testId = attr(element, 'data-testid') || attr(element, 'data-test') || attr(element, 'data-qa') || null;
    return { stableId, testId };
  }

  function descriptorOf(element) {
    const tagName = String(element?.tagName || '').toLowerCase();
    const inputType = String(element?.type || attr(element, 'type') || '').toLowerCase();
    const disabled = !!element?.disabled || attr(element, 'aria-disabled') === 'true';
    const readOnly = !!element?.readOnly || attr(element, 'aria-readonly') === 'true';
    const tabIndex = Number(element?.tabIndex);
    const scrollable = Number(element?.scrollHeight) > Number(element?.clientHeight) + 1
      || Number(element?.scrollWidth) > Number(element?.clientWidth) + 1;
    return {
      role: roleOf(element),
      name: nameOf(element),
      tagName,
      inputType,
      disabled,
      readOnly,
      contentEditable: !!element?.isContentEditable,
      focusable: Number.isFinite(tabIndex) && tabIndex >= 0,
      scrollable,
      ...stableIdentity(element),
    };
  }

  function rectOf(element, offsetX = 0, offsetY = 0) {
    const rect = element?.getBoundingClientRect?.();
    const number = (value, fallback = 0) => value == null ? fallback : Number(value);
    const round = (value) => {
      const numeric = number(value);
      return Number.isFinite(numeric) ? Math.round(numeric * 10) / 10 : numeric;
    };
    return {
      x: round(number(rect?.left) + number(offsetX)),
      y: round(number(rect?.top) + number(offsetY)),
      width: round(rect?.width),
      height: round(rect?.height),
      localX: round(rect?.left),
      localY: round(rect?.top),
    };
  }

  function visibilityOf(element, rect) {
    let visibleByTree = true;
    let pointerEnabled = true;
    const seen = new Set();
    let current = element;
    while (current && !seen.has(current)) {
      seen.add(current);
      let style = null;
      try { style = current.ownerDocument?.defaultView?.getComputedStyle?.(current); } catch {}
      const opacity = style?.opacity == null ? 1 : Number(style.opacity);
      if (current.hidden
        || attr(current, 'aria-hidden') === 'true'
        || style?.display === 'none'
        || style?.visibility === 'hidden'
        || style?.visibility === 'collapse'
        || style?.contentVisibility === 'hidden'
        || !Number.isFinite(opacity)
        || opacity <= 0.01) {
        visibleByTree = false;
      }
      if (style?.pointerEvents === 'none') pointerEnabled = false;
      let root = null;
      try { root = current.getRootNode?.(); } catch {}
      current = current.parentElement || root?.host || null;
    }
    const finiteGeometry = [rect.x, rect.y, rect.width, rect.height, rect.localX, rect.localY]
      .every(Number.isFinite);
    const visible = finiteGeometry
      && visibleByTree
      && !!element?.isConnected
      && rect.width > 0
      && rect.height > 0;
    return {
      visible,
      interactable: visible && pointerEnabled && !element?.disabled && attr(element, 'aria-disabled') !== 'true',
    };
  }

  function composedContains(target, hit) {
    const chain = (node) => {
      const values = [];
      const seen = new Set();
      let current = node;
      while (current && !seen.has(current)) {
        seen.add(current);
        values.push(current);
        let root = null;
        try { root = current.getRootNode?.(); } catch {}
        current = current.parentElement || root?.host || null;
      }
      return values;
    };
    return chain(hit).includes(target) || chain(target).includes(hit);
  }

  /** Text of the table/grid row holding `element`, minus its own cell(s); '' outside a row. */
  function rowContextOf(element, max = 80) {
    let row = element;
    for (;;) {
      let root = null;
      try { root = row.getRootNode?.(); } catch {}
      row = row.parentElement || root?.host || null;
      if (!row) return '';
      const tag = String(row.tagName || '').toUpperCase();
      if (tag === 'TR' || attr(row, 'role') === 'row') break;
      if (tag === 'TABLE' || tag === 'BODY') return '';
    }
    const parts = [];
    for (const cell of Array.from(row.children || [])) {
      if (composedContains(cell, element)) continue;
      let style = null;
      try { style = cell.ownerDocument?.defaultView?.getComputedStyle?.(cell); } catch {}
      if (style?.display === 'none' || style?.visibility === 'hidden') continue; // a hidden column is not what the user reads
      const text = clean(cell.innerText || cell.textContent, max);
      if (text) parts.push(text);
    }
    return clean(parts.join(' '), max);
  }

  function collectContexts(rootDocument) {
    const contexts = [];
    const seenRoots = new Set();
    const walk = (root, offsetX, offsetY, frameChain) => {
      if (!root || seenRoots.has(root)) return;
      seenRoots.add(root);
      contexts.push({ root, offsetX, offsetY, frameChain });
      let elements = [];
      try { elements = Array.from(root.querySelectorAll?.('*') || []); } catch {}
      for (const element of elements) {
        if (element.shadowRoot) walk(element.shadowRoot, offsetX, offsetY, frameChain);
        if (String(element.tagName || '').toLowerCase() === 'iframe') {
          try {
            const childDocument = element.contentDocument;
            if (childDocument) {
              const frameRect = element.getBoundingClientRect();
              walk(childDocument, offsetX + frameRect.left, offsetY + frameRect.top, [...frameChain, element]);
            }
          } catch { /* cross-origin frame: preserve existing same-origin boundary */ }
        }
      }
    };
    walk(rootDocument, 0, 0, []);
    return contexts;
  }

  globalThis.__browserControllerV2Runtime = Object.freeze({
    version: RUNTIME_VERSION,
    helpers: Object.freeze({ clean, attr, roleOf, nameOf, descriptorOf, rectOf, visibilityOf, composedContains, rowContextOf, collectContexts }),
    inferAllowedActions,
  });
  return true;
}

/**
 * Node/worker-side accessor over the installed runtime's DOM helpers — the
 * single definition lives inside PAGE_V2_INSTALL so the page gets the exact
 * code the unit tests exercise.
 */
export function createPageV2Helpers() {
  PAGE_V2_INSTALL();
  return globalThis.__browserControllerV2Runtime.helpers;
}

/** Atomic page-side collector used by browser_observe. */
export function PAGE_OBSERVE_V2(config) {
  const startedAt = performance.now();
  const runtime = globalThis.__browserControllerV2Runtime;
  if (!runtime) {
    return {
      success: false,
      ok: false,
      error: 'RUNTIME_NOT_INSTALLED',
      message: 'The Observation V2 runtime is missing on this document; install it and retry.',
    };
  }
  const helpers = runtime.helpers;
  const inferActions = runtime.inferAllowedActions;
  const STATE_KEY = '__browserControllerObservationV2';
  let state = globalThis[STATE_KEY];
  if (!state || state.document !== document) {
    const random = globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    state = {
      document,
      documentId: `d_${random}`,
      routeEpoch: 1,
      revision: 0,
      lastUrl: location.href,
      snapshots: new Map(),
    };
    try {
      state.observer = new MutationObserver(() => { state.revision += 1; });
      state.observer.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
    } catch {}
    globalThis[STATE_KEY] = state;
  }
  if (state.lastUrl !== location.href) {
    state.routeEpoch += 1;
    state.lastUrl = location.href;
    state.snapshots.clear();
  }
  const now = Number(config.now) || Date.now();
  for (const [id, snapshot] of state.snapshots) {
    if (now - snapshot.createdAt > config.ttlMs) state.snapshots.delete(id);
  }
  while (state.snapshots.size >= config.maxSnapshots) state.snapshots.delete(state.snapshots.keys().next().value);

  const refs = new Map();
  const elements = [];
  const contexts = helpers.collectContexts(document);
  for (const context of contexts) {
    let candidates = [];
    try { candidates = Array.from(context.root.querySelectorAll('*')); } catch {}
    for (const element of candidates) {
      if (elements.length >= config.maxElements) break;
      const descriptor = helpers.descriptorOf(element);
      const uploadReachable = context.frameChain.length === 0
        && element.ownerDocument === document
        && element.getRootNode?.() === document;
      const reachableActions = (actions) => actions.filter((candidate) => candidate !== 'upload' || uploadReachable);
      const enabledActions = reachableActions(inferActions(descriptor));
      const semanticActions = enabledActions.length
        ? enabledActions
        : descriptor.disabled
          ? reachableActions(inferActions({ ...descriptor, disabled: false }))
          : [];
      if (!semanticActions.length) continue;
      const rect = helpers.rectOf(element, context.offsetX, context.offsetY);
      const visibility = helpers.visibilityOf(element, rect);
      const frameVisible = context.frameChain.every((frame) => {
        const frameRect = helpers.rectOf(frame);
        return helpers.visibilityOf(frame, frameRect).visible;
      });
      if (!visibility.visible || !frameVisible) continue;
      const ref = `e${elements.length + 1}`;
      const value = descriptor.inputType === 'password'
        ? undefined
        : helpers.clean(element.value ?? (element.isContentEditable ? element.textContent : ''), 200);
      // Lean by design (tokens): only state that differs from the default, no
      // `visible` (every listed element is), `interactable` only when false.
      const stateView = {
        ...(descriptor.disabled ? { disabled: true } : {}),
        ...(descriptor.readOnly ? { readOnly: true } : {}),
        ...(typeof element.checked === 'boolean' ? { checked: element.checked } : {}),
        ...(typeof element.selected === 'boolean' ? { selected: element.selected } : {}),
        ...(helpers.attr(element, 'aria-expanded') ? { expanded: helpers.attr(element, 'aria-expanded') === 'true' } : {}),
      };
      const publicElement = {
        ref,
        role: descriptor.role,
        ...(descriptor.name ? { name: descriptor.name } : {}),
        ...(value ? { value } : {}),
        ...(Object.keys(stateView).length ? { state: stateView } : {}),
        bbox: [rect.x, rect.y, rect.width, rect.height].map(Math.round),
        ...(visibility.interactable ? {} : { interactable: false }),
        allowedActions: enabledActions,
      };
      elements.push(publicElement);
      refs.set(ref, {
        element,
        descriptor,
        frameChain: context.frameChain,
        observedRect: rect,
      });
    }
    if (elements.length >= config.maxElements) break;
  }

  // Look-alike controls ("Edit" in every row) get their table row's text.
  const key = (item) => `${item.role}|${item.name || ''}`;
  const counts = new Map();
  for (const item of elements) counts.set(key(item), (counts.get(key(item)) || 0) + 1);
  for (const item of elements) {
    if (counts.get(key(item)) < 2) continue;
    const context = helpers.rowContextOf(refs.get(item.ref).element);
    if (context) item.context = context;
  }

  // Same budget idea as browser_snapshot's maxChars: page order, cut once the
  // list's JSON passes the cap; refs past the cut are not kept either.
  let truncated = false;
  if (Number.isFinite(config.maxChars) && config.maxChars > 0) {
    let used = 2;
    let kept = elements.length;
    for (let i = 0; i < elements.length; i++) {
      used += JSON.stringify(elements[i]).length + 1;
      if (used > config.maxChars) { kept = i; break; }
    }
    if (kept < elements.length) {
      for (const item of elements.splice(kept)) refs.delete(item.ref);
      truncated = true;
    }
  }

  const documentVersion = `${state.documentId}:${state.routeEpoch}:${state.revision}`;
  state.snapshots.set(config.snapshotId, {
    snapshotId: config.snapshotId,
    sessionId: config.sessionId,
    documentId: state.documentId,
    documentVersion,
    routeEpoch: state.routeEpoch,
    url: location.href,
    createdAt: now,
    refs,
  });
  const text = helpers.clean(document.body?.innerText || document.body?.textContent || '', 2_000);
  const response = {
    success: true,
    snapshotId: config.snapshotId,
    documentId: state.documentId,
    documentVersion,
    routeEpoch: state.routeEpoch,
    url: location.href,
    title: document.title || '',
    viewport: {
      width: Math.round(globalThis.innerWidth || document.documentElement?.clientWidth || 0),
      height: Math.round(globalThis.innerHeight || document.documentElement?.clientHeight || 0),
      scrollX: Math.round(globalThis.scrollX || 0),
      scrollY: Math.round(globalThis.scrollY || 0),
    },
    elements,
    ...(truncated ? { truncated: true, hint: 'Elements capped (maxChars). Raise maxChars, or scroll and observe again.' } : {}),
    text,
    pageState: { readyState: document.readyState },
  };
  response.metrics = {
    captureMs: Math.round((performance.now() - startedAt) * 100) / 100,
    payloadBytes: JSON.stringify(response).length,
    protocolCalls: 1,
  };
  return response;
}

export { PAGE_ACT_V2 } from './observation-action.js';
