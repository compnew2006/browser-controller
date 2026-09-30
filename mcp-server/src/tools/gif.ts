import { z } from 'zod';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ToolDefinition } from './types.js';
import { requireTabId, textResult, jsonError, payloadOf } from './types.js';

/** Default place for an exported recording: ~/Downloads if it exists, else the temp dir. */
function defaultGifPath(): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const downloads = path.join(os.homedir(), 'Downloads');
  const dir = fs.existsSync(downloads) ? downloads : os.tmpdir();
  return path.join(dir, `browser-recording-${stamp}.gif`);
}

export const gifTool: ToolDefinition = {
  name: 'browser_gif',
  summary: 'Record the agent\'s actions in a tab as an animated GIF',
  description:
    'Record what happens in a tab as an animated GIF (to show the user what was done). start begins recording: a frame is captured after every page-changing action (navigate, click, type, keys, scroll, hover, select, drag, forms…), clicks are marked with a red ring. frame adds one now, stop pauses, status/clear, export writes the .gif file (default ~/Downloads) and returns its path — the image itself is not returned. A background tab is shown for a moment per frame (Chrome does not paint hidden tabs); activate:false records only while the tab is visible.',
  inputSchema: z.object({
    tabId: requireTabId(),
    action: z.enum(['start', 'frame', 'stop', 'status', 'export', 'clear']).describe('Recording action'),
    width: z.number().int().min(200).max(1600).optional().describe('start: frame width in px (default 800)'),
    maxFrames: z.number().int().min(1).max(500).optional().describe('start: stop capturing after this many frames (default 300)'),
    activate: z.boolean().optional().describe('start: briefly show a background tab to capture it (default true)'),
    path: z.string().optional().describe('export: where to write the .gif (default ~/Downloads/browser-recording-<time>.gif)'),
    clear: z.boolean().optional().describe('export: drop the frames afterwards (default true)'),
  }),
  timeoutMs: 120_000,
  async handler(host, params) {
    const call = (p: Record<string, unknown>) => host.callTool('browser_gif', p) as Promise<Record<string, unknown>>;
    let result: Record<string, unknown>;
    try {
      result = await call(params);
    } catch (err) {
      const payload = payloadOf(err);
      if (payload !== undefined) return jsonError(payload);
      throw err;
    }
    if (params.action !== 'export' || typeof result.gifBase64 !== 'string') return textResult(JSON.stringify(result));
    // The GIF arrives in parts (WebSocket frames are capped at 1 MB).
    const chunks = [Buffer.from(result.gifBase64, 'base64')];
    const parts = typeof result.parts === 'number' ? result.parts : 1;
    for (let part = 1; part < parts; part++) {
      const next = await call({ ...params, part });
      if (typeof next.gifBase64 !== 'string') throw new Error(`GIF export part ${part} returned no data`);
      chunks.push(Buffer.from(next.gifBase64, 'base64'));
    }
    const file = path.resolve(typeof params.path === 'string' && params.path ? params.path : defaultGifPath());
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, Buffer.concat(chunks));
    const { gifBase64: _drop, part: _part, parts: _parts, ...rest } = result;
    return textResult(JSON.stringify({ ...rest, path: file }));
  },
};
