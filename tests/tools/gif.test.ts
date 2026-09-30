import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gifTool } from '../../mcp-server/src/tools/gif.js';

describe('browser_gif export (MCP side)', () => {
  it('reassembles a GIF sent in parts and writes it, without returning the bytes', async () => {
    const parts = [Buffer.from('GIF89a-part-one|'), Buffer.from('part-two|'), Buffer.from('end;')];
    const asked: number[] = [];
    const host = {
      callTool: async (_tool: string, params: Record<string, unknown>) => {
        const part = (params.part as number | undefined) ?? 0;
        asked.push(part);
        return { success: true, frames: 7, width: 800, height: 400, bytes: 29, part, parts: parts.length, gifBase64: parts[part]!.toString('base64') };
      },
    };
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bc-gif-')), 'out.gif');
    const res = await gifTool.handler(host, { tabId: 1, action: 'export', path: file });
    const body = JSON.parse((res.content[0] as { text: string }).text);
    expect(asked).toEqual([0, 1, 2]);
    expect(fs.readFileSync(file, 'utf8')).toBe('GIF89a-part-one|part-two|end;');
    expect(body).toMatchObject({ success: true, frames: 7, path: file });
    expect(body).not.toHaveProperty('gifBase64');
    expect(body).not.toHaveProperty('parts');
  });

  it('passes non-export actions straight through', async () => {
    const host = { callTool: async () => ({ success: true, recording: true, frames: 1 }) };
    const res = await gifTool.handler(host, { tabId: 1, action: 'start' });
    expect(JSON.parse((res.content[0] as { text: string }).text)).toEqual({ success: true, recording: true, frames: 1 });
  });
});
