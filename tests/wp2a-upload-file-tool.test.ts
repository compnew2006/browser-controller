import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { uploadFileTool } from '../mcp-server/src/tools/upload-file.js';
import type { ToolHost } from '../mcp-server/src/tools/types.js';

/**
 * browser_upload_file checks its local paths before forwarding: a path that does
 * not exist (or is a directory) used to reach the browser as a 0-byte file and
 * came back as success.
 */
describe('browser_upload_file: local paths are checked before anything is sent', () => {
  let dir: string;
  let calls: Array<{ tool: string; params: Record<string, unknown> }>;
  const host: ToolHost = {
    callTool: async (tool, params) => {
      calls.push({ tool, params });
      return { success: true, files: ['resume.pdf'] };
    },
  };
  const failureOf = (res: { isError?: boolean; content: Array<{ type: string; text?: string }> }) => {
    expect(res.isError).toBe(true);
    return JSON.parse(res.content[0].text as string) as { success: boolean; error: string };
  };

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'wp2a-upload-'));
    writeFileSync(join(dir, 'resume.pdf'), 'pdf bytes');
    mkdirSync(join(dir, 'a-folder'));
  });

  it('a missing file fails with FILE_NOT_FOUND, names only the file, and sends nothing', async () => {
    calls = [];
    const res = await uploadFileTool.handler(host, { tabId: 3, selector: 'input', filePath: '/nowhere-wp2a/private/missing.pdf' });
    const body = failureOf(res);
    expect(body).toMatchObject({ success: false, error: expect.stringMatching(/^FILE_NOT_FOUND: missing\.pdf /) });
    expect(body.error).not.toContain('nowhere-wp2a');
    expect(calls).toHaveLength(0);
  });

  it('a directory is not a file: FILE_NOT_FOUND as well', async () => {
    calls = [];
    const res = await uploadFileTool.handler(host, { tabId: 3, filePath: join(dir, 'a-folder') });
    expect(failureOf(res).error).toMatch(/^FILE_NOT_FOUND: a-folder /);
    expect(calls).toHaveLength(0);
  });

  it('with several files, only the missing ones are named', async () => {
    calls = [];
    const real = join(dir, 'resume.pdf');
    const res = await uploadFileTool.handler(host, { tabId: 3, selector: 'input', files: [real, join(dir, 'gone.txt')] });
    expect(failureOf(res).error).toMatch(/^FILE_NOT_FOUND: gone\.txt /);
    expect(calls).toHaveLength(0);
  });

  it('readable files are forwarded unchanged to the browser_upload_file wire name', async () => {
    calls = [];
    const params = { tabId: 3, selector: 'input', filePath: join(dir, 'resume.pdf') };
    const res = await uploadFileTool.handler(host, params);
    expect(res.isError).toBeFalsy();
    expect(calls).toEqual([{ tool: 'browser_upload_file', params }]);
  });

  it('byte uploads (imageBase64) have no local path to check and are forwarded', async () => {
    calls = [];
    const res = await uploadFileTool.handler(host, { tabId: 3, selector: 'input', imageBase64: 'aGk=', fileName: 'x.txt' });
    expect(res.isError).toBeFalsy();
    expect(calls).toHaveLength(1);
  });

  it('the registry wire-name tag still matches the tool name', () => {
    expect((uploadFileTool.handler as { toolName?: string }).toolName).toBe('browser_upload_file');
  });
});
