import { z } from 'zod';
import type { ToolDefinition } from './types.js';
import { requireTabId, forwardHandler } from './types.js';

export const uploadFileTool: ToolDefinition = {
  name: 'browser_upload_file',
  summary: 'Upload a file to a file input element',  description:
    'Upload a local file into an <input type="file"> WITHOUT opening the file dialog: CDP DOM.setFileInputFiles sets the files as if the user picked them, then input+change events fire so React/Vue handlers react. Works even on strict-CSP pages. Paths are absolute and local to the machine running the browser. Target the input with a ref from snapshot, a CSS selector, or omit both to auto-find the first input[type="file"]. Use files (array) for multiple uploads — requires an input that allows multiple. Without a local file: imageBase64 (+fileName/mimeType) or fromScreenshot:true uploads bytes directly — into a file input, or as a drag-and-drop onto a drop zone (ref/selector/x+y).',
  inputSchema: z.object({
    tabId: requireTabId(),
    ref: z.string().optional().describe('Element reference from snapshot (e.g. "e12")'),
    selector: z.string().optional().describe('CSS selector for the file input element'),
    filePath: z.string().optional().describe('Local file path to upload (single file)'),
    files: z
      .array(z.string())
      .optional()
      .describe('Array of local file paths to upload (multiple files)'),
    imageBase64: z.string().optional().describe('File bytes as base64 (no data: prefix) — uploads without a local file'),
    fileName: z.string().optional().describe('Name for imageBase64 / screenshot uploads (default image.png / screenshot.png)'),
    mimeType: z.string().optional().describe('MIME type for imageBase64 (default image/png)'),
    fromScreenshot: z.boolean().optional().describe('Upload a fresh PNG screenshot (of screenshotTabId, default this tab; optional region)'),
    screenshotTabId: z.number().int().optional().describe('Tab to screenshot for fromScreenshot'),
    region: z.object({ x: z.number(), y: z.number(), width: z.number().positive(), height: z.number().positive() }).optional()
      .describe('fromScreenshot: only this viewport rectangle'),
    x: z.number().optional().describe('Drop target at viewport x (with y) when there is no ref/selector'),
    y: z.number().optional().describe('Drop target at viewport y'),
  }),
  timeoutMs: 15_000,
  handler: forwardHandler('browser_upload_file'),
};
