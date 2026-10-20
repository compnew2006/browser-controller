(function () {
  'use strict';
  if (window.__browserControllerInjected) return;
  window.__browserControllerInjected = true;
  // A new top-level document: its console starts empty. Sent before any entry of
  // this document is relayed, so it can never drop one of the new page's logs.
  if (window === window.top) {
    try { chrome.runtime.sendMessage({ type: 'console-reset' }); } catch {}
  }

  const orig = {
    log: console.log,
    warn: console.warn,
    error: console.error,
    info: console.info,
    debug: console.debug,
  };

  function capture(level, ...args) {
    orig[level].apply(console, args);
    const text = args.map(a => {
      if (typeof a === 'object') { try { return JSON.stringify(a); } catch { return String(a); } }
      return String(a);
    }).join(' ');
    // Drop well-known benign warnings so they don't spam the captured log:
    //   - ResizeObserver loop (element resized during its own RO callback)
    //   - "message channel closed before a response was received" — happens on
    //     heavy SPA pages (Meta.ai etc.) when an async onMessage sender closes
    //     before the listener replies. Harmless; nothing our code can do about it.
    if (text.indexOf('ResizeObserver loop') !== -1) return;
    if (text.indexOf('message channel closed before a response was received') !== -1) return;
    // Cap the entry BEFORE shipping it: the per-tab buffer only caps the ENTRY
    // COUNT (200), so one console.log(hugeString) would otherwise pin the full
    // payload in service-worker memory and return all of it to the agent.
    const capped = text.length > 2000 ? text.slice(0, 2000) + '…[truncated]' : text;
    try { chrome.runtime.sendMessage({ type: 'console', level, text: capped }); } catch {}
  }

  console.log = (...a) => capture('log', ...a);
  console.warn = (...a) => capture('warn', ...a);
  console.error = (...a) => capture('error', ...a);
  console.info = (...a) => capture('info', ...a);
  console.debug = (...a) => capture('debug', ...a);

  // Page console entries from console-main.js (MAIN world), JSON on a DOM event.
  // Uncaught errors and unhandled rejections come through the same channel: this
  // isolated world does not see the page's own error events.
  document.addEventListener('__bc_console_entry', (e) => {
    let entry;
    try { entry = JSON.parse(e.detail); } catch { return; }
    if (!entry || typeof entry.text !== 'string') return;
    if (entry.text.indexOf('ResizeObserver loop') !== -1) return;
    const msg = { type: 'console', level: String(entry.level || 'log'), text: entry.text.slice(0, 2100) };
    if (entry.kind) msg.kind = String(entry.kind);
    if (typeof entry.stack === 'string') msg.stack = entry.stack.slice(0, 1000);
    try { chrome.runtime.sendMessage(msg); } catch {}
  });
})();
