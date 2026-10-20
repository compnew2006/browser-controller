import { z } from "zod";
import type { ToolDefinition } from "./types.js";
import { requireTabId, forwardHandler } from "./types.js";

export const dialogTool: ToolDefinition = {
  name: "browser_handle_dialog",
  summary: "Handle or dismiss browser dialogs (alert/confirm/prompt)",
  description:
    "Accept or dismiss a JavaScript dialog (alert, confirm, prompt), even while it freezes the page. Needs a debugger session on the tab: a dialog that opened before one existed cannot be reached, so use any browser_* tool on the tab first to keep a session. NO_DIALOG when none is open.",
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
