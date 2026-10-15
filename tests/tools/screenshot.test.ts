import { describe, expect, it } from "vitest";
import { screenshotTool } from "../../mcp-server/src/tools/screenshot.js";
import type { ToolHost } from "../../mcp-server/src/tools/types.js";

const hostReturning = (result: unknown): ToolHost => ({ callTool: async () => result });

describe("browser_screenshot (element capture)", () => {
  it("accepts ref and selector so they reach the extension instead of being stripped", () => {
    const parsed = screenshotTool.inputSchema.safeParse({ tabId: 1, ref: "s1-4", selector: "#grid" });
    expect(parsed.success && parsed.data).toMatchObject({ ref: "s1-4", selector: "#grid" });
  });

  it("surfaces the extension's error (element not found) instead of a generic no-data message", async () => {
    const res = await screenshotTool.handler(hostReturning({ success: false, error: "Element not found" }), { tabId: 1, ref: "gone" });
    expect(res.isError).toBe(true);
    expect(JSON.parse((res.content[0] as { text: string }).text)).toEqual({ success: false, error: "Element not found" });
  });

  it("tells the agent when the element did not fit the viewport", async () => {
    const res = await screenshotTool.handler(hostReturning({
      success: true, format: "png", data: "AAAA", width: 58, height: 38,
      frame: { scale: 1, origin: [96, 196], viewport: [1000, 600] }, element: { clipped: true },
    }), { tabId: 1, ref: "s1-4" });
    const meta = JSON.parse((res.content.find((c) => c.type === "text") as { text: string }).text);
    expect(meta).toMatchObject({ image: [58, 38], element: { clipped: true } });
  });
});
