import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installFakePage, type FakeDocument } from './helpers/fake-dom.js';

/**
 * browser_screenshot (3.0): the active tab from captureVisibleTab, a background tab
 * over CDP without switching to it, element (target) and region crops, the frame
 * budget, and the refused options. Target tests run the real page functions
 * (lib/page-dom.js, locateTarget) against the fake DOM.
 */
const cdp: Array<{ method: string; params: Record<string, any> }> = [];
const tabs = new Map<number, { id: number; url: string; windowId: number; active: boolean }>();
const updates: Array<[number, unknown]> = [];
const visibleCalls: unknown[] = [];
const drawn: unknown[][] = [];
const encoded: Array<{ type: string; quality?: number; width: number; height: number }> = [];
let visibleFails: Error | null = null;
let captureHangs = false;
/** Tabs whose page never answers a script (a frozen main thread). */
const frozen = new Set<number>();
/** Milliseconds a lock-shield script takes to answer (a slow but alive page). */
let shieldDelayMs = 0;
/** A background tab the debugger can paint (Page.captureScreenshot answers for it). */
let backgroundPaints = false;
/** Size of the captured window image (device px), as createImageBitmap reports it. */
let bitmapSize = { width: 1000, height: 600 };
/** Output bytes of a canvas encode, by JPEG quality (0..100). */
let encodeBytes: (quality: number) => number = () => 64;
/** The page's CSS viewport and devicePixelRatio. */
const VIEW = { width: 1000, height: 600 };
let dpr = 1;

function pngOf(w: number, h: number): string {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8); b.write('IHDR', 12); b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20);
  return b.toString('base64');
}

(globalThis as any).createImageBitmap = async () => ({ width: bitmapSize.width, height: bitmapSize.height, close() {} });
(globalThis as any).OffscreenCanvas = class {
  constructor(public width: number, public height: number) {}
  getContext() { return { imageSmoothingQuality: 'low', drawImage: (...args: unknown[]) => { drawn.push(args); } }; }
  async convertToBlob(opts: { type: string; quality?: number }) {
    encoded.push({ type: opts.type, quality: opts.quality, width: this.width, height: this.height });
    return new Blob([new Uint8Array(encodeBytes(Math.round((opts.quality ?? 1) * 100)))], { type: opts.type });
  }
};

(globalThis as any).chrome = {
  tabs: {
    get: async (id: number) => {
      const t = tabs.get(id);
      if (!t) throw new Error(`No tab with id: ${id}`);
      return t;
    },
    query: async (q: { windowId?: number }) => [...tabs.values()].filter((t) => t.active && (q.windowId === undefined || t.windowId === q.windowId)),
    update: async (id: number, props: { active?: boolean }) => {
      updates.push([id, props]);
      if (props.active) for (const t of tabs.values()) t.active = t.id === id;
      return tabs.get(id);
    },
    captureVisibleTab: async (_windowId: number, opts: unknown) => {
      visibleCalls.push(opts);
      if (visibleFails) throw visibleFails;
      return `data:image/png;base64,${Buffer.from('PNG').toString('base64')}`;
    },
    onRemoved: { addListener: () => {} },
    onUpdated: { addListener: () => {}, removeListener: () => {} },
  },
  windows: { get: async () => ({ width: 1200, height: 900 }) },
  // The page functions run in-process against the fake page; a failing overlay helper answers null.
  scripting: {
    executeScript: async (o: { target: { tabId: number }; func: (...a: unknown[]) => unknown; args?: unknown[] }) => {
      if (frozen.has(o.target.tabId)) return new Promise(() => {});
      if (shieldDelayMs && o.func.toString().includes('__bc-lock-shield')) {
        await new Promise((r) => setTimeout(r, shieldDelayMs));
      }
      try {
        return [{ result: await o.func(...(o.args ?? [])) }];
      } catch {
        return [{ result: null }];
      }
    },
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
    onEvent: { addListener: () => {} },
    sendCommand: async (t: { tabId: number }, method: string, params: Record<string, any> = {}) => {
      cdp.push({ method, params });
      if (method === 'Runtime.evaluate') {
        if (params.expression === 'innerWidth * innerHeight') return { result: { value: (globalThis as any).innerWidth * (globalThis as any).innerHeight } };
        return { result: { value: dpr } };
      }
      if (method === 'Emulation.setDeviceMetricsOverride') {
        (globalThis as any).innerWidth = VIEW.width;
        (globalThis as any).innerHeight = VIEW.height;
        return {};
      }
      if (method === 'Page.getLayoutMetrics') {
        return {
          cssVisualViewport: { clientWidth: VIEW.width, clientHeight: VIEW.height, pageX: 0, pageY: 0 },
          visualViewport: { clientWidth: VIEW.width * dpr, clientHeight: VIEW.height * dpr },
          cssContentSize: { width: VIEW.width, height: VIEW.height },
        };
      }
      if (method === 'Page.captureScreenshot') {
        const tab = tabs.get(t.tabId);
        if (captureHangs || (!tab?.active && !backgroundPaints)) return new Promise(() => {});
        const clip = params.clip as { width: number; height: number; scale: number };
        return { data: pngOf(Math.round(clip.width * clip.scale * dpr), Math.round(clip.height * clip.scale * dpr)) };
      }
      return {};
    },
  },
};

const { handleScreenshot } = await import('../extension/handlers/screenshot.js');
const session = await import('../extension/lib/cdp-session.js');
const { PAGE_DOM_INSTALL, PAGE_DOM_VERSION } = await import('../extension/lib/page-dom.js');
const { fallbackByTab, wedgedTabs } = await import('../extension/lib/state.js');

const captures = () => cdp.filter((c) => c.method === 'Page.captureScreenshot');
let doc: FakeDocument;

/** A button at a fixed top-level box (the fake DOM has no layout). */
function boxed(id: string, box: { left: number; top: number; width: number; height: number }, attrs: Record<string, string> = {}) {
  const el = doc.el('button', { id, ...attrs }, 'Go');
  Object.defineProperty(el, 'getBoundingClientRect', {
    value: () => ({ ...box, x: box.left, y: box.top, right: box.left + box.width, bottom: box.top + box.height }),
  });
  doc.body.append(el);
  return el;
}

beforeEach(async () => {
  cdp.length = 0;
  updates.length = 0;
  visibleCalls.length = 0;
  drawn.length = 0;
  encoded.length = 0;
  visibleFails = null;
  captureHangs = false;
  frozen.clear();
  wedgedTabs.clear();
  shieldDelayMs = 0;
  backgroundPaints = false;
  bitmapSize = { width: 1000, height: 600 };
  encodeBytes = () => 64;
  dpr = 1;
  tabs.clear();
  tabs.set(1, { id: 1, url: 'https://a.test/', windowId: 7, active: true });
  tabs.set(2, { id: 2, url: 'https://b.test/', windowId: 7, active: false });
  tabs.set(3, { id: 3, url: 'chrome://settings/', windowId: 7, active: false });
  fallbackByTab.clear();
  doc = installFakePage('https://a.test/');
  (globalThis as any).innerWidth = VIEW.width;
  (globalThis as any).innerHeight = VIEW.height;
  PAGE_DOM_INSTALL(PAGE_DOM_VERSION);
  await session.detachCdp(1);
  await session.detachCdp(2);
});

afterEach(() => {
  delete (globalThis as any).innerWidth;
  delete (globalThis as any).innerHeight;
});

describe('browser_screenshot: where the picture comes from', () => {
  it('the active tab: captureVisibleTab, a JPEG, no debugger and no tab switch', async () => {
    const res = await handleScreenshot({ tabId: 1 }) as any;
    expect(res).toMatchObject({ success: true, text: '1000x600 jpeg, viewport', image: { mimeType: 'image/jpeg' }, via: 'visible', scale: 1, origin: [0, 0], viewport: [1000, 600] });
    expect(res.image.data.length).toBeGreaterThan(0);
    expect(visibleCalls).toHaveLength(1);
    expect(captures()).toHaveLength(0);
    expect(updates).toEqual([]);
    expect(encoded.at(-1)).toMatchObject({ type: 'image/jpeg', quality: 0.8, width: 1000, height: 600 });
  });

  it('a background tab: CDP Page.captureScreenshot, the user tab is never activated', async () => {
    backgroundPaints = true;
    const res = await handleScreenshot({ tabId: 2 }) as any;
    expect(res).toMatchObject({ success: true, text: '1000x600 jpeg, viewport', via: 'cdp' });
    expect(captures()).toHaveLength(1);
    expect(captures()[0].params).toMatchObject({ format: 'jpeg', quality: 80 });
    expect(visibleCalls).toHaveLength(0);
    expect(updates).toEqual([]);
  });

  it('a background tab the debugger cannot capture fails with DEBUGGER_UNAVAILABLE and the user tab stays put', async () => {
    await expect(handleScreenshot({ tabId: 2 })).rejects.toThrow(/^DEBUGGER_UNAVAILABLE: /);
    expect(updates).toEqual([]);
    expect(visibleCalls).toHaveLength(0);
  }, 10_000);

  it('the active tab falls back to CDP when captureVisibleTab fails, and says so', async () => {
    visibleFails = new Error('captureVisibleTab quota exceeded');
    const res = await handleScreenshot({ tabId: 1 }) as any;
    expect(res).toMatchObject({ success: true, via: 'cdp', cdpFallback: 'captureVisibleTab quota exceeded' });
    expect(captures()).toHaveLength(1);
    expect(updates).toEqual([]);
  });

  it('a protected page is read from the screen only (no debugger), and has no coordinate frame', async () => {
    tabs.get(1)!.url = 'chrome://settings/';
    const res = await handleScreenshot({ tabId: 1 }) as any;
    expect(res).toMatchObject({ success: true, text: '1000x600 jpeg, viewport', via: 'visible' });
    expect(res).not.toHaveProperty('scale');
    expect(res).not.toHaveProperty('origin');
    expect(captures()).toHaveLength(0);
  });
});

describe('browser_screenshot: target and region crops', () => {
  it('target: crops to the element box, scrolled into view first', async () => {
    boxed('go', { left: 96, top: 196, width: 58, height: 38 });
    const res = await handleScreenshot({ tabId: 1, target: '#go' }) as any;
    expect(res).toMatchObject({ success: true, text: '58x38 jpeg, element #go', origin: [96, 196], scale: 1 });
    expect(drawn.at(-1)!.slice(1)).toEqual([96, 196, 58, 38, 0, 0, 58, 38]);
  });

  it('target: an element that reaches past the viewport is cropped to it and the text says so', async () => {
    boxed('edge', { left: -20, top: 196, width: 58, height: 38 });
    const res = await handleScreenshot({ tabId: 1, target: '#edge' }) as any;
    expect(res.text).toBe('38x38 jpeg, element #edge (clipped to the viewport)');
    expect(drawn.at(-1)!.slice(1)).toEqual([0, 196, 38, 38, 0, 0, 38, 38]);
  });

  it('target on a never-shown background tab (0x0 viewport): the tab is sized over CDP first, then the element is cropped', async () => {
    backgroundPaints = true;
    (globalThis as any).innerWidth = 0;
    (globalThis as any).innerHeight = 0;
    boxed('go', { left: 96, top: 196, width: 58, height: 38 });
    const res = await handleScreenshot({ tabId: 2, target: '#go' }) as any;
    expect(res).toMatchObject({ success: true, text: '58x38 jpeg, element #go', via: 'cdp' });
    expect(cdp.map((c) => c.method)).toContain('Emulation.setDeviceMetricsOverride');
    expect(updates).toEqual([]);
  });

  it('target: a hidden element is refused by the locator, with its code', async () => {
    const hid = doc.el('button', { id: 'hid' }, 'Hidden');
    hid.hidden = true;
    doc.body.append(hid);
    await expect(handleScreenshot({ tabId: 1, target: '#hid' })).rejects.toThrow(/ELEMENT_HIDDEN/);
    expect(visibleCalls).toHaveLength(0);
  });

  it('target: a ref the page never issued is REF_NOT_FOUND, a selector with no match is NOT_FOUND', async () => {
    await expect(handleScreenshot({ tabId: 1, target: 'e999' })).rejects.toThrow(/^REF_NOT_FOUND: ref e999 /);
    await expect(handleScreenshot({ tabId: 1, target: '#nope' })).rejects.toThrow(/^NOT_FOUND: /);
  });

  it('target: a point is refused (a region is the rectangle form)', async () => {
    await expect(handleScreenshot({ tabId: 1, target: '120,80' })).rejects.toThrow(/^INVALID_ARGUMENT: a point is not an element/);
  });

  it('target on a protected page fails with the page error, not a picture', async () => {
    tabs.get(1)!.url = 'chrome://settings/';
    boxed('go', { left: 96, top: 196, width: 58, height: 38 });
    await expect(handleScreenshot({ tabId: 1, target: '#go' })).rejects.toThrow(/Cannot access protected page/);
  });

  it('region: crops the viewport rectangle at 1:1, mapped by origin and scale', async () => {
    const res = await handleScreenshot({ tabId: 1, region: { x: 100, y: 50, width: 200, height: 100 } }) as any;
    expect(res).toMatchObject({ success: true, text: '200x100 jpeg, region', origin: [100, 50], scale: 1 });
    expect(drawn.at(-1)!.slice(1)).toEqual([100, 50, 200, 100, 0, 0, 200, 100]);
  });

  it('region past the viewport edge is cut to it and the text says so', async () => {
    const res = await handleScreenshot({ tabId: 1, region: { x: 900, y: 500, width: 300, height: 300 } }) as any;
    expect(res.text).toBe('100x100 jpeg, region (clipped to the viewport)');
  });

  it('target and region together are refused', async () => {
    await expect(handleScreenshot({ tabId: 1, target: '#go', region: { x: 0, y: 0, width: 1, height: 1 } })).rejects.toThrow(/give target or region, not both/);
  });

  it('a region needs numbers and a positive size', async () => {
    await expect(handleScreenshot({ tabId: 1, region: { x: 0, y: 0, width: 0, height: 10 } })).rejects.toThrow(/^INVALID_ARGUMENT: region needs/);
  });
});

describe('browser_screenshot: size and options', () => {
  it('the longest side is capped at 1568 px, and the scale maps image px to viewport px', async () => {
    bitmapSize = { width: 2000, height: 1200 }; // a 1000x600 CSS viewport at DPR 2
    dpr = 2;
    const res = await handleScreenshot({ tabId: 1 }) as any;
    expect(res).toMatchObject({ width: 1568, height: 941, scale: 1.568, origin: [0, 0] });
    expect(res.text).toBe('1568x941 jpeg, viewport (scaled down to a 1568 px longest side)');
  });

  it('an image over the frame budget is re-encoded smaller and the text says so', async () => {
    encodeBytes = (quality) => (quality >= 80 ? 800_000 : 100_000);
    const res = await handleScreenshot({ tabId: 1 }) as any;
    // The text states the real (smaller) size; scale maps those pixels back to the viewport.
    expect(res).toMatchObject({ width: 827, height: 496, scale: 0.827, origin: [0, 0] });
    expect(res.text).toBe('827x496 jpeg, viewport (reduced to fit the 1 MB frame limit)');
    expect(res.image.data.length).toBeLessThanOrEqual(900_000);
  });

  it('an image that cannot fit the frame budget fails with SCREENSHOT_TOO_LARGE', async () => {
    encodeBytes = () => 2_000_000;
    await expect(handleScreenshot({ tabId: 1 })).rejects.toThrow(/^SCREENSHOT_TOO_LARGE: /);
    expect(captures()).toHaveLength(0);
  });

  it('refuses the options that change what is captured', async () => {
    await expect(handleScreenshot({ tabId: 1, fullPage: true } as any)).rejects.toThrow(/^INVALID_ARGUMENT: fullPage is not a browser_screenshot option/);
    await expect(handleScreenshot({ tabId: 1, scale: 2 } as any)).rejects.toThrow(/^INVALID_ARGUMENT: scale is not/);
    await expect(handleScreenshot({ tabId: 1, ref: 'e1' } as any)).rejects.toThrow(/^INVALID_ARGUMENT: ref is not/);
    await expect(handleScreenshot({ tabId: 1, selector: '#go' } as any)).rejects.toThrow(/^INVALID_ARGUMENT: selector is not/);
    expect(visibleCalls).toHaveLength(0);
  });

  it('ignores format, quality and maxWidth: the picture is a JPEG at its real size, and the result says so', async () => {
    const res = await handleScreenshot({ tabId: 1, format: 'png', quality: 40, maxWidth: 500, fullPage: false } as any) as any;
    expect(res).toMatchObject({ success: true, text: '1000x600 jpeg, viewport', image: { mimeType: 'image/jpeg' } });
  });
});

describe('browser_screenshot: frozen pages and the shield steps', () => {
  it('a frozen tab fails with TAB_WEDGED after the page-call budget (8 s): the shield step is bounded, the tab is marked, nothing is captured', async () => {
    frozen.add(1);
    const started = Date.now();
    await expect(handleScreenshot({ tabId: 1 })).rejects.toThrow(/^TAB_WEDGED: tab 1 did not respond within 8\.0s/);
    const took = Date.now() - started;
    expect(took).toBeGreaterThanOrEqual(7_000);
    expect(took).toBeLessThan(11_000);
    expect(wedgedTabs.has(1)).toBe(true);
    expect(visibleCalls).toHaveLength(0);
  }, 15_000);

  it('a slow but alive page (its shield step answers after ~2 s) is not marked wedged, and the screenshot succeeds', async () => {
    shieldDelayMs = 2_000;
    const res = await handleScreenshot({ tabId: 1 }) as any;
    expect(res).toMatchObject({ success: true, via: 'visible' });
    expect(wedgedTabs.has(1)).toBe(false);
  }, 15_000);

  it('a tab already marked wedged fails at its first probe; once it answers again the screenshot runs and the mark clears', async () => {
    frozen.add(1);
    wedgedTabs.set(1, Date.now());
    const started = Date.now();
    await expect(handleScreenshot({ tabId: 1 })).rejects.toThrow(/^TAB_WEDGED: /);
    expect(Date.now() - started).toBeLessThan(4_000);
    frozen.delete(1);
    const res = await handleScreenshot({ tabId: 1 }) as any;
    expect(res).toMatchObject({ success: true, via: 'visible' });
    expect(wedgedTabs.has(1)).toBe(false);
  }, 10_000);

  it('a target screenshot closes the agent input window its locate opened', async () => {
    boxed('go', { left: 96, top: 196, width: 58, height: 38 });
    await handleScreenshot({ tabId: 1, target: '#go' });
    expect((globalThis as any).__bcAgentInputUntil).toBe(0);
  });
});
