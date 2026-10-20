import { z } from "zod";
import type { ToolDefinition } from "./types.js";
import { tabIdParam, forwardHandler } from "./types.js";

export const dialogTool: ToolDefinition = {
  name: "browser_handle_dialog",
  summary: "Accept or dismiss an open JavaScript dialog",
  description: "Accept or dismiss the open alert, confirm or prompt; promptText answers a prompt. No open dialog: NO_DIALOG.",
  inputSchema: z.object({
    tabId: tabIdParam,
    accept: z.boolean(),
    promptText: z.string().optional(),
  }).strict(),
  timeoutMs: 5_000,
  handler: forwardHandler("browser_handle_dialog"),
};
