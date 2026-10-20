import { z } from "zod";
import type { ToolDefinition } from "./types.js";
import { requireTabId, forwardHandler } from "./types.js";

export const dialogTool: ToolDefinition = {
  name: "browser_handle_dialog",
  description:
    "Accept or dismiss the alert/confirm/prompt open in the tab. A tool call that leaves one open returns `dialog: {type, message}`; while it is open, page tools fail with DIALOG_OPEN.",
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
