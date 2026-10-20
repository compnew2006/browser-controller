/** Single-injection safe action pipeline used by browser_act. */
export async function PAGE_ACT_V2(config) {
  try {
    const startedAt = performance.now();
    // A navigation an action starts reaches the URL (or fires unload) a moment
    // after the event that caused it: judge navigation after this settle.
    const NAVIGATION_SETTLE_MS = 100;
    const fail = (error, message, details = {}) => ({ success: false, ok: false, error, message, ...details });
    const runtime = globalThis.__browserControllerV2Runtime;
    if (!runtime) {
      return fail('RUNTIME_NOT_INSTALLED', 'The Observation V2 runtime is missing on this document; install it and retry.');
    }
    const helpers = runtime.helpers;
    const inferActions = runtime.inferAllowedActions;
    const state = globalThis.__browserControllerObservationV2;
    if (!state || state.document !== document || state.documentId !== config.documentId) {
      return fail('DOCUMENT_CHANGED', 'The page document changed; call browser_observe again.');
    }
    if (state.lastUrl !== location.href || state.routeEpoch !== config.routeEpoch) {
      return fail('DOCUMENT_CHANGED', 'The page route changed; call browser_observe again.', { url: location.href });
    }
    const snapshot = state.snapshots.get(config.snapshotId);
    if (!snapshot) return fail('SNAPSHOT_NOT_FOUND', 'The observation is no longer available.');
    if (snapshot.sessionId !== config.sessionId) return fail('SNAPSHOT_NOT_FOUND', 'The observation belongs to another session.');
    if (Date.now() - snapshot.createdAt > config.ttlMs) {
      state.snapshots.delete(config.snapshotId);
      return fail('OBSERVATION_EXPIRED', `The observation expired after ${Math.round(config.ttlMs / 1000)} s; call browser_observe again.`);
    }

    // Extension-drawn overlays (lib/overlay.js lock shield, lib/page-dom.js agent
    // cursor). They are not the page: hit tests skip them.
    const isExtensionOverlay = (node) => {
      for (let current = node, depth = 0; current && depth < 8; depth += 1, current = current.parentElement) {
        if (current.id === '__bc-lock-shield' || current.id === '__bc-agent-cursor') return true;
      }
      return false;
    };
    /** Topmost page element at a point of `doc`, looking through the extension's own overlays. */
    const pageHitAt = (doc, x, y) => {
      const stack = typeof doc?.elementsFromPoint === 'function'
        ? doc.elementsFromPoint(x, y)
        : [doc?.elementFromPoint?.(x, y)];
      return (stack || []).find((node) => node && !isExtensionOverlay(node)) || null;
    };
    const blockerOf = (node) => (node ? {
      role: helpers.roleOf(node),
      name: helpers.nameOf(node),
      tag: String(node.tagName || '').toLowerCase(),
    } : null);
    /**
     * Watch for a navigation the action starts. beforeunload/pagehide fire as a
     * navigation begins, before (and whether or not) the URL changes.
     */
    const watchNavigation = () => {
      const watch = { started: false, stop() {} };
      if (typeof globalThis.addEventListener !== 'function') return watch;
      const onStart = () => { watch.started = true; };
      const types = ['beforeunload', 'pagehide'];
      for (const type of types) globalThis.addEventListener(type, onStart);
      watch.stop = () => { for (const type of types) globalThis.removeEventListener(type, onStart); };
      return watch;
    };
    // Single-line fields that submit their form on Enter; the rest never do.
    const NON_TEXT_INPUT_TYPES = ['button', 'submit', 'reset', 'checkbox', 'radio', 'file', 'image', 'range', 'color', 'hidden'];
    const isTextField = (control) => String(control?.tagName || '').toUpperCase() === 'INPUT'
      && !NON_TEXT_INPUT_TYPES.includes(String(control.type || 'text').toLowerCase());
    const isSubmitControl = (control) => {
      const tag = String(control?.tagName || '').toUpperCase();
      if (control?.disabled || (tag !== 'BUTTON' && tag !== 'INPUT')) return false;
      const type = String(control.type || control.getAttribute?.('type') || (tag === 'BUTTON' ? 'submit' : '')).toLowerCase();
      return type === 'submit' || type === 'image';
    };
    /**
     * Enter in a single-line field submits its form as a user's Enter does: the
     * form's submit control is the default button, and a lone text field submits
     * by itself. Several fields and no submit control: nothing happens (as in a
     * browser). Goes through requestSubmit, so validation and handlers run.
     */
    const implicitSubmit = (field) => {
      const form = field.form;
      if (!form) return;
      const controls = Array.from(form.elements || []);
      const submitter = controls.find(isSubmitControl) || null;
      if (!submitter && controls.filter(isTextField).length !== 1) return;
      if (typeof form.requestSubmit !== 'function') {
        submitter?.click?.();
        return;
      }
      if (submitter) form.requestSubmit(submitter);
      else form.requestSubmit();
    };

    const action = config.params.action;
    const ref = config.params.ref;
    /** Top-level viewport point a click landed on (browser_gif rings it). */
    let clickedAt = null;
    if (action === 'scroll' && !ref) {
      const deltaX = Number(config.params.deltaX) || 0;
      const deltaY = Number(config.params.deltaY) || (deltaX ? 0 : 500);
      globalThis.scrollBy({ left: deltaX, top: deltaY, behavior: 'instant' });
      state.revision += 1;
      return await successResult(null, false, null);
    }

    const record = snapshot.refs.get(ref);
    if (!record) return fail('TARGET_NOT_FOUND', 'The ref is not part of this observation.', { ref });
    let element = record.element;
    let recovered = false;
    if (!element?.isConnected) {
      const matches = [];
      for (const context of helpers.collectContexts(document)) {
        let candidates = [];
        try { candidates = Array.from(context.root.querySelectorAll('*')); } catch {}
        for (const candidate of candidates) {
          const current = helpers.descriptorOf(candidate);
          const sameStableIdentity = (record.descriptor.testId && current.testId === record.descriptor.testId)
            || (record.descriptor.stableId && current.stableId === record.descriptor.stableId);
          if (sameStableIdentity
            && current.role === record.descriptor.role
            && current.name === record.descriptor.name
            && current.tagName === record.descriptor.tagName) {
            matches.push({ element: candidate, descriptor: current, frameChain: context.frameChain });
          }
        }
      }
      if (matches.length !== 1) {
        return fail('STALE_STATE', 'The detached target could not be recovered with unique high confidence.', { ref });
      }
      element = matches[0].element;
      record.frameChain = matches[0].frameChain;
      recovered = true;
    }

    const matchesObservation = (descriptor) => descriptor.role === record.descriptor.role
      && descriptor.name === record.descriptor.name
      && descriptor.tagName === record.descriptor.tagName
      && (!record.descriptor.stableId || descriptor.stableId === record.descriptor.stableId)
      && (!record.descriptor.testId || descriptor.testId === record.descriptor.testId);
    const validateCurrent = (descriptor) => {
      if (!matchesObservation(descriptor)) {
        return fail('STALE_STATE', 'The target no longer matches the observation.', { ref });
      }
      if (descriptor.disabled) return fail('TARGET_DISABLED', 'The target is disabled.', { ref });
      const allowedActions = inferActions(descriptor);
      if (!allowedActions.includes(action)) {
        return fail('ACTION_NOT_ALLOWED', 'The requested action is not valid for this target.', {
          ref,
          requestedAction: action,
          allowedActions,
        });
      }
      return null;
    };
    const outsideViewport = (candidateRect, view) => candidateRect.localX < 0 || candidateRect.localY < 0
      || candidateRect.localX + candidateRect.width > (view?.innerWidth || 0)
      || candidateRect.localY + candidateRect.height > (view?.innerHeight || 0);
    const waitForPaint = async (view) => {
      await new Promise((resolve) => {
        const raf = view?.requestAnimationFrame || globalThis.requestAnimationFrame;
        if (typeof raf === 'function') raf(() => resolve());
        else resolve();
      });
    };
    const scrollIntoViewport = async (node) => {
      const nodeRect = helpers.rectOf(node);
      const nodeView = node.ownerDocument?.defaultView;
      if (outsideViewport(nodeRect, nodeView) && node.scrollIntoView) {
        node.scrollIntoView({ behavior: 'instant', block: 'center', inline: 'center' });
        await waitForPaint(nodeView);
        return true;
      }
      return false;
    };

    let current = helpers.descriptorOf(element);
    let stateError = validateCurrent(current);
    if (stateError) return stateError;
    let rect = helpers.rectOf(element);
    let visibility = helpers.visibilityOf(element, rect);
    if (!visibility.visible) return fail('TARGET_NOT_VISIBLE', 'The target is hidden or has no usable geometry.', { ref });

    let scrolled = await scrollIntoViewport(element);
    for (let index = record.frameChain.length - 1; index >= 0; index -= 1) {
      const frame = record.frameChain[index];
      if (!frame?.isConnected) return fail('STALE_STATE', 'A target frame detached while preparing the action.', { ref });
      const frameRect = helpers.rectOf(frame);
      if (!helpers.visibilityOf(frame, frameRect).visible) {
        return fail('TARGET_NOT_VISIBLE', 'A target frame is hidden or has invalid geometry.', { ref });
      }
      scrolled = (await scrollIntoViewport(frame)) || scrolled;
    }
    if (scrolled) {
      if (!element.isConnected) return fail('STALE_STATE', 'The target detached while scrolling.', { ref });
      current = helpers.descriptorOf(element);
      stateError = validateCurrent(current);
      if (stateError) return stateError;
      rect = helpers.rectOf(element);
      visibility = helpers.visibilityOf(element, rect);
      if (!visibility.visible) return fail('TARGET_NOT_VISIBLE', 'The target is not visible after scrolling.', { ref });
      for (const frame of record.frameChain) {
        const frameRect = helpers.rectOf(frame);
        if (!frame?.isConnected || !helpers.visibilityOf(frame, frameRect).visible) {
          return fail('TARGET_NOT_VISIBLE', 'A target frame is not visible after scrolling.', { ref });
        }
      }
    }

    // Validate what the action needs before anything is dispatched.
    let option = null;
    if (action === 'select') {
      const options = Array.from(element.options || []);
      option = Number.isInteger(config.params.index)
        ? options[config.params.index]
        : options.find((candidate) => config.params.value != null
          ? String(candidate.value) === String(config.params.value)
          : helpers.clean(candidate.textContent) === helpers.clean(config.params.label));
      if (!option) return fail('INVALID_ACTION_ARGUMENTS', 'The requested select option was not found.', { ref });
      if (option.disabled) return fail('TARGET_DISABLED', 'The requested select option is disabled.', { ref });
    }
    if (action === 'upload') {
      if (element.ownerDocument !== document || element.getRootNode?.() !== document) {
        return fail('ACTION_NOT_ALLOWED', 'Upload currently requires a top-document file input.', {
          ref,
          requestedAction: action,
          allowedActions: [],
        });
      }
      const uploadToken = `u_${config.snapshotId.replace(/[^a-zA-Z0-9_-]/g, '')}_${ref.replace(/[^a-zA-Z0-9_-]/g, '')}`;
      element.setAttribute('data-bc-v2-upload', uploadToken);
      return {
        success: true,
        ok: true,
        action,
        ref,
        preparedUpload: true,
        selector: `[data-bc-v2-upload="${uploadToken}"]`,
        documentVersion: `${state.documentId}:${state.routeEpoch}:${state.revision}`,
        url: location.href,
        recovered,
        metrics: { durationMs: Math.round((performance.now() - startedAt) * 100) / 100, protocolCalls: 1 },
      };
    }

    if (action === 'click' || action === 'hover') {
      let x = rect.localX + rect.width / 2;
      let y = rect.localY + rect.height / 2;
      // The element at the point must be the target, one of its ancestors or
      // descendants (composed), or it is covered. Own overlays are skipped.
      const hit = pageHitAt(element.ownerDocument, x, y);
      if (!helpers.composedContains(element, hit)) {
        return fail('ELEMENT_COVERED', 'Another element covers the target pointer point.', {
          ref,
          blockingElement: blockerOf(hit),
        });
      }
      for (let index = record.frameChain.length - 1; index >= 0; index -= 1) {
        const frame = record.frameChain[index];
        const frameRect = frame.getBoundingClientRect();
        x += frameRect.left;
        y += frameRect.top;
        const frameHit = pageHitAt(frame.ownerDocument, x, y);
        if (!helpers.composedContains(frame, frameHit)) {
          return fail('ELEMENT_COVERED', 'An overlay covers the target frame.', {
            ref,
            blockingElement: blockerOf(frameHit),
          });
        }
      }
      if (action === 'click') clickedAt = { x: Math.round(x), y: Math.round(y) };
      // Agent cursor (opt-in, lib/page-dom.js): glide to the point (now in
      // top-level coordinates) before acting. The events below are dispatched on
      // the element itself, so only its detaching meanwhile can spoil the action.
      const glideMs = config.cursor && globalThis.__bcDom?.cursor
        ? globalThis.__bcDom.cursor(x, y, action === 'click' ? 'click' : 'move')
        : 0;
      if (glideMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, glideMs));
        if (!element.isConnected) return fail('STALE_STATE', 'The target detached before the action.', { ref });
      }
    }

    // From here the action dispatches events; a navigation it starts is watched
    // until the result is built (successResult).
    const navigation = watchNavigation();
    const eventWindow = element.ownerDocument?.defaultView || globalThis;
    const centerX = rect.localX + rect.width / 2;
    const centerY = rect.localY + rect.height / 2;
    const mouseInit = { bubbles: true, cancelable: true, composed: true, view: eventWindow, clientX: centerX, clientY: centerY, button: 0, buttons: 0 };
    const PointerEventType = eventWindow.PointerEvent || eventWindow.MouseEvent;
    const pointerEvent = (type, buttons, bubbles = true) => element.dispatchEvent(new PointerEventType(type, {
      ...mouseInit,
      bubbles,
      buttons,
      pointerId: 1,
      pointerType: 'mouse',
      isPrimary: true,
    }));
    const mouseEvent = (type, init = {}) => element.dispatchEvent(new eventWindow.MouseEvent(type, { ...mouseInit, ...init }));
    // The pointer arrives over the element, in the order a mouse produces it.
    const pointerArrives = () => {
      pointerEvent('pointerover', 0);
      pointerEvent('pointerenter', 0, false);
      mouseEvent('mouseover');
      mouseEvent('mouseenter', { bubbles: false });
      pointerEvent('pointermove', 0);
      mouseEvent('mousemove');
    };

    if (action === 'click') {
      pointerArrives();
      pointerEvent('pointerdown', 1);
      mouseEvent('mousedown', { buttons: 1 });
      element.focus?.(); // a real press focuses the element between mousedown and mouseup
      pointerEvent('pointerup', 0);
      mouseEvent('mouseup');
      mouseEvent('click', { detail: 1 });
    } else if (action === 'hover') {
      pointerArrives();
    } else if (action === 'focus') {
      element.focus?.();
    } else if (action === 'type') {
      element.focus?.();
      const setValue = (value) => {
        const prototype = element.tagName === 'TEXTAREA'
          ? eventWindow.HTMLTextAreaElement?.prototype
          : eventWindow.HTMLInputElement?.prototype;
        const setter = prototype && Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
        if (setter) setter.call(element, value);
        else element.value = value;
      };
      if (config.params.clear) {
        if (element.isContentEditable) element.textContent = '';
        else setValue('');
        element.dispatchEvent(new eventWindow.Event('input', { bubbles: true }));
      }
      if (element.isContentEditable) {
        element.ownerDocument.execCommand?.('insertText', false, config.params.text);
      } else {
        setValue(`${element.value || ''}${config.params.text}`);
        element.dispatchEvent(new eventWindow.Event('input', { bubbles: true, inputType: 'insertText', data: config.params.text }));
      }
      element.dispatchEvent(new eventWindow.Event('change', { bubbles: true }));
    } else if (action === 'select') {
      element.value = option.value;
      element.dispatchEvent(new eventWindow.Event('input', { bubbles: true }));
      element.dispatchEvent(new eventWindow.Event('change', { bubbles: true }));
    } else if (action === 'keypress') {
      element.focus?.();
      const modifiers = config.params.modifiers || [];
      const keyInit = {
        key: config.params.key,
        code: config.params.key.length === 1 ? `Key${config.params.key.toUpperCase()}` : config.params.key,
        bubbles: true,
        cancelable: true,
        ctrlKey: modifiers.includes('ctrl'),
        altKey: modifiers.includes('alt'),
        shiftKey: modifiers.includes('shift'),
        metaKey: modifiers.includes('meta'),
      };
      // As in a browser: a canceled keydown produces no keypress, and Enter's
      // implicit form submission is the default action of that keypress.
      const keydownAllowed = element.dispatchEvent(new eventWindow.KeyboardEvent('keydown', keyInit));
      if (keydownAllowed) {
        const keypressAllowed = element.dispatchEvent(new eventWindow.KeyboardEvent('keypress', keyInit));
        const plainEnter = config.params.key === 'Enter' && modifiers.length === 0;
        if (keypressAllowed && plainEnter && isTextField(element)) implicitSubmit(element);
      }
      element.dispatchEvent(new eventWindow.KeyboardEvent('keyup', keyInit));
    } else if (action === 'scroll') {
      const deltaX = Number(config.params.deltaX) || 0;
      const deltaY = Number(config.params.deltaY) || (deltaX ? 0 : 500);
      element.scrollBy?.({ left: deltaX, top: deltaY, behavior: 'instant' });
    }

    state.revision += 1;
    return await successResult(ref, recovered, navigation);

    async function successResult(resultRef, wasRecovered, watch) {
      if (watch) {
        await new Promise((resolve) => setTimeout(resolve, NAVIGATION_SETTLE_MS));
        watch.stop();
      }
      const currentUrl = location.href;
      const navigated = !!watch?.started || currentUrl !== snapshot.url;
      return {
        success: true,
        ok: true,
        action,
        ...(resultRef ? { ref: resultRef } : {}),
        ...(clickedAt ? { at: clickedAt } : {}),
        documentVersion: `${state.documentId}:${state.routeEpoch}:${state.revision}`,
        navigationDetected: navigated,
        documentChanged: navigated,
        url: currentUrl,
        ...(wasRecovered ? { recovered: true } : {}),
        metrics: { durationMs: Math.round((performance.now() - startedAt) * 100) / 100, protocolCalls: 1 },
      };
    }
  } catch (err) {
    // A page function that throws comes back as a bare null: report it in-band, as safeExec reads it.
    return { __bcScriptError: String(err?.message || err) };
  }
}
