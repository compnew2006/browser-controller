import { z } from "zod";
import type { ToolDefinition } from "./types.js";
import { requireTabId, forwardHandler } from "./types.js";

export const dialogTool: ToolDefinition = {
  name: "browser_handle_dialog",
  summary: "Handle or dismiss browser dialogs (alert/confirm/prompt)",
  description:
    "Handle JavaScript dialogs (alert, confirm, prompt). Dialogs block page interaction until handled. Answers the dialog that is open on the tab; NO_DIALOG when none is. A dialog that opened before the tab had a debugger session cannot be reached, so keep a session on the tab by using browser_* tools on it.",
  inputSchema: z.object({
    tabId: requireTabId(),
    action: z
      .enum(["accept", "dismiss"])
      .describe("Accept or dismiss the dialog"),
    promptText: z
      .string()
      .optional()
      .describe("Text to enter for prompt() dialogs"),
  }),
  timeoutMs: 5_000,
  handler: forwardHandler("browser_handle_dialog"),
};
