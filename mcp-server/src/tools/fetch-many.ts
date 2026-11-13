import { z } from 'zod';
import type { ToolDefinition, ToolHost, ToolResult } from './types.js';
import { tabIdParam, rawResultOf, textResult } from './types.js';
import { evaluateTool } from './evaluate.js';

/**
 * Fetch several same-origin pages in ONE call, with the live session's cookies.
 *
 * The slow way to read N pages is N navigations and N reads, and every one of
 * them is a round trip through the model. This tool does the whole loop inside
 * the page: one `browser_evaluate` runs an in-page fetch per URL, parses each
 * response with DOMParser and returns the extracted fields together.
 *
 * It composes `browser_evaluate` rather than being a wire tool of its own, so
 * the extension needs no new handler and the daemon's allow-list is unchanged.
 * The page code is fixed by this file; the caller supplies URLs and CSS
 * selectors, never JavaScript.
 */

/** How many pages are fetched at the same time. */
const CONCURRENCY = 6;

/** The most characters of page text one entry may carry when text is asked for. */
const MAX_TEXT_CHARS = 4_000;

/**
 * The page-side script. One expression (so `browser_evaluate` returns it),
 * top-level await inside it, and the URLs and selectors are embedded as JSON
 * so no caller text can break out of the script.
 */
function buildScript(urls: string[], fields: Record<string, string> | undefined, wantText: boolean): string {
  return `(async () => {
  const urls = ${JSON.stringify(urls)};
  const fields = ${JSON.stringify(fields ?? null)};
  const wantText = ${wantText ? 'true' : 'false'};
  const out = new Array(urls.length);
  let next = 0;
  const worker = async () => {
    while (next < urls.length) {
      const i = next++;
      const raw = urls[i];
      try {
        const url = /^https?:\\/\\//i.test(raw) ? raw : new URL(raw, location.origin + '/').href;
        // same-origin sends the session cookies; a cross-origin URL gets none,
        // so a request can never carry the user's session to another site.
        const res = await fetch(url, { credentials: 'same-origin' });
        const html = await res.text();
        const doc = new DOMParser().parseFromString(html, 'text/html');
        const item = { url, status: res.status };
        if (fields) {
          item.fields = {};
          for (const [key, selector] of Object.entries(fields)) {
            const el = doc.querySelector(selector);
            item.fields[key] = el ? el.textContent.replace(/\\s+/g, ' ').trim() : null;
          }
        }
        if (wantText) {
          const body = doc.body ? doc.body.textContent : '';
          item.text = body.replace(/\\s+/g, ' ').trim().slice(0, ${MAX_TEXT_CHARS});
        }
        out[i] = item;
      } catch (error) {
        out[i] = { url: raw, error: error instanceof Error ? error.message : String(error) };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(${CONCURRENCY}, urls.length) }, worker));
  return out;
})()`;
}

const handler = async (host: ToolHost, params: Record<string, unknown>): Promise<ToolResult> => {
  const tabId = params.tabId as number;
  const urls = params.urls as string[];
  const fields = params.fields as Record<string, string> | undefined;
  const wantText = params.text === true;
  const timeout = typeof params.timeout === 'number' ? params.timeout : 30_000;

  // browser_evaluate's own handler runs the safety gate (page code follows the
  // tab's site action) and forwards to the extension, so reusing it keeps one
  // policy for every tool that runs code in the page.
  const evaluated = await evaluateTool.handler(host, { tabId, expression: buildScript(urls, fields, wantText), timeout });
  if (evaluated.isError) return evaluated;

  const raw = rawResultOf(evaluated) as { result?: unknown } | undefined;
  const value = raw?.result;
  const payload = value === undefined ? raw : value;
  return textResult(JSON.stringify(payload));
};

export const fetchManyTool: ToolDefinition = {
  name: 'browser_fetch_many',
  summary: 'Fetch several pages of one site in one call',
  description: 'Fetch URLs read-only. Relative URLs use site root; only same-origin requests send this tab\'s cookies. fields maps names to CSS selectors; text adds up to 4,000 chars/page. No clicks or submits.',
  inputSchema: z.object({
    tabId: tabIdParam,
    urls: z.array(z.string().min(1).max(2_000)).min(1).max(50),
    fields: z.record(z.string(), z.string()).optional(),
    text: z.boolean().optional(),
    timeout: z.number().int().min(1_000).max(30_000).optional(),
  }).strict(),
  // A read: the same request twice reads the same pages.
  idempotent: true,
  timeoutMs: 35_000,
  handler,
};
