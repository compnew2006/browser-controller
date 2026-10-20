import { z } from "zod";
import type { ToolDefinition } from "./types.js";
import { requireTabId, forwardHandler } from "./types.js";

export const dialogTool: ToolDefinition = {
  name: "browser_handle_dialog",
  summary: "Handle or dismiss browser dialogs (alert/confirm/prompt)",
  description:
    "Accept or dismiss an alert/confirm/prompt — works even while the dialog freezes the page.",
  inputSchema: z.object({
    tabId: requireTabId(),
    action: z
      .enum(["accept", "dismiss"]),
    promptText: z
      .string()
      .optional()
      .describe("Text for prompt()"),
  }),
  timeoutMs: 5_000,
  handler: forwardHandler("browser_handle_dialog"),
};
