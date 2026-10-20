import { describe, expect, it } from "vitest";
import { screenshotTool } from "../../mcp-server/src/tools/screenshot.js";
import type { ToolHost } from "../../mcp-server/src/tools/types.js";

const hostReturning = (result: unknown): ToolHost => ({ callTool: async () => result });

describe("browser_screenshot", () => {
  it("accepts target and region, and has no fullPage / format / scale knobs", () => {
    expect(screenshotTool.inputSchema.safeParse({ tabId: 1, target: "e12" }).success).toBe(true);
    expect(screenshotTool.inputSchema.safeParse({ tabId: 1, region: { x: 0, y: 0, width: 10, height: 10 } }).success).toBe(true);
    expect(Object.keys(screenshotTool.inputSchema.shape).sort()).toEqual(["region", "tabId", "target"]);
  });

  it("returns the image plus its one text line", async () => {
    const res = await screenshotTool.handler(hostReturning({
      success: true, text: "element e12 340x120", image: { data: "AAAA", mimeType: "image/jpeg" },
    }), { tabId: 1, target: "e12" });
    expect(res.content).toEqual([
      { type: "image", data: "AAAA", mimeType: "image/jpeg" },
      { type: "text", text: "element e12 340x120" },
    ]);
  });

  it("surfaces an element failure as isError with the CODE: message text", async () => {
    const res = await screenshotTool.handler(hostReturning({ success: false, error: "NOT_FOUND: no element for e9" }), { tabId: 1, target: "e9" });
    expect(res.isError).toBe(true);
    expect(res.content).toEqual([{ type: "text", text: "NOT_FOUND: no element for e9" }]);
  });

  it("is idempotent (safe to retry on timeout) and has a timeout", () => {
    expect(screenshotTool.idempotent).toBe(true);
    expect(screenshotTool.timeoutMs).toBeGreaterThan(0);
  });
});
