import { describe, expect, it } from 'vitest';
import { encodeGif, lzwEncode, indexPixels, buildPalette, drawMarker } from '../extension/lib/gif-encoder.js';

/** Reference GIF LZW decoder (spec algorithm) for round-trip checks. */
function lzwDecode(data: number[]): number[] {
  const min = data[0];
  const bytes: number[] = [];
  let i = 1;
  while (data[i] !== 0) { const n = data[i]; bytes.push(...data.slice(i + 1, i + 1 + n)); i += n + 1; }
  const clear = 1 << min;
  const eoi = clear + 1;
  let size = min + 1;
  let dict: number[][] = [];
  const reset = () => { dict = []; for (let k = 0; k < clear; k++) dict[k] = [k]; dict[clear] = []; dict[eoi] = []; size = min + 1; };
  reset();
  const out: number[] = [];
  let bitPos = 0;
  const read = () => {
    let code = 0;
    for (let b = 0; b < size; b++) {
      const byte = bytes[(bitPos + b) >> 3];
      if (((byte >> ((bitPos + b) & 7)) & 1) === 1) code |= 1 << b;
    }
    bitPos += size;
    return code;
  };
  let prev: number[] | null = null;
  for (;;) {
    const code = read();
    if (code === clear) { reset(); prev = null; continue; }
    if (code === eoi) break;
    let entry: number[];
    if (dict[code]) entry = dict[code];
    else if (prev) entry = [...prev, prev[0]];
    else throw new Error('bad code');
    out.push(...entry);
    if (prev) {
      dict.push([...prev, entry[0]]);
      if (dict.length === (1 << size) && size < 12) size++;
    }
    prev = entry;
  }
  return out;
}

describe('GIF encoder', () => {
  it('LZW round-trips short, repetitive and dictionary-overflowing data', () => {
    const cases = [
      [5],
      [1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
      Array.from({ length: 5000 }, (_, i) => (i * 7) % 256),
      Array.from({ length: 60000 }, (_, i) => ((i * 2654435761) >>> 24) & 0xff), // forces dictionary resets
    ];
    for (const c of cases) expect(lzwDecode(lzwEncode(Uint8Array.from(c)))).toEqual(c);
  });

  it('maps greys to the grey ramp and colours to the cube', () => {
    const pal = buildPalette();
    const idx = indexPixels(Uint8Array.from([255, 255, 255, 255, 0, 0, 0, 255, 255, 0, 0, 255, 128, 128, 128, 255]), 4);
    expect([pal[idx[0] * 3], pal[idx[0] * 3 + 1]]).toEqual([255, 255]);
    expect(pal[idx[1] * 3]).toBe(0);
    expect([pal[idx[2] * 3], pal[idx[2] * 3 + 1], pal[idx[2] * 3 + 2]]).toEqual([255, 0, 0]);
    expect(idx[3]).toBeGreaterThanOrEqual(216);
  });

  it('writes a well-formed looping GIF89a with one image per frame', () => {
    const w = 4; const h = 3;
    const frame = (v: number) => ({ rgba: new Uint8Array(w * h * 4).fill(v), delayMs: 400 });
    const f2 = frame(200);
    drawMarker(f2.rgba, w, h, 1, 1, 1);
    const gif = encodeGif(w, h, [frame(0), f2]);
    const text = String.fromCharCode(...gif.slice(0, 6));
    expect(text).toBe('GIF89a');
    expect(gif[6] | (gif[7] << 8)).toBe(w);
    expect(gif[8] | (gif[9] << 8)).toBe(h);
    expect(String.fromCharCode(...gif.slice(13 + 768 + 3, 13 + 768 + 14))).toBe('NETSCAPE2.0');
    // one graphic-control extension (21 F9 04) per frame
    expect(gif.filter((b, i) => b === 0x21 && gif[i + 1] === 0xf9 && gif[i + 2] === 0x04).length).toBe(2);
    expect(gif[gif.length - 1]).toBe(0x3b);
  });
});
