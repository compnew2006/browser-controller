/**
 * CDP-backed handlers (extracted from background.js): run_action and
 * upload_file — the two tools that cannot be implemented with
 * chrome.scripting (CSP bypass / DOM.setFileInputFiles).
 */
import { resolveTab, safeExec } from '../lib/page-exec.js';
import { MAX_RESULT_CHARS } from '../lib/state.js';

export async function handleRunAction(params, _sessionId, _agentName, signal) {
  const { tabId, code, actionParams = {} } = params;
  if (!code) throw new Error('code is required');
  const tab = await resolveTab(tabId);

  // run_action stays on CDP (plan decision: CDP-only, can't be scripted —
  // it bypasses page CSP via the debugger protocol, unlike browser_evaluate).
  await chrome.debugger.attach({ tabId: tab.id }, '1.3');
  try {
    const paramsJson = JSON.stringify(actionParams);
    // Dual mode: accept EITHER a {execute:function()} tool wrapper (legacy
    // skill syntax) OR a plain JS expression/statement (simple usage like
    // "document.title" or "var x=...; JSON.stringify(x)"). Previously only
    // the wrapper worked; any plain expression returned "No execute function
    // found", making the tool unusable for simple extraction tasks.
    const expression = `(async function() {
      try {
        var result = await (${code});
        if (result && typeof result.execute === "function") {
          result = await result.execute(${paramsJson});
        }
        if (result && Array.isArray(result.content)) {
          return result;
        }
        var raw = (typeof result === 'object' && result !== null) ? JSON.stringify(result) : String(result);
        return { content: [{ type: 'text', text: raw }] };
      } catch(e) {
        return { error: e.message, stack: e.stack };
      }
    })()`;

    const { result, exceptionDetails } = await chrome.debugger.sendCommand(
      { tabId: tab.id },
      'Runtime.evaluate',
      { expression, awaitPromise: true, returnByValue: true },
    );

    // Cancellation: if the caller (daemon/bridge) aborted while the page was
    // evaluating (e.g. a long IIFE), the result is now useless — drop it so the
    // tab mutex releases immediately and the next caller isn't queued behind a
    // dead request.
    if (signal?.aborted) {
      return { success: false, error: 'aborted' };
    }
    if (exceptionDetails) {
      return { success: false, error: exceptionDetails.exception?.description || exceptionDetails.text };
    }
    // Cap oversized results (same policy as handleEvaluate).
    const raw = JSON.stringify(result.value);
    if (raw && raw.length > MAX_RESULT_CHARS) {
      return {
        success: true,
        result: { content: [{ type: 'text', text: raw.slice(0, MAX_RESULT_CHARS) + '…[truncated]' }] },
        truncated: true,
        fullLength: raw.length,
      };
    }
    return { success: true, result: result.value };
  } finally {
    try { await chrome.debugger.detach({ tabId: tab.id }); } catch {}
  }
}

export async function handleUploadFile(params) {
  const { tabId, ref, selector, filePath, files: fileList } = params;
  const tab = await resolveTab(tabId);
  const filePaths = fileList || (filePath ? [filePath] : []);
  if (filePaths.length === 0) throw new Error('filePath or files required');

  let sel = 'input[type="file"]';
  if (ref) sel = `[data-mcp-ref="${ref}"]`;
  else if (selector) sel = selector;

  // Verify the target BEFORE the CDP round-trip: CDP's DOM.querySelector
  // happily resolves any node, and DOM.setFileInputFiles on a non-file input
  // fails with an opaque protocol error (or worse, on some Chrome versions,
  // appears to succeed). React onChange handlers also require a change/input
  // event after the files are set — CDP doesn't fire one.
  const check = await safeExec(tab.id, (s) => {
    const el = document.querySelector(s);
    if (!el) return { found: false };
    return {
      found: true,
      isFileInput: el.tagName === 'INPUT' && el.type === 'file',
      multiple: !!el.multiple,
    };
  }, [sel]).catch(() => null);
  if (check && check.found) {
    if (!check.isFileInput) throw new Error(`Element matching ${sel} is not an <input type="file">.`);
    if (filePaths.length > 1 && !check.multiple) {
      throw new Error(`File input matching ${sel} does not accept multiple files.`);
    }
  }

  // upload_file stays on CDP (DOM.setFileInputFiles is CDP-only).
  await chrome.debugger.attach({ tabId: tab.id }, '1.3');
  try {
    await chrome.debugger.sendCommand({ tabId: tab.id }, 'DOM.enable', {});
    const { root } = await chrome.debugger.sendCommand({ tabId: tab.id }, 'DOM.getDocument', {});

    const { nodeId } = await chrome.debugger.sendCommand({ tabId: tab.id }, 'DOM.querySelector', {
      nodeId: root.nodeId,
      selector: sel,
    });

    if (!nodeId) throw new Error(`File input not found with selector: ${sel}`);

    await chrome.debugger.sendCommand({ tabId: tab.id }, 'DOM.setFileInputFiles', {
      files: filePaths,
      nodeId,
    });
  } finally {
    try { await chrome.debugger.detach({ tabId: tab.id }); } catch {}
  }

  // Fire the events React/Vue file inputs listen for (CDP sets files without
  // notifying the page). Best-effort: the files are already set either way.
  try {
    await safeExec(tab.id, (s) => {
      const el = document.querySelector(s);
      if (!el) return;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }, [sel]);
  } catch { /* shielded page / tab gone — files were still set via CDP */ }

  return { success: true, files: filePaths, selector: sel };
}
