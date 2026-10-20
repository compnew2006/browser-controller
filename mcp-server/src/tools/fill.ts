import { access, realpath, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { z } from 'zod';
import type { ToolDefinition, ToolHost, ToolResult } from './types.js';
import { tabIdParam, forwardHandler, failureResult } from './types.js';

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

/**
 * A value that may be a local path: ~/, POSIX absolute, or a Windows drive (C:/ or C:\\).
 * Any field of a list of such values is checked, whatever its element kind: the server
 * cannot tell a file input from a select.
 */
const looksLikePath = (value: string): boolean => value.startsWith('~/') || isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value);

const expandHome = (path: string): string => (path.startsWith('~/') ? join(homedir(), path.slice(2)) : path);

/** The last path segment, for messages (names only: the local directory layout is not the agent's business). */
const nameOf = (path: string): string => path.split(/[\\/]/).pop() || path;

/**
 * Credential and hidden files a page must not get the agent to upload: a page can ask for
 * ~/.aws/credentials and read the file back on `change`. Refused before anything is sent.
 * Only these directory names and dotfile names count: a project under a hidden folder
 * (~/.zcode/...) is fine.
 */
const SECRET_SEGMENTS = new Set([
  '.ssh', '.aws', '.gnupg', '.kube', '.docker', '.azure', '.config', '.browser-controller',
  '.password-store', '.netrc', '.git-credentials', 'Keychains',
]);

function isSecretPath(path: string): boolean {
  const parts = path.split(/[\\/]+/);
  return (parts[parts.length - 1] || '').startsWith('.') || parts.some((part) => SECRET_SEGMENTS.has(part));
}

/** Checked as typed and as the file it resolves to, so a symlink into ~/.ssh is refused too. */
async function isRefusedFile(path: string): Promise<boolean> {
  if (isSecretPath(path)) return true;
  const real = await realpath(path).catch(() => path);
  return isSecretPath(real);
}

const forwardFill = forwardHandler('browser_fill');

/**
 * Whether a string may name a file: absolute, ~/, or with a path separator. A bare word
 * ("en", "Ada", ".net") is not checked, so select values and text pass unchecked; the
 * extension refuses a relative path for a file input anyway.
 */
const mayBeFile = (item: string): boolean => looksLikePath(item) || /[\\/]/.test(item);

/**
 * Path-like values are checked here: hidden or credential files are refused (nothing is
 * sent). Paths that cannot be read are not refused: they go on flagged by name in
 * `missingFiles`, and the extension refuses the call only when the field is a file
 * input (a select's option values may look like paths, "/en").
 */
const handler = async (
  host: ToolHost,
  params: Record<string, unknown>,
): Promise<ToolResult> => {
  const fields = (params.fields as Array<{ target: string; value: unknown }>) ?? [];
  const resolved: Array<Record<string, unknown>> = [];
  for (const field of fields) {
    // A number (a range, a typed count) goes to the page as its string.
    const value = typeof field.value === 'number' ? String(field.value) : field.value;
    if (!Array.isArray(value) || value.length === 0 || !value.every((item) => typeof item === 'string')) {
      resolved.push({ ...field, value });
      continue;
    }
    const items = value as string[];
    // Every item that may be a file is checked, mixed lists included: a relative credential
    // path must not get past the check because a neighbour is absolute. The check is on the
    // value as typed (and on what a symlink resolves to); the extension refuses relative
    // paths for a file input as well.
    for (const item of items) {
      if (mayBeFile(item) && await isRefusedFile(expandHome(item))) {
        return failureResult(`FILE_NOT_ALLOWED: ${nameOf(expandHome(item))} is a hidden or credential file; upload only files the user chose.`);
      }
    }
    const absolute = items.map(expandHome);
    const missing = await unreadableFiles(items.filter(looksLikePath).map(expandHome));
    resolved.push({
      ...field,
      value: absolute,
      ...(missing.length > 0 ? { missingFiles: missing.map(nameOf) } : {}),
    });
  }
  return forwardFill(host, { ...params, fields: resolved });
};
// Registry drift guard: this custom handler still forwards to the same wire name.
(handler as { toolName?: string }).toolName = 'browser_fill';

export const fillTool: ToolDefinition = {
  name: 'browser_fill',
  summary: 'Fill several form fields in one call',
  description: 'Fill up to 50 fields: text, date/time/color/range (value), select (value or label), checkbox, radio or switch (boolean), file input (absolute paths, checked before sending). Submits nothing.',
  inputSchema: z.object({
    tabId: tabIdParam,
    fields: z.array(z.object({
      target: z.string(),
      value: z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]),
    }).strict()).min(1).max(50),
  }).strict(),
  // A file set can take a while; the extension's own cap is shorter.
  timeoutMs: 30_000,
  handler,
};
