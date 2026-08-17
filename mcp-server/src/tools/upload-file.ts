import { z } from 'zod';
import type { ToolDefinition } from './types.js';
import { requireTabId, forwardHandler } from './types.js';

export const uploadFileTool: ToolDefinition = {
  name: 'browser_upload_file',
  summary: 'Upload a file to a file input element',  description:
    'Upload a local file into an <input type="file"> WITHOUT opening the file dialog: CDP DOM.setFileInputFiles sets the files as if the user picked them, then input+change events fire so React/Vue handlers react. Works even on strict-CSP pages. Paths are absolute and local to the machine running the browser. Target the input with a ref from snapshot, a CSS selector, or omit both to auto-find the first input[type="file"]. Use files (array) for multiple uploads — requires an input that allows multiple.',
  inputSchema: z.object({
    tabId: requireTabId(),
    ref: z.string().optional().describe('Element reference from snapshot (e.g. "e12")'),
    selector: z.string().optional().describe('CSS selector for the file input element'),
    filePath: z.string().optional().describe('Local file path to upload (single file)'),
    files: z
      .array(z.string())
      .optional()
      .describe('Array of local file paths to upload (multiple files)'),
  }),
  timeoutMs: 15_000,
  handler: forwardHandler('browser_upload_file'),
};
