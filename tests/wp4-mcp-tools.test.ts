import { describe, expect, it } from 'vitest';
import { screenshotTool } from '../mcp-server/src/tools/screenshot.js';
import type { ToolHost } from '../mcp-server/src/tools/types.js';

const hostReturning = (result: unknown): ToolHost => ({ callTool: async () => result });
const metaOf = (res: { content: Array<{ type: string; text?: string }> }) =>
  JSON.parse((res.content.find((c) => c.type === 'text') as { text: string }).text);

describe('browser_screenshot tool: what the agent is told about the picture', () => {
  it('passes a downscaling note through so the agent knows the image is not 1:1', async () => {
    const res = await screenshotTool.handler(hostReturning({
      success: true, format: 'jpeg', data: 'AAAA', width: 1568, height: 941,
      frame: { scale: 1.568, origin: [0, 0], viewport: [1000, 600] },
      note: 'scaled down to a 1568 px longest side',
    }), { tabId: 1 });
    expect(metaOf(res)).toMatchObject({ image: [1568, 941], note: 'scaled down to a 1568 px longest side' });
  });

  it('says when a zoom fell back to the plain viewport (cdpFallback)', async () => {
    const res = await screenshotTool.handler(hostReturning({
      success: true, format: 'png', data: 'AAAA', width: 100, height: 50,
      frame: { scale: 1, origin: [0, 0], viewport: [1000, 600] }, cdpFallback: 'Page.captureScreenshot timed out',
    }), { tabId: 1, region: { x: 0, y: 0, width: 100, height: 50 }, scale: 2 });
    expect(metaOf(res)).toMatchObject({ cdpFallback: 'Page.captureScreenshot timed out' });
  });

  it('still returns the image when the page reported no coordinate frame, with a note', async () => {
    const res = await screenshotTool.handler(hostReturning({
      success: true, format: 'png', data: 'AAAA', width: 800, height: 600, note: 'reduced to fit the 1 MB frame limit (jpeg)',
    }), { tabId: 1 });
    expect(res.content.some((c) => c.type === 'image')).toBe(true);
    expect(metaOf(res)).toMatchObject({ note: 'reduced to fit the 1 MB frame limit (jpeg)' });
    expect(metaOf(res)).not.toHaveProperty('toViewport');
  });

  it('returns only the image when there is no frame, note or fallback', async () => {
    const res = await screenshotTool.handler(hostReturning({ success: true, format: 'png', data: 'AAAA', width: 10, height: 10 }), { tabId: 1 });
    expect(res.content.filter((c) => c.type === 'text')).toHaveLength(0);
  });
});
