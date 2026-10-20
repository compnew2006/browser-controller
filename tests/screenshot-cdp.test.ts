import { describe, it, expect, beforeEach } from 'vitest';

const cdp: Array<{ method: string; params: Record<string, unknown> }> = [];
const tabs = new Map<number, { id: number; url: string; windowId: number; active: boolean }>();
const updates: Array<[number, unknown]> = [];
let captureHangs = false;
/** A background tab that the debugger can paint (Page.captureScreenshot answers for it). */
let backgroundPaints = false;
let dpr = 1;
let imageData = 'CDPDATA';
/** What window.devicePixelRatio reports (null = the page can't answer). */
let pageDpr: number | null = null;
/** When set, the capture is as big as a real one: clip × scale × this true ratio. */
let trueDpr: number | null = null;
/** Full content height of the page (CSS px). */
let contentHeight = 3000;
/** What the page reports for innerWidth × innerHeight (CSS px). */
let viewport: [number, number] = [1000, 600];
/** Size of the captured window image (device px), as createImageBitmap reports it. */
let bitmapSize = { width: 1000, height: 600 };
/** Output size in bytes of a canvas encode, by MIME type. */
let encodeBytes: (type: string) => number = () => 64;
/** Every drawImage call made on the service-worker canvas. */
const drawn: unknown[][] = [];
/** Every canvas encode: MIME type, quality (0..1) and output size. */
const encoded: Array<{ type: string; quality?: number; width: number; height: number }> = [];
/** A tiny PNG header (signature + IHDR) of the given size, base64. */
function pngOf(w: number, h: number): string {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8); b.write('IHDR', 12); b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20);
  return b.toString('base64');
}

(globalThis as unknown as { createImageBitmap: unknown }).createImageBitmap = async () => ({
  width: bitmapSize.width, height: bitmapSize.height, close() {},
});
(globalThis as unknown as { OffscreenCanvas: unknown }).OffscreenCanvas = class {
  constructor(public width: number, public height: number) {}
  getContext() {
    return { imageSmoothingQuality: 'low', drawImage: (...args: unknown[]) => { drawn.push(args); } };
  }
  async convertToBlob(opts: { type: string; quality?: number }) {
    encoded.push({ type: opts.type, quality: opts.quality, width: this.width, height: this.height });
    return new Blob([new Uint8Array(encodeBytes(opts.type))], { type: opts.type });
  }
};

(globalThis as unknown as { chrome: unknown }).chrome = {
  tabs: {
    get: async (id: number) => tabs.get(id),
    query: async () => [...tabs.values()].filter((t) => t.active),
    update: async (id: number, props: { active?: boolean }) => {
      updates.push([id, props]);
      if (props.active) for (const t of tabs.values()) t.active = t.id === id;
      return tabs.get(id);
    },
    captureVisibleTab: async () => `data:image/png;base64,${Buffer.from('PNG').toString('base64')}`,
    onRemoved: { addListener: () => {} },
  },
  windows: { get: async () => ({ width: 1200, height: 900 }) },
  // Zero-argument page functions answer with the viewport; the rest with nothing.
  scripting: {
    executeScript: async (o: { args?: unknown[] }) => [{ result: (o.args ?? []).length === 0 ? viewport : null }],
  },
  storage: { session: { get: async () => ({}), set: async () => {} }, local: { get: async () => ({}), set: async () => {} } },
  action: { setBadgeBackgroundColor: () => {}, setBadgeText: () => {} },
  runtime: { sendMessage: async () => {}, onMessage: { addListener: () => {} } },
  alarms: { create: () => {}, onAlarm: { addListener: () => {} } },
  webRequest: { onCompleted: { addListener: () => {} } },
  debugger: {
    attach: async () => {},
    detach: async () => {},
    onDetach: { addListener: () => {} },
    sendCommand: async (_t: { tabId: number }, method: string, params: Record<string, unknown> = {}) => {
      cdp.push({ method, params });
      if (method === 'Runtime.evaluate') {
        if (String(params.expression).includes('devicePixelRatio')) {
          if (pageDpr === null) throw new Error('no page');
          return { result: { value: pageDpr } };
        }
        return { result: { value: 1000 } };
      }
      if (method === 'Page.getLayoutMetrics') {
        return {
          cssVisualViewport: { clientWidth: 1000, clientHeight: 600, pageX: 0, pageY: 50 },
          visualViewport: { clientWidth: 1000 * dpr, clientHeight: 600 * dpr },
          cssContentSize: { width: 1000, height: contentHeight },
        };
      }
      if (method === 'Page.captureScreenshot') {
        const tab = tabs.get(_t.tabId);
        if (captureHangs || (!tab?.active && !backgroundPaints)) return new Promise(() => {});
        if (trueDpr !== null) {
          const clip = params.clip as { width: number; height: number; scale: number };
          return { data: pngOf(Math.round(clip.width * clip.scale * trueDpr), Math.round(clip.height * clip.scale * trueDpr)) };
        }
        return { data: imageData };
      }
      return {};
    },
  },
};

const { handleScreenshot } = await import('../extension/handlers/tabs.js');
const session = await import('../extension/lib/cdp-session.js');
const scripting = (globalThis as unknown as { chrome: { scripting: { executeScript: unknown } } }).chrome.scripting;
const defaultExecute = scripting.executeScript;

const captures = () => cdp.filter((c) => c.method === 'Page.captureScreenshot');

describe('browser_screenshot', () => {
  beforeEach(async () => {
    cdp.length = 0;
    updates.length = 0;
    drawn.length = 0;
    encoded.length = 0;
    captureHangs = false;
    backgroundPaints = false;
    dpr = 1;
    imageData = 'CDPDATA';
    pageDpr = null;
    trueDpr = null;
    contentHeight = 3000;
    viewport = [1000, 600];
    bitmapSize = { width: 1000, height: 600 };
    encodeBytes = () => 64;
    scripting.executeScript = defaultExecute;
    tabs.clear();
    tabs.set(1, { id: 1, url: 'https://a.test', windowId: 7, active: true });
    tabs.set(2, { id: 2, url: 'https://b.test', windowId: 7, active: false });
    await session.detachCdp(1);
    await session.detachCdp(2);
  });

  it('reads the visible viewport with captureVisibleTab: no debugger, scale and maxWidth applied', async () => {
    const res = await handleScreenshot({ tabId: 1, format: 'jpeg', quality: 60, maxWidth: 500 });
    expect(res).toMatchObject({ success: true, via: 'visible', format: 'jpeg', width: 500, height: 300, frame: { scale: 0.5, origin: [0, 0], viewport: [1000, 600] } });
    expect(captures()).toHaveLength(0);
    expect(encoded.at(-1)).toMatchObject({ type: 'image/jpeg', quality: 0.6, width: 500, height: 300 });
    expect(drawn[0].slice(1)).toEqual([0, 0, 1000, 600, 0, 0, 500, 300]);
  });

  it('reports the pixel mapping from the real image size (device pixel ratio 2), capped at 1568 px', async () => {
    bitmapSize = { width: 2000, height: 1200 }; // a 1000x600 CSS viewport at DPR 2
    const res = await handleScreenshot({ tabId: 1, format: 'png' });
    // The longest side is 2000 device px; it is cut to the 1568 px image limit.
    expect(res).toMatchObject({ width: 1568, height: 941, frame: { scale: 1.568, origin: [0, 0] } });
    expect(res.note).toMatch(/1568 px longest side/);
    // maxWidth caps the IMAGE, so the scale accounts for the ratio.
    const small = await handleScreenshot({ tabId: 1, format: 'png', maxWidth: 800 });
    expect(small).toMatchObject({ width: 800, height: 480, frame: { scale: 0.8 } });
  });

  it('a page that does not report its size is captured without a coordinate frame', async () => {
    scripting.executeScript = async () => [{ result: null }];
    const res = await handleScreenshot({ tabId: 1, format: 'png' });
    expect(res).toMatchObject({ success: true, via: 'visible' });
    expect(res).not.toHaveProperty('frame');
  });

  it('ref/selector screenshots just that element (with a small margin), cropped at scale 1', async () => {
    const pageCalls: unknown[][] = [];
    // The page reports the element's top-level box after scrolling it into view.
    scripting.executeScript = async (o: { args?: unknown[] }) => {
      const args = o.args ?? [];
      pageCalls.push(args);
      if (args.length === 0) return [{ result: viewport }];
      return [{ result: { success: true, region: { x: 96, y: 196, width: 58, height: 38 }, clipped: false } }];
    };
    const res = await handleScreenshot({ tabId: 1, ref: 's1-4' });
    expect(res).toMatchObject({ success: true, via: 'visible', width: 58, height: 38, element: { clipped: false }, frame: { origin: [96, 196] } });
    expect(drawn[0].slice(1)).toEqual([96, 196, 58, 38, 0, 0, 58, 38]);
    expect(captures()).toHaveLength(0);
    expect(pageCalls.some((args) => args[0] === 's1-4')).toBe(true);
    // An element the page cannot find is an error, not a full-viewport picture.
    scripting.executeScript = async (o: { args?: unknown[] }) => (o.args ?? []).length === 0
      ? [{ result: viewport }]
      : [{ result: { success: false, error: 'Element not found' } }];
    expect(await handleScreenshot({ tabId: 1, selector: '#nope' })).toEqual({ success: false, error: 'Element not found' });
    // A ref the page no longer has: the shared REF_* wording, not a bare "not found".
    expect(await handleScreenshot({ tabId: 1, ref: 'zz9-1' })).toMatchObject({ success: false, error: expect.stringMatching(/^REF_NOT_FOUND: ref zz9-1 /) });
    expect(captures()).toHaveLength(0);
  });

  it('fullPage clips the whole content over CDP', async () => {
    const res = await handleScreenshot({ tabId: 1, format: 'png', fullPage: true });
    expect(res).toMatchObject({ success: true, via: 'cdp' });
    expect(captures()[0].params).toMatchObject({ captureBeyondViewport: true, clip: { y: 0, height: 3000 } });
  });

  it('a page taller than 16000 px is cut at 16000 and the result says so', async () => {
    contentHeight = 20_000;
    const res = await handleScreenshot({ tabId: 1, format: 'png', fullPage: true });
    expect(captures()[0].params).toMatchObject({ clip: { height: 16_000 } });
    expect(res.note).toMatch(/first 16000 px/);
  });

  it('fullPage with maxWidth re-captures once when the real image is still too wide (DPR 2, ratio unknown)', async () => {
    contentHeight = 800;
    dpr = 1;
    trueDpr = 2; // the page can't tell (pageDpr null) and the metrics say 1
    const res = await handleScreenshot({ tabId: 1, format: 'png', fullPage: true, maxWidth: 800 });
    expect(captures()).toHaveLength(2);
    expect(captures()[1].params).toMatchObject({ clip: { scale: 0.4 } });
    expect(res).toMatchObject({ width: 800, frame: { scale: 0.8 } });
  });

  it('a background tab the debugger can paint is captured without switching to it', async () => {
    backgroundPaints = true;
    const res = await handleScreenshot({ tabId: 2, format: 'png' });
    expect(res).toMatchObject({ success: true, via: 'cdp', data: 'CDPDATA' });
    expect(updates).toEqual([]);
  });

  it('a background tab the debugger cannot capture is shown briefly, then the user tab is switched back', async () => {
    const res = await handleScreenshot({ tabId: 2, format: 'png' });
    expect(res).toMatchObject({ success: true, via: 'visible-activated', cdpFallback: 'Page.captureScreenshot timed out' });
    expect(updates).toEqual([[2, { active: true }], [1, { active: true }]]);
  }, 10_000);

  it('a full page the debugger cannot make fails instead of returning the viewport', async () => {
    captureHangs = true;
    await expect(handleScreenshot({ tabId: 1, format: 'png', fullPage: true })).rejects.toThrow(/UNSUPPORTED/);
  }, 10_000);

  it('a zoom the debugger cannot make falls back to the plain viewport and says so', async () => {
    captureHangs = true;
    const res = await handleScreenshot({ tabId: 1, format: 'png', region: { x: 0, y: 0, width: 100, height: 50 }, scale: 2 });
    expect(res).toMatchObject({ success: true, via: 'visible', width: 100, height: 50, cdpFallback: 'Page.captureScreenshot timed out' });
  }, 10_000);

  it('an image over the frame budget is re-encoded as JPEG and the result says so', async () => {
    encodeBytes = (type) => (type === 'image/png' ? 700_000 : 100_000);
    const res = await handleScreenshot({ tabId: 1, format: 'png' });
    expect(res).toMatchObject({ success: true, format: 'jpeg', via: 'visible', width: 1000, height: 600 });
    expect(res.note).toMatch(/frame limit \(jpeg\)/);
  });

  it('an image that cannot fit the frame budget fails with SCREENSHOT_TOO_LARGE (no CDP retry)', async () => {
    encodeBytes = () => 2_000_000;
    await expect(handleScreenshot({ tabId: 1, format: 'png' })).rejects.toThrow(/SCREENSHOT_TOO_LARGE/);
    expect(captures()).toHaveLength(0);
  });
});
