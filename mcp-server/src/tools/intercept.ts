import { z } from "zod";
import type { ToolDefinition } from "./types.js";
import { tabIdParam, forwardHandler } from "./types.js";

const ruleAction = z.enum(["log", "block", "redirect", "header", "mock"]);

const ruleSchema = z.object({
  id: z.string().min(1).max(64).optional(),
  match: z.string().min(1).max(500),
  types: z.array(z.string().min(1).max(32)).max(20).optional(),
  tabIds: z.array(z.number().refine(Number.isInteger)).max(50).optional(),
  action: ruleAction,
  redirectUrl: z.string().max(2000).optional(),
  headers: z.record(z.string(), z.string()).optional().describe("header: request headers to set; mock: response headers"),
  mockStatus: z.number().int().min(100).max(599).optional().describe("Default 200"),
  mockBody: z.string().max(20_000).optional(),
  enabled: z.boolean().optional().default(true),
});

export const interceptTool: ToolDefinition = {
  name: "browser_intercept",
  summary: "Manage request intercept rules and captures per tab",
  description:
    "Per-tab network rules: block, redirect, header (set request headers), mock (answers the page with mockStatus / mockBody / headers through the debugger; needs a tabId) or log (recorded only), plus captures and a redacted HAR. set-rules needs tabId (or tabIds on every rule, or global:true for every tab of the browser, including the user's own tabs); without one it fails with TAB_REQUIRED. URL regexes are case-sensitive RE2 (no lookahead or backreferences): a rejected regex fails the call with INVALID_REGEX and changes nothing. Ledger-only or unservable rules are listed under unsupported (enforcement 'partial', or 'capture-only' when no rule is applied); check enforcement / enforced / unsupported in the result.",
  inputSchema: z.object({
    tabId: tabIdParam
      .optional()
      .describe("Target tab id. Required for set-rules unless every rule sets tabIds or global:true is passed."),
    global: z
      .boolean()
      .optional()
      .describe("Apply to every tab of the browser, including the user's own tabs. For set-rules without tabId."),
    action: z
      .enum([
        "set-rules",
        "list-rules",
        "clear-rules",
        "list-captures",
        "export-har",
      ]),
    rules: z
      .array(ruleSchema)
      .max(50)
      .optional()
      .describe("set-rules: replaces the rules of that scope (max 50)"),
    filter: z
      .string()
      .optional()
      .describe("URL regex"),
    limit: z
      .number()
      .int()
      .min(1)
      .max(200)
      .optional()
      .describe(
        "Latest N",
      ),
  }),
  // Mutating (rule CRUD); list-captures shares the tool so the whole tool is non-idempotent.
  idempotent: false,
  timeoutMs: 10_000,
  handler: forwardHandler("browser_intercept"),
};
