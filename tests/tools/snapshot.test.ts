import { describe, expect, it } from "vitest";
import { snapshotTool } from "../../mcp-server/src/tools/snapshot.js";
import type { ToolHost } from "../../mcp-server/src/tools/types.js";

describe("browser_snapshot tool", () => {
  const parse = (extra: Record<string, unknown>) =>
    snapshotTool.inputSchema.safeParse({ tabId: 1, ...extra });

  it("takes query / selector / ref / maxChars, all optional", () => {
    expect(parse({}).success).toBe(true);
    expect(parse({ query: "save button", maxChars: 2000 }).success).toBe(true);
    expect(parse({ maxChars: 10 }).success).toBe(false);
  });

  it("hands the model plain lines, not escaped JSON", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const host: ToolHost = {
      callTool: async (_tool, params) => {
        seen.push(params);
        return { success: true, url: "https://a.test/", title: "A", snapshot: '- button "Save" [s1-0]', truncated: true, hint: "Cut at maxChars" };
      },
    };
    const out = await snapshotTool.handler(host, { tabId: 4 });
    expect(seen).toEqual([{ tabId: 4 }]);
    expect(out.content).toEqual([{ type: "text", text: 'Page: A (https://a.test/)\n- button "Save" [s1-0]\n[Cut at maxChars]' }]);
  });

  it("labels query results and passes failures through as errors", async () => {
    const host: ToolHost = { callTool: async () => ({ success: true, query: "save", snapshot: '- button "Save" [f1-0]' }) };
    expect((await snapshotTool.handler(host, { tabId: 1, query: "save" })).content[0]).toEqual({ type: "text", text: 'Matches for "save":\n- button "Save" [f1-0]' });
    const failing: ToolHost = { callTool: async () => ({ success: false, error: "Invalid CSS selector: [" }) };
    const out = await snapshotTool.handler(failing, { tabId: 1, selector: "[" });
    expect(out.isError).toBe(true);
  });

  it("stays idempotent (safe to retry on timeout)", () => {
    expect(snapshotTool.idempotent).toBe(true);
  });
});
