import { z } from "zod";
import type { ToolDefinition } from "./types.js";
import { requireTabId, forwardHandler } from "./types.js";

export const networkTool: ToolDefinition = {
  name: 'browser_network',
  summary: 'Read network requests captured from a tab',
  description: 'Requests a tab made (id, method, url, status, type, durationMs; failed ones carry error). URLs over 200 chars are cut (fullUrls:true keeps them). Filter by urlPattern (substring), filter (regex), type or failed (errors and 4xx/5xx). requestId: one request with redacted request and response headers; its request body (POST/PUT) as a 2 KB preview with secret-looking values redacted, form fields by name, binary as size. captureBodies:true keeps document/xhr/fetch response bodies from then on (the debugger stays attached until false); requestId then adds responseBody (credentials in JSON redacted).',
  inputSchema: z.object({
    tabId: requireTabId(),
    filter: z.string().optional().describe('URL regex'),
    urlPattern: z.string().optional().describe('URL substring, e.g. "/api/"'),
    type: z.union([z.string(), z.array(z.string())]).optional().describe('xhr, fetch, document, script, stylesheet, image, font, media, websocket, other…'),
    failed: z.boolean().optional().describe('Errors and 4xx/5xx only'),
    requestId: z.string().optional(),
    fullUrls: z.boolean().optional().describe('Keep long URLs whole'),
    limit: z.number().int().min(1).max(200).optional().describe('Latest N'),
    clear: z.boolean().optional().default(false).describe('Empty requests and bodies after reading'),
    captureBodies: z.boolean().optional().describe('true: keep bodies from now on; false: stop'),
  }),
  // NOT idempotent: `clear:true` mutates the buffer (same reasoning as console — M2).
  idempotent: false,
  // captureBodies:true attaches the debugger first (its setup probes are bounded at 5 s).
  timeoutMs: 10_000,
  handler: forwardHandler("browser_network"),
};
