import { describe, it, expect, vi } from 'vitest';

/**
 * Screenshot size rules (audit #2): the longest side is capped, and an image is
 * fitted under the frame budget before it leaves the extension. Pure functions;
 * the capture paths themselves are in tests/screenshot-cdp.test.ts.
 */
(globalThis as unknown as { chrome: unknown }).chrome = {
  tabs: { onRemoved: { addListener: () => {} }, onUpdated: { addListener: () => {}, removeListener: () => {} } },
  storage: { session: { get: async () => ({}), set: async () => {} }, local: { get: async () => ({}), set: async () => {} } },
  runtime: { sendMessage: async () => {}, onMessage: { addListener: () => {} } },
  action: { setBadgeBackgroundColor: () => {}, setBadgeText: () => {} },
  alarms: { create: () => {}, onAlarm: { addListener: () => {} } },
  webRequest: { onCompleted: { addListener: () => {} } },
  debugger: { attach: async () => {}, detach: async () => {}, sendCommand: async () => ({}), onDetach: { addListener: () => {} } },
  scripting: { executeScript: async () => [{ result: null }] },
};

const { planScale, fitToBudget, MAX_IMAGE_EDGE, SCREENSHOT_MAX_BASE64_CHARS } = await import('../extension/handlers/tabs.js');

describe('planScale', () => {
  it('keeps a request that fits the 1568 px longest side', () => {
    expect(planScale({ cssW: 1000, cssH: 600, dpr: 1, scale: 1 })).toEqual({ scale: 1, edgeClamped: false });
    // a small region zoomed 4x is still well inside the limit
    expect(planScale({ cssW: 300, cssH: 200, dpr: 1, scale: 4 })).toEqual({ scale: 4, edgeClamped: false });
  });

  it('cuts a request so the longest device-pixel side is at most MAX_IMAGE_EDGE', () => {
    // 1200x700 CSS region at scale 4 would be 4800x2800 (audit #2)
    const plan = planScale({ cssW: 1200, cssH: 700, dpr: 1, scale: 4 });
    expect(plan.edgeClamped).toBe(true);
    expect(Math.round(1200 * plan.scale)).toBeLessThanOrEqual(MAX_IMAGE_EDGE);
    // a retina viewport (1000 CSS px at DPR 2) is 2000 device px wide
    const retina = planScale({ cssW: 1000, cssH: 600, dpr: 2, scale: 1 });
    expect(retina.edgeClamped).toBe(true);
    expect(Math.round(1000 * 2 * retina.scale)).toBe(MAX_IMAGE_EDGE);
  });

  it('applies maxWidth on top, and does not call it an edge clamp', () => {
    expect(planScale({ cssW: 1000, cssH: 600, dpr: 1, scale: 1, maxWidth: 500 })).toEqual({ scale: 0.5, edgeClamped: false });
    // DPR 2: maxWidth caps the device-pixel width (800 px = 1000 CSS × 0.4 × 2)
    expect(planScale({ cssW: 1000, cssH: 600, dpr: 2, scale: 1, maxWidth: 800 }).scale).toBeCloseTo(0.4, 10);
  });
});

describe('fitToBudget', () => {
  const shot = (format: string, quality: number, scale: number, size: number) => ({
    data: 'x'.repeat(size), format, quality, scale, width: Math.round(1000 * scale), height: Math.round(600 * scale),
  });

  it('returns an image under the budget unchanged, without another capture', async () => {
    const first = shot('png', 80, 1, 1000);
    const redo = vi.fn();
    expect(await fitToBudget(first, redo, 5000)).toBe(first);
    expect(redo).not.toHaveBeenCalled();
  });

  it('turns an oversized PNG into a JPEG at the same scale first', async () => {
    const first = shot('png', 80, 1, 6000);
    const redo = vi.fn(async (next: { format: string; quality: number; scale: number }) => shot(next.format, next.quality, next.scale, 1000));
    const out = await fitToBudget(first, redo, 5000);
    expect(redo).toHaveBeenCalledTimes(1);
    expect(redo).toHaveBeenCalledWith({ format: 'jpeg', quality: 80, scale: 1 });
    expect(out).toMatchObject({ format: 'jpeg', scale: 1 });
  });

  it('shrinks the scale and lowers the JPEG quality until it fits', async () => {
    const first = shot('jpeg', 80, 1, 20_000);
    const redo = vi.fn(async (next: { format: string; quality: number; scale: number }) =>
      shot(next.format, next.quality, next.scale, Math.round(20_000 * next.scale * next.scale)));
    const out = await fitToBudget(first, redo, 5000);
    expect(out.data.length).toBeLessThanOrEqual(5000);
    expect(out.scale).toBeLessThan(1);
    expect(out.quality).toBeLessThan(80);
    expect(redo.mock.calls.length).toBeLessThanOrEqual(3);
  });

  it('fails SCREENSHOT_TOO_LARGE when no try fits, after a bounded number of tries', async () => {
    const first = shot('png', 80, 1, 90_000);
    const redo = vi.fn(async (next: { format: string; quality: number; scale: number }) => shot(next.format, next.quality, next.scale, 90_000));
    await expect(fitToBudget(first, redo, 5000)).rejects.toMatchObject({ code: 'SCREENSHOT_TOO_LARGE' });
    expect(redo.mock.calls.length).toBeLessThanOrEqual(3);
  });

  it('uses the 900 KB budget by default (under the 1 MB frame cap, with room for the envelope)', () => {
    expect(SCREENSHOT_MAX_BASE64_CHARS).toBeLessThanOrEqual(1_000_000 - 50_000);
  });
});
