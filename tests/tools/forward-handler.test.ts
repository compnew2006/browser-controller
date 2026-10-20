import { describe, it, expect } from "vitest";
import { forwardHandler } from "../../mcp-server/src/tools/types.js";
import type { ToolHost, ToolResult } from "../../mcp-server/src/tools/types.js";

/**
 * forwardHandler wire format (contract 3.0):
 * - success: one text content = the extension's `text`; JSON only when there is no text.
 * - failure ({success:false}, or a rejection carrying that payload): isError, text = `CODE: message`.
 * - screenshot: the image content plus the one text line.
 * - transport errors (no payload) re-throw for wrapHandler.
 */

const hostWith = (impl: (tool: string, params: Record<string, unknown>) => Promise<unknown>): ToolHost => ({ callTool: impl });
const textOf = (result: ToolResult) => (result.content.find((c) => c.type === "text") as { text: string }).text;

describe("forwardHandler", () => {
  it("returns the extension's text as the one text content", async () => {
    const handler = forwardHandler("browser_click");
    const host = hostWith(async () => ({ success: true, text: "ok", navigated: "https://x.test/" }));
    const result = await handler(host, { tabId: 1, target: "#a" });
    expect(result.isError).toBeUndefined();
    expect(result.content).toEqual([{ type: "text", text: "ok" }]);
  });

  it("falls back to JSON when the result has no text (old handlers)", async () => {
    const handler = forwardHandler("browser_click");
    const host = hostWith(async () => ({ success: true, clicked: true }));
    const result = await handler(host, { tabId: 1, target: "#a" });
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(textOf(result))).toEqual({ success: true, clicked: true });
  });

  it("returns a failure as isError with the plain CODE: message text, not JSON", async () => {
    const handler = forwardHandler("browser_click");
    const host = hostWith(async () => ({ success: false, error: "ELEMENT_HIDDEN: #a is hidden" }));
    const result = await handler(host, { tabId: 1, target: "#a" });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe("ELEMENT_HIDDEN: #a is hidden");
  });

  it("turns a payload-carrying rejection into the same isError result", async () => {
    const handler = forwardHandler("browser_click");
    const host = hostWith(async () => {
      const err = new Error("REF_GONE: take a new browser_snapshot");
      (err as Error & { result?: unknown }).result = { success: false, error: "REF_GONE: take a new browser_snapshot" };
      throw err;
    });
    const result = await handler(host, { tabId: 1, target: "e5" });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe("REF_GONE: take a new browser_snapshot");
  });

  it("returns the image as image content, with its one text line after it", async () => {
    const handler = forwardHandler("browser_screenshot");
    const host = hostWith(async () => ({
      success: true,
      text: "1280x800 jpeg, viewport",
      image: { data: "AAAA", mimeType: "image/jpeg" },
      tabId: 3,
    }));
    const result = await handler(host, { tabId: 3 });
    expect(result.content).toEqual([
      { type: "image", data: "AAAA", mimeType: "image/jpeg" },
      { type: "text", text: "1280x800 jpeg, viewport" },
    ]);
  });

  it("keeps the image out of the JSON fallback", async () => {
    const handler = forwardHandler("browser_screenshot");
    const host = hostWith(async () => ({ success: true, image: { data: "BBBB", mimeType: "image/jpeg" } }));
    const result = await handler(host, { tabId: 3 });
    expect(result.content.filter((c) => c.type === "text")).toHaveLength(1);
    expect(JSON.stringify(result.content.filter((c) => c.type === "text"))).not.toContain("BBBB");
  });

  it("re-throws rejections without a payload (transport errors keep their message)", async () => {
    const handler = forwardHandler("browser_click");
    const host = hostWith(async () => {
      throw new Error("Chrome extension not connected");
    });
    await expect(handler(host, {})).rejects.toThrow("Chrome extension not connected");
  });

  it("tags the returned handler with its wire name (registry drift guard)", () => {
    const handler = forwardHandler("browser_click");
    expect((handler as { toolName?: string }).toolName).toBe("browser_click");
  });
});
