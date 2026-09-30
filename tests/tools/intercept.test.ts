import { describe, it, expect } from "vitest";
import { interceptTool } from "../../mcp-server/src/tools/intercept.js";
import {
  toolMap,
  isIdempotent,
  toolTimeoutMs,
} from "../../mcp-server/src/tools/index.js";

describe("browser_intercept tool (S1)", () => {
  it("is registered in the tool map", () => {
    expect(toolMap.get("browser_intercept")).toBe(interceptTool);
  });

  it("has a concise summary for progressive disclosure", () => {
    expect(interceptTool.summary.length).toBeGreaterThan(10);
    expect(interceptTool.summary.length).toBeLessThan(80);
  });

  it("declares timeoutMs and is non-idempotent (mutating)", () => {
    expect(typeof interceptTool.timeoutMs).toBe("number");
    expect(toolTimeoutMs("browser_intercept")).toBe(interceptTool.timeoutMs);
    expect(isIdempotent("browser_intercept")).toBe(false);
  });

  it("sends its own wire name (no drift)", () => {
    expect((interceptTool.handler as { toolName?: string }).toolName).toBe(
      "browser_intercept",
    );
  });

  it("accepts a valid set-rules payload", () => {
    const parsed = interceptTool.inputSchema.safeParse({
      action: "set-rules",
      tabId: 15,
      rules: [
        {
          match: "https://api\\.example\\.com/.*",
          action: "mock",
          mockStatus: 200,
          mockBody: "{}",
        },
      ],
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects an invalid action", () => {
    const parsed = interceptTool.inputSchema.safeParse({
      action: "nuke",
      tabId: 15,
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects a 51-rule payload (cap)", () => {
    const rules = Array.from({ length: 51 }, (_, i) => ({
      id: `r${i}`,
      match: `https://x${i}\\.com/`,
      action: "log",
    }));
    const parsed = interceptTool.inputSchema.safeParse({
      action: "set-rules",
      rules,
    });
    expect(parsed.success).toBe(false);
  });
});
