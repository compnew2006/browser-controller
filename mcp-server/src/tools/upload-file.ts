import { access, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { z } from "zod";
import type { ToolDefinition, ToolHost, ToolResult } from "./types.js";
import { requireTabId, forwardHandler, jsonError } from "./types.js";

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

const forwardUpload = forwardHandler("browser_upload_file");

const handler = async (
  host: ToolHost,
  params: Record<string, unknown>,
): Promise<ToolResult> => {
  if (!params.imageBase64 && !params.fromScreenshot) {
    const listed = Array.isArray(params.files) && params.files.length > 0
      ? params.files
      : typeof params.filePath === "string" ? [params.filePath] : [];
    const paths = listed.filter((p): p is string => typeof p === "string");
    const missing = await unreadableFiles(paths);
    if (missing.length > 0) {
      // Names only: the local directory layout is not the agent's business.
      const names = missing.map((p) => p.split(/[\\/]/).pop() || p).join(", ");
      return jsonError({
        success: false,
        error: `FILE_NOT_FOUND: ${names} does not exist or is not a readable file; nothing was uploaded.`,
      });
    }
  }
  return forwardUpload(host, params);
};
// Registry drift guard: this custom handler still forwards to the same wire name.
(handler as { toolName?: string }).toolName = "browser_upload_file";

export const uploadFileTool: ToolDefinition = {
  name: 'browser_upload_file',
  summary: 'Upload a file to a file input element',  description:
    'Upload a local file into an <input type="file"> WITHOUT opening the file dialog: CDP DOM.setFileInputFiles sets the files as if the user picked them, and the page receives input and change once. Works even on strict-CSP pages. Paths are absolute and local to the machine running the browser; a missing or unreadable path fails with FILE_NOT_FOUND before anything is sent. Target the input with a ref from snapshot, a CSS selector, or omit both to auto-find the first input[type="file"]. Use files (array) for multiple uploads — requires an input that allows multiple. Without a local file: imageBase64 (+fileName/mimeType) or fromScreenshot:true uploads bytes directly — into a file input, or as a drag-and-drop onto a drop zone (ref/selector/x+y).',
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
  handler,
};
