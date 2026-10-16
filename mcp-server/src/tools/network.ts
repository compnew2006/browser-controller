import { z } from "zod";
import type { ToolDefinition } from "./types.js";
import { requireTabId, forwardHandler } from "./types.js";

export const networkTool: ToolDefinition = {
  name: 'browser_network',
  summary: 'Read network requests captured from a tab',  description: 'Read network requests made by a specific tab (id, method, url, status, type, durationMs — failed ones carry error). URLs over 200 chars are cut (fullUrls:true keeps them). Filter by urlPattern (substring), filter (regex), type or failed:true (errors and 4xx/5xx). requestId returns that one request in full with its request/response headers (credential and session values redacted). Response bodies are not captured.',
  inputSchema: z.object({
    tabId: requireTabId(),
    filter: z.string().optional().describe('URL regex pattern to filter requests'),
    urlPattern: z.string().optional().describe('URL substring to filter requests (e.g. "/api/")'),
    type: z.union([z.string(), z.array(z.string())]).optional().describe('Resource type(s): xhr / fetch (= xmlhttprequest), document, script, stylesheet (css), image (img), font, media, websocket, ping, other…'),
    failed: z.boolean().optional().describe('Only failed requests (network errors and HTTP 4xx/5xx)'),
    requestId: z.string().optional().describe('Return this request (an id from the list) in full, with headers'),
    fullUrls: z.boolean().optional().describe('Do not shorten long URLs in the list'),
    limit: z.number().int().min(1).max(200).optional().describe('Return only the most recent N requests (default: all buffered, up to 200)'),
    clear: z.boolean().optional().default(false).describe('Clear this tab\'s requests after reading'),
  }),
  // NOT idempotent: `clear:true` mutates the buffer (same reasoning as console — M2).
  idempotent: false,
  timeoutMs: 5_000,
  handler: forwardHandler("browser_network"),
};
