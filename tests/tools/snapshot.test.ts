import { describe, expect, it } from "vitest";
import { snapshotTool } from "../../mcp-server/src/tools/snapshot.js";
import type { ToolHost } from "../../mcp-server/src/tools/types.js";

describe("browser_snapshot schema", () => {
  const parse = (extra: Record<string, unknown>) =>
    snapshotTool.inputSchema.safeParse({ tabId: 1, ...extra });

  it('accepts source "dom" and "native", and leaves it optional (DOM stays the default)', () => {
    expect(parse({ source: "native" }).success).toBe(true);
    expect(parse({ source: "dom" }).success).toBe(true);
    const bare = parse({});
    expect(bare.success).toBe(true);
    expect(bare.success && bare.data.source).toBeUndefined();
  });

  it("rejects an unknown source", () => {
    expect(parse({ source: "axtree" }).success).toBe(false);
  });

  it("documents the native option for agents", () => {
    expect(snapshotTool.description).toContain('source:"native"');
  });

  it("forwards source to the extension untouched", async () => {
    const seen: Array<{ tool: string; params: Record<string, unknown> }> = [];
    const host: ToolHost = {
      callTool: async (tool, params) => {
        seen.push({ tool, params });
        return { success: true, source: "native" };
      },
    };
    await snapshotTool.handler(host, { tabId: 4, source: "native", compact: false });
    expect(seen).toEqual([
      { tool: "browser_snapshot", params: { tabId: 4, source: "native", compact: false } },
    ]);
  });

  it("stays idempotent (safe to retry on timeout)", () => {
    expect(snapshotTool.idempotent).toBe(true);
  });
});
