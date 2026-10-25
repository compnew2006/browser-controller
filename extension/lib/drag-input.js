/**
 * What a drag needs beyond plain mouse input (browser_click dragTo): no text
 * selection at the press, frames in a background tab (the wheel of
 * browser_scroll needs them too), and HTML5 drags handed back by Chrome so they
 * can be played as drag events.
 */
import { subscribeCdpEvents } from './cdp-session.js';
import { safeExec } from './page-exec.js';
import { sleep } from './timing.js';

/**
 * Before a drag: no text selected. A press on selected text starts Chrome's own
 * text drag, and the page then never gets its mouseup (an earlier drag over text
 * leaves such a selection). Never throws: a page that refuses script has none to clear.
 */
export async function clearSelection(tabId) {
  try { await safeExec(tabId, () => { window.getSelection?.()?.removeAllRanges(); return {}; }, []); } catch { /* nothing to clear */ }
}

/** Page-side: 'arm' watches for the page's own dragstart; 'check' says whether one ran and the page let it go on (and stops watching). */
function pageDragStart(op) {
  const g = globalThis;
  if (g.__bcDragWatch) window.removeEventListener('dragstart', g.__bcDragWatch, true);
  const seen = g.__bcDragStart;
  delete g.__bcDragWatch;
  delete g.__bcDragStart;
  if (op !== 'arm') return !!seen && !seen.defaultPrevented;
  g.__bcDragWatch = (e) => { g.__bcDragStart = e; };
  window.addEventListener('dragstart', g.__bcDragWatch, true);
  return true;
}

/**
 * HTML5 drag and drop (draggable=true, links, images). Left alone, Chrome hands
 * such a drag to the operating system's drag loop, which follows the real mouse,
 * not the debugger's (Windows and macOS end it at once). With interception on,
 * Chrome gives the drag's data back instead (Input.dragIntercepted), and the
 * caller plays the rest of the gesture as drag events: dragenter, dragover, drop.
 */
export async function interceptDrags(tabId, send) {
  let data = null;
  let wake = () => {};
  const off = subscribeCdpEvents(tabId, (method, params) => {
    if (method === 'Input.dragIntercepted') { data = params.data; wake(); }
  });
  const on = await send('Input.setInterceptDrags', { enabled: true }).then(() => true, () => false);
  const watch = (op) => safeExec(tabId, pageDragStart, [op]).catch(() => false);
  await watch('arm');
  let checked = false;
  return {
    get data() { return data; },
    /** The drag's data when the page started one; waits up to `ms` for Chrome to hand it over. */
    async started(ms = 1_000) {
      if (data) return data;
      checked = true;
      if (!on || !(await watch('check'))) return null;
      if (!data) await Promise.race([new Promise((r) => { wake = r; }), sleep(ms)]);
      return data;
    },
    async stop() {
      off();
      if (!checked) await watch('check');
      if (on) await send('Input.setInterceptDrags', { enabled: false }).catch(() => {});
    },
  };
}

/**
 * A background tab draws no frames, and Chrome holds each mouse move for the next
 * frame: about 1 s per move once the tab has been hidden a few seconds, so a drag
 * took 7 s or timed out. A screencast keeps frames coming (the way a background
 * screenshot does) while `fn` runs; tiny frames, each acknowledged, nothing kept.
 */
export async function withFrames(tabId, send, fn) {
  const off = subscribeCdpEvents(tabId, (method, params) => {
    if (method === 'Page.screencastFrame') send('Page.screencastFrameAck', { sessionId: params.sessionId }).catch(() => {});
  });
  const started = await send('Page.startScreencast', { format: 'jpeg', quality: 1, maxWidth: 32, maxHeight: 32 }).then(() => true, () => false);
  try {
    return await fn();
  } finally {
    off();
    if (started) await send('Page.stopScreencast').catch(() => {});
  }
}
