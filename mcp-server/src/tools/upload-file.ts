import { z } from 'zod';
import type { ToolDefinition } from './types.js';
import { requireTabId, tabIdParam, forwardHandler } from './types.js';

export const uploadFileTool: ToolDefinition = {
  name: 'browser_upload_file',
  summary: 'Upload a file to a file input element',  description:
    'Set files on an <input type="file"> without a file dialog (ref/selector, or the first file input): filePath or files, absolute paths on the browser\'s machine. Or upload bytes (imageBase64, fromScreenshot) into a file input or dropped on a drop zone (ref/selector/x+y).',
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
  handler: forwardHandler('browser_upload_file'),
};
