/**
 * MAIN-world console capture. content.js runs in the extension's isolated
 * world, where patching `console` only sees the extension's own calls — the
 * page's console.log/warn/info/debug/error never reached browser_console.
 * This script patches the PAGE's console and hands each entry to content.js
 * as a JSON string on a private DOM event (object details don't cross
 * worlds). Uncaught errors / rejections are still captured by content.js.
 */
(function () {
  'use strict';
  if (window.__bcConsoleMain) return;
  Object.defineProperty(window, '__bcConsoleMain', { value: true });
  const EVENT = '__bc_console_entry';
  const LEVELS = ['log', 'info', 'warn', 'error', 'debug'];
  const fmt = (a) => {
    if (typeof a === 'string') return a;
    if (a instanceof Error) return `${a.name}: ${a.message}`;
    if (a && typeof a === 'object') {
      try { return JSON.stringify(a); } catch { return Object.prototype.toString.call(a); }
    }
    return String(a);
  };
  for (const level of LEVELS) {
    const orig = console[level];
    if (typeof orig !== 'function') continue;
    const patched = function (...args) {
      try {
        let text = args.map(fmt).join(' ');
        if (text.length > 2000) text = text.slice(0, 2000) + '…[truncated]';
        document.dispatchEvent(new CustomEvent(EVENT, { detail: JSON.stringify({ level, text }) }));
      } catch { /* never break the page's logging */ }
      return orig.apply(this, args);
    };
    try { console[level] = patched; } catch { /* frozen console */ }
  }
})();
