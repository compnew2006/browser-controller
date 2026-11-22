// Popup resize handle (Chrome extension popups are fixed-size; there is no
// native resize). Drives the document size from the draggable corner grip
// and persists the chosen width/height to chrome.storage.local so it is
// restored on every open. Split out of popup.js (Task 9) so popup.js stays
// under the 600-line maintenance gate; the size range follows the plan's
// responsive shell: 320px floor, 640px ceiling (Design §7).
export function bindPopupResizer() {
  // ── Resizable popup ────────────────────────────────────────────────────────
  // Chrome extension popups are fixed-size; there's no native resize. We drive
  // the document size from a draggable corner handle and persist the chosen
  // width/height to chrome.storage.local so it's restored on every open.
  const resizerEl = document.getElementById('resizer');
  const MIN_W = 320;
  const MIN_H = 380;
  const MAX_W = 640;
  const MAX_H = 760;
  const SIZE_KEY = 'popupSize';

  function applySize(w, h) {
    const cw = Math.min(MAX_W, Math.max(MIN_W, Math.round(w)));
    const ch = Math.min(MAX_H, Math.max(MIN_H, Math.round(h)));
    document.documentElement.style.width = `${cw}px`;
    document.documentElement.style.height = `${ch}px`;
    return { w: cw, h: ch };
  }

  // Restore last chosen size (fall back to the CSS default of 380x540).
  chrome.storage.local.get(SIZE_KEY, (saved) => {
    if (saved && saved[SIZE_KEY]) {
      applySize(saved[SIZE_KEY].w, saved[SIZE_KEY].h);
    }
  });

  let dragging = false;
  // Anchor deltas in SCREEN coordinates. clientX/clientY are relative to the
  // popup viewport, and Chrome slides the whole viewport as the popup resizes
  // (it keeps the right edge pinned to the toolbar icon). Reading clientX during
  // a resize therefore feeds back into the width math and produces visible jitter
  // (grow → slide → clientX jumps → shrink → slide back → repeat). screenX is
  // anchored to the physical monitor and never moves, so it's jitter-free.
  let startScreenX = 0;
  let startScreenY = 0;
  let startW = 0;
  let startH = 0;
  let saveTimer = null;
  // Coalesce multiple mousemove events into one layout write per animation frame.
  let pendingTargetW = 0;
  let pendingTargetH = 0;
  let rafHandle = 0;

  function flushResize() {
    rafHandle = 0;
    applySize(pendingTargetW, pendingTargetH);
  }

  resizerEl.addEventListener('mousedown', (e) => {
    dragging = true;
    startScreenX = e.screenX;
    startScreenY = e.screenY;
    const cs = getComputedStyle(document.documentElement);
    startW = parseInt(cs.width, ) || 380;
    startH = parseInt(cs.height, ) || 540;
    pendingTargetW = startW;
    pendingTargetH = startH;
    e.preventDefault();
  });

  document.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    // The grip is at bottom-LEFT and Chrome anchors the popup to the top-right.
    // Fixed edges are top + right. With the cursor in screen space:
    //   - down  → height grows  (startH + Δy)
    //   - right → width SHRINKS (startW - Δx) — cursor approaches the fixed right edge
    //   - left  → width grows                    — cursor pulls the left edge out
    pendingTargetW = startW - (e.screenX - startScreenX);
    pendingTargetH = startH + (e.screenY - startScreenY);
    // One write per frame: collapsing a burst of mousemove events avoids layout
    // thrash and keeps the resize smooth under fast cursor movement.
    if (!rafHandle) {
      rafHandle = requestAnimationFrame(flushResize);
    }
  });

  function endDrag() {
    if (!dragging) return;
    dragging = false;
    // Apply the very last mousemove target synchronously so the persisted size
    // matches what the user actually sees, even if a scheduled raf hadn't fired.
    const final = applySize(pendingTargetW, pendingTargetH);
    if (rafHandle) {
      // cancel the now-redundant frame so it doesn't overwrite the final size
      cancelAnimationFrame(rafHandle);
      rafHandle = 0;
    }
    // debounce storage write in case the browser fires several mouseups
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      chrome.storage.local.set({ [SIZE_KEY]: { w: final.w, h: final.h } });
    }, 150);
  }
  document.addEventListener('mouseup', endDrag);
  document.addEventListener('mouseleave', endDrag);
}
