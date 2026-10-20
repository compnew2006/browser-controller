import { describe, expect, it } from "vitest";
import { snapshotTool } from "../../mcp-server/src/tools/snapshot.js";
import type { ToolHost } from "../../mcp-server/src/tools/types.js";

describe("browser_snapshot schema", () => {
  const parse = (extra: Record<string, unknown>) =>
    snapshotTool.inputSchema.safeParse({ tabId: 1, ...extra });

  it("accepts target, query and maxChars, and all of them are optional", () => {
    expect(parse({}).success).toBe(true);
    expect(parse({ target: "e4", query: "Sign in", maxChars: 2000 }).success).toBe(true);
  });

  it("caps maxChars at 50000", () => {
    expect(parse({ maxChars: 50_000 }).success).toBe(true);
    expect(parse({ maxChars: 50_001 }).success).toBe(false);
  });

  it("drops the retired knobs (source, compact, filter, depth, selector, ref)", () => {
    const keys = Object.keys(snapshotTool.inputSchema.shape);
    expect(keys.sort()).toEqual(["maxChars", "query", "tabId", "target"]);
  });

  it("forwards its params to the extension untouched", async () => {
    const seen: Array<{ tool: string; params: Record<string, unknown> }> = [];
    const host: ToolHost = {
      callTool: async (tool, params) => {
        seen.push({ tool, params });
        return { success: true, text: "- heading \"Home\" [e1]" };
      },
    };
    await snapshotTool.handler(host, { tabId: 4, target: "e2", maxChars: 3000 });
    expect(seen).toEqual([{ tool: "browser_snapshot", params: { tabId: 4, target: "e2", maxChars: 3000 } }]);
  });

  it("stays idempotent (safe to retry on timeout)", () => {
    expect(snapshotTool.idempotent).toBe(true);
  });
});
