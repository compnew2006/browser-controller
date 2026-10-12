/**
 * WebMCP page runner (specs/webmcp-support). `webmcpPageRun` is stringified and
 * evaluated in the page's main world over CDP (see handlers/webmcp.js), so it
 * must stay SELF-CONTAINED: no imports, no references to this module's scope —
 * every limit arrives in `spec.limits`. It always resolves to a JSON STRING:
 * a primitive comes back from cdpEvaluate in one round trip, and the handler
 * owns parsing + validation (the page's world can forge anything returned here).
 *
 * Verified against Chrome 155 (headless, WebMCP enabled):
 *  - document.modelContext.getTools() lists the main document's tools and its
 *    same-origin frames', each with a WindowProxy (`window`) that cannot be
 *    serialized; same-origin duplicates share `origin`, so frames are told
 *    apart by their position in window.frames.
 *  - Declarative <form toolname> tools are listed too (no annotations). Without
 *    `toolautosubmit` the browser fills the form and waits for a user submit.
 *  - executeTool rejects with AbortError on abort even when the tool ignores its
 *    signal, and with a generic UnknownError when the tool throws (the tool's own
 *    message is not exposed).
 */

export const WEBMCP_LIMITS = Object.freeze({
  /** Encoded JSON budget for one result — below cdpEvaluate's MAX_RESULT_CHARS (100 000). */
  budgetChars: 90_000,
  schemaMaxChars: 8_000,
  descriptionMaxChars: 2_000,
  titleMaxChars: 200,
});

export async function webmcpPageRun(spec) {
  const done = (result) => JSON.stringify(result);
  const limits = spec.limits;

  if (spec.action === 'abort') {
    const calls = globalThis.__bcWebmcpCalls;
    const controller = calls && calls[spec.callId];
    if (controller) {
      controller.abort();
    } else {
      // The call has not reached executeTool yet (or already finished): leave a
      // tombstone the call checks right before it executes. Bounded.
      const aborted = globalThis.__bcWebmcpAborted || (globalThis.__bcWebmcpAborted = Object.create(null));
      if (Object.keys(aborted).length >= 50) for (const key of Object.keys(aborted)) delete aborted[key];
      aborted[spec.callId] = true;
    }
    return done({ aborted: !!controller });
  }

  const mc = globalThis.document && globalThis.document.modelContext;
  if (!mc || typeof mc.getTools !== 'function' || typeof mc.executeTool !== 'function') {
    return done({
      supported: false,
      reason: 'This page does not expose WebMCP (document.modelContext is missing): the site registers no WebMCP tools, '
        + 'or WebMCP is off in this browser (Chrome: origin trial, or chrome://flags/#enable-webmcp-testing). Use the regular browser tools.',
    });
  }

  const blocked = () => done({
    supported: false,
    reason: 'WebMCP is blocked in this document by its permissions policy ("tools" feature). Use the regular browser tools.',
  });
  const getTools = async () => mc.getTools();

  const framePath = (win) => {
    if (win === globalThis.window) return 'main';
    const walk = (parent, path) => {
      for (let i = 0; i < parent.frames.length; i++) {
        const child = parent.frames[i];
        if (child === win) return [...path, i];
        const found = walk(child, [...path, i]);
        if (found) return found;
      }
      return null;
    };
    try {
      const found = walk(globalThis.window, []);
      return found ? found.join('/') : 'unknown';
    } catch {
      return 'unknown';
    }
  };
  const frameUrlOf = (win) => {
    try {
      return String(win.location.href);
    } catch {
      return null;
    }
  };
  // Declarative <form toolname> tools are listed by getTools() like imperative
  // ones (no annotations), also from inside shadow roots. Two sources decide:
  // this page-side search (light DOM + OPEN shadow roots, one pass per
  // document) and the handler's CDP scan in spec.formHints, which also sees
  // CLOSED shadow roots. Either one finding a form makes the tool declarative.
  const formsByDocument = new Map();
  const formsIn = (doc) => {
    if (formsByDocument.has(doc)) return formsByDocument.get(doc);
    const found = [];
    const visit = (root, depth) => {
      if (!root || depth > 32) return;
      for (const form of root.querySelectorAll('form[toolname]')) found.push(form);
      for (const el of root.querySelectorAll('*')) {
        if (el.shadowRoot) visit(el.shadowRoot, depth + 1);
      }
    };
    try {
      visit(doc, 0);
    } catch {
      /* document gone mid-scan: what was found so far stands */
    }
    formsByDocument.set(doc, found);
    return found;
  };
  const declarativeOf = (tool, frameUrl, otherFrameUrls = []) => {
    let doc = null;
    try {
      doc = tool.window.document;
    } catch {
      /* unreadable: rely on the CDP scan */
    }
    const form = doc ? formsIn(doc).find((f) => f.getAttribute('toolname') === tool.name) : null;
    if (form) return { declarative: true, autoSubmit: form.hasAttribute('toolautosubmit') };
    const sameName = (Array.isArray(spec.formHints) ? spec.formHints : []).filter((h) => h && h.name === tool.name);
    const sameDocument = sameName.filter((h) => h.documentURL === frameUrl);
    // No hint in this tool's own document: a same-name form that lives in the
    // document of ANOTHER same-name tool is that tool's form, not this one's.
    const relevant = sameDocument.length ? sameDocument : sameName.filter((h) => !otherFrameUrls.includes(h.documentURL));
    if (relevant.length === 0) return { declarative: false, autoSubmit: false };
    // Several same-name forms: autosubmit only if all of them are (stricter gate).
    return { declarative: true, autoSubmit: relevant.every((h) => h.autoSubmit === true) };
  };
  const annotationsOf = (tool) => {
    const out = {};
    const a = tool.annotations;
    if (a && typeof a === 'object') {
      for (const key of ['readOnlyHint', 'consequentialHint', 'untrustedContentHint', 'debugging']) {
        if (typeof a[key] === 'boolean') out[key] = a[key];
      }
    }
    return out;
  };
  const errorInfo = (err) => ({
    errorName: String((err && err.name) || 'Error').slice(0, 100),
    error: String((err && err.message) || err).slice(0, 2_000),
  });

  let tools;
  try {
    tools = await getTools();
  } catch (err) {
    if (err && err.name === 'NotAllowedError') return blocked();
    throw err;
  }

  if (spec.action === 'list') {
    const wanted = (list) => (spec.name ? list.filter((t) => t.name === spec.name) : list);
    if (spec.waitMs > 0 && wanted(tools).length === 0) {
      const deadline = Date.now() + spec.waitMs;
      while (wanted(tools).length === 0 && Date.now() < deadline) {
        // Wake on toolchange, then let a burst of registrations settle (150 ms);
        // poll every 250 ms in case the event never comes.
        await new Promise((resolve) => {
          const remaining = () => Math.max(0, deadline - Date.now());
          let debounce = null;
          let poll = null;
          let hard = null;
          const finish = () => {
            clearTimeout(poll);
            clearTimeout(debounce);
            clearTimeout(hard);
            mc.removeEventListener('toolchange', onChange);
            resolve();
          };
          const onChange = () => {
            clearTimeout(poll);
            clearTimeout(debounce);
            debounce = setTimeout(finish, Math.min(150, remaining()));
          };
          poll = setTimeout(finish, Math.min(250, remaining()));
          hard = setTimeout(finish, remaining()); // a toolchange stream never extends the deadline
          mc.addEventListener('toolchange', onChange);
        });
        try {
          tools = await getTools();
        } catch (err) {
          if (err && err.name === 'NotAllowedError') return blocked();
          throw err;
        }
      }
    }

    const selected = wanted(tools);
    const result = { supported: true, url: String(globalThis.location && globalThis.location.href), count: selected.length, tools: [] };
    if (spec.name && selected.length === 0) result.available = tools.slice(0, 200).map((t) => t.name);
    if (spec.formScanFailed) result.formScan = 'failed';
    const schemaCap = spec.name ? limits.budgetChars : limits.schemaMaxChars;
    let used = JSON.stringify(result).length + 400; // room for counters + hint
    let schemasOmitted = 0;
    let toolsOmitted = 0;
    const frameUrlsByName = new Map();
    for (const t of tools) {
      if (!frameUrlsByName.has(t.name)) frameUrlsByName.set(t.name, []);
      frameUrlsByName.get(t.name).push({ tool: t, frameUrl: frameUrlOf(t.window) });
    }
    const othersOf = (tool) => frameUrlsByName.get(tool.name).filter((o) => o.tool !== tool).map((o) => o.frameUrl);
    for (const tool of selected) {
      const description = String(tool.description ?? '');
      const frameUrl = frameUrlOf(tool.window);
      const { declarative, autoSubmit } = declarativeOf(tool, frameUrl, othersOf(tool));
      const entry = {
        name: String(tool.name),
        title: tool.title ? String(tool.title).slice(0, limits.titleMaxChars) : null,
        description: description.slice(0, limits.descriptionMaxChars),
        origin: String(tool.origin ?? ''),
        frame: framePath(tool.window),
        frameUrl,
        annotations: annotationsOf(tool),
        declarative,
        autoSubmit,
      };
      if (description.length > limits.descriptionMaxChars) entry.descriptionTruncated = true;
      const baseLen = JSON.stringify(entry).length + 1;
      if (used + baseLen > limits.budgetChars) {
        toolsOmitted++;
        continue;
      }
      let schemaJson = null;
      try {
        schemaJson = JSON.stringify(tool.inputSchema ?? null) ?? 'null';
      } catch {
        /* unserializable schema: omitted below */
      }
      const schemaLen = schemaJson === null ? 0 : schemaJson.length + '"inputSchema":,'.length;
      if (schemaJson !== null && schemaJson.length <= schemaCap && used + baseLen + schemaLen <= limits.budgetChars) {
        entry.inputSchema = JSON.parse(schemaJson);
        used += baseLen + schemaLen;
      } else {
        entry.schemaOmitted = true;
        schemasOmitted++;
        used += baseLen + '"schemaOmitted":true,'.length;
      }
      result.tools.push(entry);
    }
    if (schemasOmitted) result.schemasOmitted = schemasOmitted;
    if (toolsOmitted) result.toolsOmitted = toolsOmitted;
    if (schemasOmitted || toolsOmitted) {
      result.hint = 'The list hit its size budget. Call browser_webmcp_list with name:"<tool>" to get one tool with its full inputSchema.';
    }
    return done(result);
  }

  // action: 'call'
  const located = tools.map((tool) => ({ tool, frame: framePath(tool.window), frameUrl: frameUrlOf(tool.window) }));
  const named = located.filter((t) => t.tool.name === spec.name);
  if (named.length === 0) {
    return done({
      supported: true,
      code: 'TOOL_NOT_FOUND',
      error: `No WebMCP tool named "${String(spec.name).slice(0, 200)}" on this page.`,
      available: tools.slice(0, 200).map((t) => t.name),
    });
  }
  const atFrame = spec.frame ? named.filter((t) => t.frame === spec.frame) : named;
  if (atFrame.length === 0) {
    return done({
      supported: true,
      code: 'TOOL_NOT_FOUND',
      error: `No WebMCP tool named "${String(spec.name).slice(0, 200)}" in frame "${spec.frame}".`,
      frames: named.slice(0, 100).map((t) => ({ frame: t.frame, frameUrl: t.frameUrl })),
    });
  }
  if (atFrame.length > 1) {
    return done({
      supported: true,
      code: 'AMBIGUOUS_TOOL',
      error: `Several frames register "${spec.name}". Pass frame (from browser_webmcp_list) to pick one.`,
      frames: atFrame.slice(0, 100).map((t) => ({ frame: t.frame, frameUrl: t.frameUrl })),
    });
  }
  const { tool, frame, frameUrl } = atFrame[0];
  if (spec.frameUrl && spec.frameUrl !== frameUrl) {
    return done({
      supported: true,
      code: 'FRAME_CHANGED',
      error: `Frame "${frame}" now shows ${frameUrl}, not ${String(spec.frameUrl).slice(0, 500)}. List the tools again.`,
      frame,
      frameUrl,
    });
  }

  const otherFrameUrls = named.filter((t) => t.tool !== tool).map((t) => t.frameUrl);
  const { declarative, autoSubmit } = declarativeOf(tool, frameUrl, otherFrameUrls);
  if (!declarative && spec.formScanFailed) {
    // Fail closed: without the CDP scan a form in a closed shadow root would look
    // like an imperative tool and skip the gates below.
    return done({
      supported: true,
      code: 'FORM_SCAN_FAILED',
      error: `Could not verify whether "${tool.name}" is a form tool (the page's DOM could not be inspected in time), so it was not run. `
        + 'Try again; if it keeps failing, use the regular browser tools on this page.',
      tool: tool.name,
      frame,
      frameUrl,
    });
  }
  if (declarative && !autoSubmit) {
    return done({
      supported: true,
      code: 'DECLARATIVE_NEEDS_USER',
      error: `"${tool.name}" is a declarative form without toolautosubmit: the browser fills it and waits for the USER to submit, `
        + 'which the agent-control shield blocks. Fill and submit it with browser_fill_form + browser_click instead, or ask the user.',
      tool: tool.name,
      frame,
      frameUrl,
    });
  }
  const consequential = !!(tool.annotations && tool.annotations.consequentialHint === true);
  if ((consequential || declarative) && spec.confirm !== true) {
    return done({
      supported: true,
      code: 'CONFIRMATION_REQUIRED',
      error: declarative
        ? `"${tool.name}" submits a form (toolautosubmit). Ask the user first, then call again with confirm:true.`
        : `"${tool.name}" is marked consequential (real-world or irreversible effect). Ask the user first, then call again with confirm:true.`,
      reason: declarative ? 'autosubmit-form' : 'consequential',
      tool: tool.name,
      frame,
      frameUrl,
    });
  }

  let documentBefore = null;
  try {
    documentBefore = tool.window.document;
  } catch {
    /* unreadable: navigation detection falls back to "changed" */
  }
  const base = { supported: true, tool: tool.name, frame, frameUrl };
  if (tool.annotations && tool.annotations.untrustedContentHint === true) base.untrustedContentHint = true;
  const tombstones = globalThis.__bcWebmcpAborted;
  if (tombstones && tombstones[spec.callId]) {
    delete tombstones[spec.callId];
    return done({ ...base, status: 'canceled', timedOut: false, errorName: 'AbortError', error: 'Cancelled before the tool started.' });
  }
  const calls = globalThis.__bcWebmcpCalls || (globalThis.__bcWebmcpCalls = Object.create(null));
  const controller = new AbortController();
  calls[spec.callId] = controller;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, spec.timeoutMs);
  try {
    const value = await mc.executeTool(tool, spec.input || {}, { signal: controller.signal });
    const output = value === null || value === undefined ? null : String(value);
    const result = { ...base, status: 'completed', navigated: value === null, output };
    let json = done(result);
    if (output !== null && json.length > limits.budgetChars) {
      // Largest prefix whose ENCODED result fits: escaping (quotes, JSON text)
      // can double the length, so measure instead of estimating.
      result.outputTruncated = true;
      result.outputChars = output.length;
      let lo = 0;
      let hi = output.length;
      while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        result.output = output.slice(0, mid);
        if (done(result).length <= limits.budgetChars) lo = mid;
        else hi = mid - 1;
      }
      result.output = output.slice(0, lo);
      json = done(result);
    }
    return json;
  } catch (err) {
    if (controller.signal.aborted) return done({ ...base, status: 'canceled', timedOut, ...errorInfo(err) });
    let navigated;
    try {
      navigated = tool.window.document !== documentBefore;
    } catch {
      navigated = true;
    }
    if (navigated) return done({ ...base, status: 'unknown', navigated: true, ...errorInfo(err) });
    return done({ ...base, status: 'error', ...errorInfo(err) });
  } finally {
    clearTimeout(timer);
    delete calls[spec.callId];
  }
}

/**
 * The CDP expression for one runner call. cdpEvaluate always uses replMode,
 * which does NOT unwrap a returned promise — `(async fn)(spec)` would come back
 * as `{}` while the tool still ran — so the call is awaited at top level. The
 * spec travels as a JSON string: as an object literal, a `__proto__` key in the
 * tool input would set a prototype instead of a property.
 */
export function buildWebMcpExpression(spec) {
  const payload = JSON.stringify({ limits: WEBMCP_LIMITS, ...spec });
  return `await (${webmcpPageRun.toString()})(JSON.parse(${JSON.stringify(payload)}))`;
}
