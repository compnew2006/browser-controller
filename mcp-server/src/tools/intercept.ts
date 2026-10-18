import { z } from "zod";
import type { ToolDefinition } from "./types.js";
import { forwardHandler } from "./types.js";

const ruleAction = z.enum(["log", "block", "redirect", "header", "mock"]);

const ruleSchema = z.object({
  id: z.string().min(1).max(64).optional(),
  match: z.string().min(1).max(500),
  types: z.array(z.string().min(1).max(32)).max(20).optional(),
  tabIds: z.array(z.number().int()).max(50).optional(),
  action: ruleAction,
  redirectUrl: z.string().max(2000).optional(),
  headers: z.record(z.string(), z.string()).optional().describe("header rules: request headers to set. mock rules: response headers of the mock (Content-Type defaults to application/json for a JSON body, else text/plain)"),
  mockStatus: z.number().int().min(100).max(599).optional().describe("mock rules: response status (default 200)"),
  mockBody: z.string().max(20_000).optional().describe("mock rules: response body"),
  enabled: z.boolean().optional().default(true),
});

export const interceptTool: ToolDefinition = {
  name: "browser_intercept",
  summary: "Manage request intercept rules and captures per tab",
  description:
    "Capture, block, redirect, add request headers to, or mock network traffic per tab. Actions: set-rules, list-rules, clear-rules, list-captures, export-har. block/redirect/header use Chrome session rules. 'mock' rules answer matching requests with mockStatus/mockBody/headers instead of the network — the page really receives the mock (cross-origin callers and their CORS preflight are allowed) — through the tab's debugger, so they need a tabId (or tabIds) and the yellow banner stays while they are set; a global mock or a tab whose debugger cannot attach is reported under unsupported. 'log' rules are recorded in the capture ledger only. Check enforcement/enforced in the result.",
  inputSchema: z.object({
    tabId: z
      .number()
      .int()
      .optional()
      .describe("Target tab id. If omitted, rules apply globally."),
    action: z
      .enum([
        "set-rules",
        "list-rules",
        "clear-rules",
        "list-captures",
        "export-har",
      ])
      .describe("Intercept action to perform"),
    rules: z
      .array(ruleSchema)
      .max(50)
      .optional()
      .describe("Rules for set-rules (max 50)"),
    filter: z
      .string()
      .optional()
      .describe("URL regex pattern to filter captures"),
    limit: z
      .number()
      .int()
      .min(1)
      .max(200)
      .optional()
      .describe(
        "Return only the most recent N captures (default: all buffered, up to 200)",
      ),
  }),
  // Mutating (rule CRUD); list-captures shares the tool so the whole tool is non-idempotent.
  idempotent: false,
  timeoutMs: 10_000,
  handler: forwardHandler("browser_intercept"),
};
