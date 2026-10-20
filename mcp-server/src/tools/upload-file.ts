import { access, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { z } from 'zod';
import type { ToolDefinition, ToolHost, ToolResult } from './types.js';
import { requireTabId, tabIdParam, forwardHandler, jsonError } from './types.js';

/**
 * Local paths that are not readable regular files. The extension cannot stat
 * files, and DOM.setFileInputFiles accepts a missing path as an empty file,
 * so the check happens here, before anything is sent.
 */
async function unreadableFiles(paths: string[]): Promise<string[]> {
  const bad: string[] = [];
  for (const path of paths) {
    try {
      const info = await stat(path);
      if (!info.isFile()) {
        bad.push(path);
        continue;
      }
      await access(path, constants.R_OK);
    } catch {
      bad.push(path);
    }
  }
  return bad;
}

const forwardUpload = forwardHandler('browser_upload_file');

const handler = async (
  host: ToolHost,
  params: Record<string, unknown>,
): Promise<ToolResult> => {
  if (!params.imageBase64 && !params.fromScreenshot) {
    const listed = Array.isArray(params.files) && params.files.length > 0
      ? params.files
      : typeof params.filePath === 'string' ? [params.filePath] : [];
    const paths = listed.filter((p): p is string => typeof p === 'string');
    const missing = await unreadableFiles(paths);
    if (missing.length > 0) {
      // Names only: the local directory layout is not the agent's business.
      const names = missing.map((p) => p.split(/[\\/]/).pop() || p).join(', ');
      return jsonError({
        success: false,
        error: `FILE_NOT_FOUND: ${names} does not exist or is not a readable file; nothing was uploaded.`,
      });
    }
  }
  return forwardUpload(host, params);
};
// Registry drift guard: this custom handler still forwards to the same wire name.
(handler as { toolName?: string }).toolName = 'browser_upload_file';

export const uploadFileTool: ToolDefinition = {
  name: 'browser_upload_file',
  summary: 'Upload a file to a file input element',  description:
    'Set files on an <input type="file"> without a file dialog (ref/selector, or the first file input): filePath or files, absolute paths on the browser\'s machine; files needs an input that allows multiple. A missing or unreadable path fails with FILE_NOT_FOUND before anything is sent. Works on strict-CSP pages; the page gets input and change once. Or upload bytes (imageBase64, fromScreenshot) into a file input or dropped on a drop zone (ref/selector/x+y).',
  inputSchema: z.object({
    tabId: requireTabId(),
    ref: z.string().optional(),
    selector: z.string().optional(),
    filePath: z.string().optional(),
    files: z
      .array(z.string())
      .optional()
      .describe('Several paths (the input must allow multiple)'),
    imageBase64: z.string().optional().describe('Base64, no data: prefix'),
    fileName: z.string().optional(),
    mimeType: z.string().optional().describe('Default image/png'),
    fromScreenshot: z.boolean().optional().describe('Upload a PNG screenshot of screenshotTabId (default this tab)'),
    screenshotTabId: tabIdParam.optional(),
    region: z.object({ x: z.number(), y: z.number(), width: z.number().positive(), height: z.number().positive() }).optional(),
    x: z.number().optional().describe('Drop point, with y'),
    y: z.number().optional(),
  }),
  timeoutMs: 15_000,
  handler,
};
