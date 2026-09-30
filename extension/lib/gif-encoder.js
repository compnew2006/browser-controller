/**
 * Minimal animated-GIF encoder (GIF89a) for action recordings — no
 * dependencies, runs in the service worker and in node tests.
 *
 * Palette: a fixed 256-colour table (6×6×6 colour cube + 40 greys). UI
 * screenshots are dominated by greys/white and flat colours, so a fixed
 * palette looks fine, needs no per-frame quantisation and keeps encoding
 * fast. Pixel data is LZW-compressed as the format requires.
 */

const GREYS = 40;

/** 256×RGB fixed palette: 216-colour cube followed by 40 greys. */
export function buildPalette() {
  const pal = new Uint8Array(256 * 3);
  let i = 0;
  for (let r = 0; r < 6; r++) for (let g = 0; g < 6; g++) for (let b = 0; b < 6; b++) {
    pal[i++] = r * 51; pal[i++] = g * 51; pal[i++] = b * 51;
  }
  for (let k = 0; k < GREYS; k++) {
    const v = Math.round((k * 255) / (GREYS - 1));
    pal[i++] = v; pal[i++] = v; pal[i++] = v;
  }
  return pal;
}

/** RGBA pixels → palette indices (greyish pixels use the finer grey ramp). */
export function indexPixels(rgba, count) {
  const out = new Uint8Array(count);
  for (let p = 0, q = 0; p < count; p++, q += 4) {
    const r = rgba[q];
    const g = rgba[q + 1];
    const b = rgba[q + 2];
    const max = r > g ? (r > b ? r : b) : (g > b ? g : b);
    const min = r < g ? (r < b ? r : b) : (g < b ? g : b);
    if (max - min < 14) {
      out[p] = 216 + Math.round((((r + g + b) / 3) * (GREYS - 1)) / 255);
    } else {
      out[p] = Math.round(r / 51) * 36 + Math.round(g / 51) * 6 + Math.round(b / 51);
    }
  }
  return out;
}

/** GIF LZW compression of palette indices (min code size 8), as sub-blocks. */
export function lzwEncode(indices) {
  const MIN = 8;
  const CLEAR = 1 << MIN;
  const EOI = CLEAR + 1;
  const bytes = [];
  let cur = 0;
  let bits = 0;
  let codeSize = MIN + 1;
  const emit = (code) => {
    cur |= code << bits;
    bits += codeSize;
    while (bits >= 8) { bytes.push(cur & 0xff); cur >>>= 8; bits -= 8; }
  };
  let dict = new Map();
  let next = EOI + 1;
  emit(CLEAR);
  let prefix = indices.length ? indices[0] : 0;
  for (let i = 1; i < indices.length; i++) {
    const k = indices[i];
    const key = prefix * 256 + k;
    const hit = dict.get(key);
    if (hit !== undefined) { prefix = hit; continue; }
    emit(prefix);
    if (next < 4096) {
      dict.set(key, next++);
      if (next > (1 << codeSize) && codeSize < 12) codeSize++;
    } else {
      emit(CLEAR);
      dict = new Map();
      next = EOI + 1;
      codeSize = MIN + 1;
    }
    prefix = k;
  }
  if (indices.length) emit(prefix);
  emit(EOI);
  if (bits > 0) bytes.push(cur & 0xff);
  // Split into ≤255-byte sub-blocks.
  const out = [MIN];
  for (let i = 0; i < bytes.length; i += 255) {
    const chunk = bytes.slice(i, i + 255);
    out.push(chunk.length, ...chunk);
  }
  out.push(0);
  return out;
}

/**
 * frames: [{ rgba: Uint8ClampedArray|Uint8Array (width*height*4), delayMs }]
 * All frames share width×height. Returns the GIF file bytes.
 */
export function encodeGif(width, height, frames, { loop = 0 } = {}) {
  const pal = buildPalette();
  const out = [];
  const u16 = (v) => { out.push(v & 0xff, (v >> 8) & 0xff); };
  const str = (s) => { for (const ch of s) out.push(ch.charCodeAt(0)); };
  str('GIF89a');
  u16(width); u16(height);
  out.push(0xf7, 0, 0); // global colour table, 8 bits/channel, 256 entries
  for (const v of pal) out.push(v);
  // NETSCAPE2.0 loop extension
  out.push(0x21, 0xff, 0x0b); str('NETSCAPE2.0'); out.push(0x03, 0x01); u16(loop); out.push(0);
  for (const f of frames) {
    const delay = Math.max(2, Math.round((f.delayMs ?? 500) / 10));
    out.push(0x21, 0xf9, 0x04, 0x00); u16(delay); out.push(0, 0); // graphic control
    out.push(0x2c); u16(0); u16(0); u16(width); u16(height); out.push(0); // image descriptor
    const data = lzwEncode(indexPixels(f.rgba, width * height));
    for (const b of data) out.push(b);
  }
  out.push(0x3b);
  return Uint8Array.from(out);
}

/** Paint a red ring (click marker) into RGBA pixels. */
export function drawMarker(rgba, width, height, cx, cy, radius = 9) {
  for (let y = Math.max(0, Math.floor(cy - radius - 2)); y <= Math.min(height - 1, Math.ceil(cy + radius + 2)); y++) {
    for (let x = Math.max(0, Math.floor(cx - radius - 2)); x <= Math.min(width - 1, Math.ceil(cx + radius + 2)); x++) {
      const d = Math.hypot(x - cx, y - cy);
      if (d <= radius + 1.5 && d >= radius - 1.5) {
        const q = (y * width + x) * 4;
        rgba[q] = 255; rgba[q + 1] = 0; rgba[q + 2] = 0; rgba[q + 3] = 255;
      }
    }
  }
}
