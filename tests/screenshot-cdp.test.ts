import { describe, it, expect, beforeEach } from 'vitest';

const cdp: Array<{ method: string; params: Record<string, unknown> }> = [];
const tabs = new Map<number, { id: number; url: string; windowId: number; active: boolean }>();
const updates: Array<[number, unknown]> = [];
let captureHangs = false;
let dpr = 1;
let imageData = 'CDPDATA';
/** What window.devicePixelRatio reports (null = the page can't answer). */
let pageDpr: number | null = null;
/** When set, the capture is as big as a real one: clip × scale × this true ratio. */
let trueDpr: number | null = null;
/** A tiny PNG header (signature + IHDR) of the given size, base64. */
function pngOf(w: number, h: number): string {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8); b.write('IHDR', 12); b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20);
  return b.toString('base64');
}

(globalThis as unknown as { chrome: unknown }).chrome = {
  tabs: {
    get: async (id: number) => tabs.get(id),
    query: async () => [...tabs.values()].filter((t) => t.active),
    update: async (id: number, props: { active?: boolean }) => {
      updates.push([id, props]);
      if (props.active) for (const t of tabs.values()) t.active = t.id === id;
      return tabs.get(id);
    },
    captureVisibleTab: async () => 'data:image/png;base64,LEGACY',
    onRemoved: { addListener: () => {} },
  },
  windows: { get: async () => ({ width: 1200, height: 900 }) },
  scripting: { executeScript: async () => [{ result: null }] },
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
          cssContentSize: { width: 1000, height: 3000 },
        };
      }
      if (method === 'Page.captureScreenshot') {
        const tab = tabs.get(_t.tabId);
        if (captureHangs || !tab?.active) return new Promise(() => {});
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

describe('browser_screenshot over CDP', () => {
  beforeEach(async () => {
    cdp.length = 0;
    updates.length = 0;
    captureHangs = false;
    dpr = 1;
    imageData = 'CDPDATA';
    pageDpr = null;
    trueDpr = null;
    tabs.clear();
    tabs.set(1, { id: 1, url: 'https://a.test', windowId: 7, active: true });
    tabs.set(2, { id: 2, url: 'https://b.test', windowId: 7, active: false });
    await session.detachCdp(1);
    await session.detachCdp(2);
  });

  it('captures the viewport with scale / maxWidth', async () => {
    const res = await handleScreenshot({ tabId: 1, format: 'jpeg', quality: 60, maxWidth: 500 });
    expect(res).toMatchObject({ success: true, via: 'cdp', width: 500, height: 300, data: 'CDPDATA' });
    const cap = cdp.find((c) => c.method === 'Page.captureScreenshot')!;
    expect(cap.params).toMatchObject({ format: 'jpeg', quality: 60, clip: { x: 0, y: 50, width: 1000, height: 600, scale: 0.5 } });
  });

  it('reports the pixel mapping from the real image size (device pixel ratio 2)', async () => {
    dpr = 2;
    imageData = pngOf(2000, 1200); // a 1000x600 CSS viewport captured at DPR 2
    const res = await handleScreenshot({ tabId: 1, format: 'png' });
    expect(res).toMatchObject({ width: 2000, height: 1200, frame: { scale: 2, origin: [0, 0] } });
    // maxWidth caps the IMAGE, so the clip scale accounts for the ratio.
    imageData = pngOf(800, 480);
    cdp.length = 0;
    const small = await handleScreenshot({ tabId: 1, format: 'png', maxWidth: 800 });
    expect(cdp.find((c) => c.method === 'Page.captureScreenshot')!.params).toMatchObject({ clip: { scale: 0.4 } });
    expect(small).toMatchObject({ width: 800, frame: { scale: 0.8 } });
  });

  it('maxWidth holds at DPR 2 even when the layout metrics report no ratio (real Chrome)', async () => {
    // Real Chrome at DPR 2: device and CSS viewport widths come back equal.
    dpr = 1;
    trueDpr = 2;
    pageDpr = 2;
    const res = await handleScreenshot({ tabId: 1, format: 'png', maxWidth: 800 });
    const caps = cdp.filter((c) => c.method === 'Page.captureScreenshot');
    expect(caps).toHaveLength(1);
    expect(caps[0].params).toMatchObject({ clip: { scale: 0.4 } });
    expect(res).toMatchObject({ width: 800, height: 480, frame: { scale: 0.8 } });
  });

  it('maxWidth is enforced from the real image when no ratio source is right', async () => {
    dpr = 1;
    trueDpr = 2; // the page can't tell (pageDpr null) and the metrics say 1
    const res = await handleScreenshot({ tabId: 1, format: 'png', maxWidth: 800 });
    const caps = cdp.filter((c) => c.method === 'Page.captureScreenshot');
    expect(caps).toHaveLength(2); // one re-capture, scaled by what the image showed
    expect(caps[1].params).toMatchObject({ clip: { scale: 0.4 } });
    expect(res).toMatchObject({ width: 800, frame: { scale: 0.8 } });
  });

  it('fullPage clips the whole content', async () => {
    await handleScreenshot({ tabId: 1, format: 'png', fullPage: true });
    const cap = cdp.find((c) => c.method === 'Page.captureScreenshot')!;
    expect(cap.params).toMatchObject({ captureBeyondViewport: true, clip: { y: 0, height: 3000 } });
  });

  it('background tab: shows it briefly, captures over CDP, restores the user tab', async () => {
    const res = await handleScreenshot({ tabId: 2, format: 'png' });
    expect(res).toMatchObject({ success: true, via: 'cdp-activated', data: 'CDPDATA' });
    expect(updates).toEqual([[2, { active: true }], [1, { active: true }]]);
  });

  it('falls back to captureVisibleTab when CDP capture hangs', async () => {
    captureHangs = true;
    const res = await handleScreenshot({ tabId: 1, format: 'png' });
    expect(res).toMatchObject({ success: true, data: 'LEGACY', cdpFallback: 'Page.captureScreenshot timed out' });
  }, 10_000);
});
