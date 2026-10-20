/**
 * MAIN-world console capture. content.js runs in the extension's isolated
 * world, where patching `console` only sees the extension's own calls — the
 * page's console calls never reached browser_console. This script patches the
 * PAGE's console and hands each entry to content.js as a JSON string on a
 * private DOM event (object details don't cross worlds). It also listens for the
 * page's uncaught errors and unhandled rejections here: the isolated world does
 * not see the page's own error events.
 *
 * Trade-off: Chrome attributes a wrapped console call to this script in DevTools.
 * The short stack kept with error entries shows the page code that really logged it.
 */
(function () {
  'use strict';
  if (window.__bcConsoleMain) return;
  Object.defineProperty(window, '__bcConsoleMain', { value: true });
  const EVENT = '__bc_console_entry';
  const LEVELS = ['log', 'info', 'warn', 'error', 'debug'];
  const STACK_FRAMES = 5;
  const STACK_MAX = 1000;
  const fmt = (a) => {
    if (typeof a === 'string') return a;
    if (a instanceof Error) return `${a.name}: ${a.message}`;
    if (a && typeof a === 'object') {
      try { return JSON.stringify(a); } catch { return Object.prototype.toString.call(a); }
    }
    return String(a);
  };
  // The "at …" lines of a V8 stack trace.
  const atLines = (stack) => (typeof stack === 'string' ? stack.split('\n').filter((line) => /^\s*at /.test(line)) : []);
  // The top few frames as one short string.
  const describeStack = (lines) => {
    const top = lines.slice(0, STACK_FRAMES);
    return top.length ? top.join('\n').slice(0, STACK_MAX) : undefined;
  };
  // kind / stack are optional: JSON.stringify drops the ones left undefined.
  function emit(level, text, kind, stack) {
    try {
      const body = text.length > 2000 ? text.slice(0, 2000) + '…[truncated]' : text;
      document.dispatchEvent(new CustomEvent(EVENT, { detail: JSON.stringify({ level, text: body, kind, stack }) }));
    } catch { /* never break the page's logging */ }
  }

  for (const level of LEVELS) {
    const orig = console[level];
    if (typeof orig !== 'function') continue;
    const patched = function (...args) {
      try {
        // Stack of the page code that logged it (frame 0 is this wrapper): an Error argument's own stack wins.
        const err = args.find((a) => a instanceof Error);
        const stack = level === 'error'
          ? describeStack(err ? atLines(err.stack) : atLines(new Error().stack).slice(1))
          : undefined;
        emit(level, args.map(fmt).join(' '), undefined, stack);
      } catch { /* never break the page's logging */ }
      return orig.apply(this, args);
    };
    try { console[level] = patched; } catch { /* frozen console */ }
  }

  const origAssert = console.assert;
  if (typeof origAssert === 'function') {
    const patchedAssert = function (condition, ...args) {
      try {
        if (!condition) {
          const text = ['Assertion failed' + (args.length ? ':' : ''), ...args].map(fmt).join(' ');
          emit('error', text, undefined, describeStack(atLines(new Error().stack).slice(1)));
        }
      } catch { /* never break the page's logging */ }
      return origAssert.apply(this, [condition, ...args]);
    };
    try { console.assert = patchedAssert; } catch { /* frozen console */ }
  }

  window.addEventListener('error', (e) => {
    // The ResizeObserver loop notice is benign: every RO-based UI triggers it.
    if (typeof e.message === 'string' && e.message.indexOf('ResizeObserver loop') !== -1) return;
    const where = e.filename ? ` at ${e.filename}:${e.lineno}:${e.colno}` : '';
    emit('error', `Uncaught ${e.message || 'error'}${where}`, 'uncaught', describeStack(atLines(e.error && e.error.stack)));
  });

  window.addEventListener('unhandledrejection', (e) => {
    const reason = e.reason;
    const text = reason instanceof Error ? `${reason.name}: ${reason.message}` : fmt(reason);
    emit('error', `Unhandled rejection: ${text}`, 'rejection', describeStack(reason instanceof Error ? atLines(reason.stack) : []));
  });
})();
