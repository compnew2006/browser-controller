(function () {
  'use strict';
  if (window.__browserControllerInjected) return;
  window.__browserControllerInjected = true;

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
    try { chrome.runtime.sendMessage({ type: 'console', level, text }); } catch {}
  }

  console.log = (...a) => capture('log', ...a);
  console.warn = (...a) => capture('warn', ...a);
  console.error = (...a) => capture('error', ...a);
  console.info = (...a) => capture('info', ...a);
  console.debug = (...a) => capture('debug', ...a);

  window.addEventListener('error', (e) => {
    // Silence the well-known ResizeObserver loop warning: it's a benign browser
    // notice (element resized during its own observation callback), not a real
    // error. Every RO-based UI triggers it; capturing it just spams the console.
    if (e && typeof e.message === 'string' && e.message.indexOf('ResizeObserver loop') !== -1) return;
    capture('error', `Uncaught: ${e.message} at ${e.filename}:${e.lineno}`);
  });

  window.addEventListener('unhandledrejection', (e) => {
    capture('error', `Unhandled rejection: ${e.reason}`);
  });
})();
