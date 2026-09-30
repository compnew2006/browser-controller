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
  headers: z.record(z.string(), z.string()).optional(),
  mockStatus: z.number().int().min(100).max(599).optional(),
  mockBody: z.string().max(20_000).optional(),
  enabled: z.boolean().optional().default(true),
});

export const interceptTool: ToolDefinition = {
  name: "browser_intercept",
  summary: "Manage request intercept rules and captures per tab",
  description:
    "Capture, block, redirect, or add request headers to network traffic per tab (Chrome session rules). Actions: set-rules, list-rules, clear-rules, list-captures, export-har. 'mock' and 'log' rules are recorded in the capture ledger only — Chrome cannot fake response bodies — and set-rules reports them under unsupported with enforcement 'partial'.",
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
