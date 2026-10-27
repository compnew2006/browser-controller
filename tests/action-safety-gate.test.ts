import { describe, expect, it } from "vitest";
import { clickTool } from "../mcp-server/src/tools/click.js";
import { typeTool } from "../mcp-server/src/tools/type.js";
import { fillTool } from "../mcp-server/src/tools/fill.js";
import { evaluateTool } from "../mcp-server/src/tools/evaluate.js";
import {
  attachSafetyController,
  setSafetySettings,
  type SafetyAction,
} from "../mcp-server/src/tools/action-support.js";
import type { ToolHost, ToolResult } from "../mcp-server/src/tools/types.js";

type Confirm = "approved" | "declined" | "unavailable" | "throw";

interface Setup {
  site?: string;
  categories?: string[];
  classifier?: "ok" | "reject" | "invalid" | "hang";
  confirm?: Confirm | null; // null: no controller attached
  enabled?: boolean;
  defaultAction?: SafetyAction;
  siteRules?: Array<{ site: string; action: SafetyAction }>;
  // Classifier answers for successive calls (second call is the post-confirmation recheck).
  recheck?: string[];
}

function setup(opts: Setup = {}) {
  const sent: Array<{ tool: string; params: Record<string, unknown> }> = [];
  const classified: Array<Record<string, unknown>> = [];
  const confirms: Array<Record<string, unknown>> = [];
  let classifyCalls = 0;
  const host: ToolHost = {
    async callTool(tool, params) {
      if (tool === "browser_classify_action") {
        classified.push(params);
        const call = classifyCalls++;
        if (opts.classifier === "reject") throw new Error("boom");
        if (opts.classifier === "invalid") return { success: false, error: "TAB_GONE: no tab" };
        const categories = call > 0 && opts.recheck ? opts.recheck : opts.categories ?? [];
        return { success: true, site: opts.site ?? "example.com", categories, fingerprints: [] };
      }
      sent.push({ tool, params });
      return { success: true, text: "ok" };
    },
  };
  if (opts.confirm !== null) {
    attachSafetyController(host, {
      async confirm(details) {
        confirms.push(details);
        if (opts.confirm === "throw") throw new Error("elicit failed");
        return (opts.confirm ?? "approved") as "approved" | "declined" | "unavailable";
      },
    });
  } else {
    attachSafetyController(host, undefined as never);
  }
  setSafetySettings(host, {
    enabled: opts.enabled ?? true,
    defaultAction: opts.defaultAction ?? "ask",
    siteRules: opts.siteRules ?? [],
  });
  return { host, sent, classified, confirms };
}

const text = (res: ToolResult) => (res.content.find((c) => c.type === "text") as { text: string }).text;
const click = { tabId: 1, target: "e1" };
const sentActions = (s: { sent: Array<{ tool: string }> }) => s.sent.filter((c) => c.tool !== "browser_snapshot");

describe("action safety gate: disabled", () => {
  it("dispatches without classifying", async () => {
    const s = setup({ enabled: false, categories: ["submit"], defaultAction: "block" });
    const res = await clickTool.handler(s.host, click);
    expect(res.isError).toBeUndefined();
    expect(s.classified).toHaveLength(0);
    expect(sentActions(s)).toHaveLength(1);
  });
});

describe("action safety gate: allow / block / ask per category", () => {
  for (const category of ["submit", "delete", "upload", "unknown"]) {
    it(`allow dispatches (${category})`, async () => {
      const s = setup({ categories: [category], defaultAction: "allow" });
      const res = await clickTool.handler(s.host, click);
      expect(res.isError).toBeUndefined();
      expect(sentActions(s)).toHaveLength(1);
    });

    it(`block refuses with ACTION_BLOCKED and never dispatches (${category})`, async () => {
      const s = setup({ categories: [category], defaultAction: "block" });
      const res = await clickTool.handler(s.host, click);
      expect(res.isError).toBe(true);
      expect(text(res)).toMatch(/^ACTION_BLOCKED:/);
      expect(text(res)).toContain(category);
      expect(sentActions(s)).toHaveLength(0);
      expect((res.structuredContent as { receipt: { status: string } }).receipt.status).toBe("not_dispatched");
    });

    it(`ask + approved dispatches after rechecking (${category})`, async () => {
      const s = setup({ categories: [category], defaultAction: "ask", confirm: "approved" });
      const res = await clickTool.handler(s.host, click);
      expect(res.isError).toBeUndefined();
      expect(s.confirms).toHaveLength(1);
      expect(s.confirms[0]).toMatchObject({ categories: [category], site: "example.com", tool: "browser_click" });
      expect(s.classified).toHaveLength(2);
      expect(sentActions(s)).toHaveLength(1);
    });
  }

  it("no category: dispatches whatever the default is", async () => {
    const s = setup({ categories: [], defaultAction: "block" });
    const res = await clickTool.handler(s.host, click);
    expect(res.isError).toBeUndefined();
    expect(sentActions(s)).toHaveLength(1);
  });

  it("hover click skips the gate", async () => {
    const s = setup({ categories: ["submit"], defaultAction: "block" });
    const res = await clickTool.handler(s.host, { ...click, hover: true });
    expect(res.isError).toBeUndefined();
    expect(s.classified).toHaveLength(0);
  });

  it("type with submit is gated too", async () => {
    const s = setup({ categories: ["submit"], defaultAction: "block" });
    const res = await typeTool.handler(s.host, { tabId: 1, target: "e1", text: "x", submit: true });
    expect(text(res)).toMatch(/^ACTION_BLOCKED:/);
    expect(sentActions(s)).toHaveLength(0);
  });
});

describe("action safety gate: site rules", () => {
  it("a site rule allow overrides a default block", async () => {
    const s = setup({ categories: ["submit"], defaultAction: "block", siteRules: [{ site: "example.com", action: "allow" }] });
    expect((await clickTool.handler(s.host, click)).isError).toBeUndefined();
    expect(sentActions(s)).toHaveLength(1);
  });

  it("a site rule block overrides a default allow", async () => {
    const s = setup({ categories: ["delete"], defaultAction: "allow", siteRules: [{ site: "example.com", action: "block" }] });
    expect(text(await clickTool.handler(s.host, click))).toMatch(/^ACTION_BLOCKED:/);
    expect(sentActions(s)).toHaveLength(0);
  });

  it("a rule for another site does not apply", async () => {
    const s = setup({ categories: ["submit"], defaultAction: "block", siteRules: [{ site: "other.com", action: "allow" }] });
    expect(text(await clickTool.handler(s.host, click))).toMatch(/^ACTION_BLOCKED:/);
  });
});

describe("action safety gate: ask / elicitation", () => {
  it("declined: ACTION_NOT_CONFIRMED, not dispatched", async () => {
    const s = setup({ categories: ["submit"], confirm: "declined" });
    const res = await clickTool.handler(s.host, click);
    expect(text(res)).toMatch(/^ACTION_NOT_CONFIRMED:/);
    expect(sentActions(s)).toHaveLength(0);
  });

  it("client cannot elicit: CLIENT_CONFIRMATION_UNAVAILABLE, not dispatched", async () => {
    const s = setup({ categories: ["submit"], confirm: "unavailable" });
    expect(text(await clickTool.handler(s.host, click))).toMatch(/^CLIENT_CONFIRMATION_UNAVAILABLE:/);
    expect(sentActions(s)).toHaveLength(0);
  });

  it("confirm throws: treated as unavailable", async () => {
    const s = setup({ categories: ["submit"], confirm: "throw" });
    expect(text(await clickTool.handler(s.host, click))).toMatch(/^CLIENT_CONFIRMATION_UNAVAILABLE:/);
    expect(sentActions(s)).toHaveLength(0);
  });

  it("no controller attached: unavailable", async () => {
    const s = setup({ categories: ["submit"], confirm: null });
    expect(text(await clickTool.handler(s.host, click))).toMatch(/^CLIENT_CONFIRMATION_UNAVAILABLE:/);
    expect(sentActions(s)).toHaveLength(0);
  });

  it("page changed category while confirming: SAFETY_TARGET_CHANGED, not dispatched", async () => {
    const s = setup({ categories: ["submit"], recheck: ["delete"], confirm: "approved" });
    expect(text(await clickTool.handler(s.host, click))).toMatch(/^SAFETY_TARGET_CHANGED:/);
    expect(sentActions(s)).toHaveLength(0);
  });
});

describe("action safety gate: classifier failure is fail-closed", () => {
  it("classifier throws: SAFETY_CHECK_FAILED, not dispatched", async () => {
    const s = setup({ classifier: "reject", defaultAction: "allow" });
    const res = await clickTool.handler(s.host, click);
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/^SAFETY_CHECK_FAILED:/);
    expect(sentActions(s)).toHaveLength(0);
  });

  it("classifier returns failure: SAFETY_CHECK_FAILED with its error", async () => {
    const s = setup({ classifier: "invalid", defaultAction: "allow" });
    const res = await clickTool.handler(s.host, click);
    expect(text(res)).toMatch(/^SAFETY_CHECK_FAILED: TAB_GONE/);
    expect(sentActions(s)).toHaveLength(0);
  });
});

describe("browser_fill: blocked result carries the same receipt as click", () => {
  it("block returns a not_dispatched receipt and sends nothing", async () => {
    const s = setup({ categories: ["upload"], defaultAction: "block" });
    const res = await fillTool.handler(s.host, { tabId: 1, fields: [{ target: "e4", value: "Ada" }] });
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/^ACTION_BLOCKED:/);
    expect(res.structuredContent).toEqual({
      success: false,
      receipt: { tool: "browser_fill", status: "not_dispatched", summary: "failed (ACTION_BLOCKED)" },
    });
    expect(sentActions(s)).toHaveLength(0);
  });

  it("allowed fill is still dispatched", async () => {
    const s = setup({ categories: ["upload"], defaultAction: "allow" });
    const res = await fillTool.handler(s.host, { tabId: 1, fields: [{ target: "e4", value: "Ada" }] });
    expect(res.isError).toBeUndefined();
    expect(sentActions(s)).toHaveLength(1);
  });
});

describe("browser_evaluate follows the site's action while safety is on", () => {
  const evalParams = { tabId: 1, expression: "document.forms[0].submit()" };
  const evals = (s: ReturnType<typeof setup>) => s.sent.filter((c) => c.tool === "browser_evaluate");

  it("disabled: unchanged, no classifier call", async () => {
    const s = setup({ enabled: false, defaultAction: "block" });
    const res = await evaluateTool.handler(s.host, evalParams);
    expect(res.isError).toBeUndefined();
    expect(res.structuredContent).toBeUndefined();
    expect(s.classified).toHaveLength(0);
    expect(evals(s)).toHaveLength(1);
  });

  it("block: ACTION_BLOCKED with receipt, not dispatched", async () => {
    const s = setup({ defaultAction: "block" });
    const res = await evaluateTool.handler(s.host, evalParams);
    expect(text(res)).toMatch(/^ACTION_BLOCKED:/);
    expect(res.structuredContent).toMatchObject({ success: false, receipt: { tool: "browser_evaluate", status: "not_dispatched" } });
    expect(evals(s)).toHaveLength(0);
  });

  it("allow: runs, and never classifies an element", async () => {
    const s = setup({ defaultAction: "allow" });
    const res = await evaluateTool.handler(s.host, evalParams);
    expect(res.isError).toBeUndefined();
    expect(evals(s)).toHaveLength(1);
    expect(s.classified[0]).toEqual({ tabId: 1, action: "browser_evaluate" }); // host lookup only: no target, no expression
  });

  it("site rule overrides the default", async () => {
    const s = setup({ defaultAction: "block", siteRules: [{ site: "example.com", action: "allow" }] });
    expect((await evaluateTool.handler(s.host, evalParams)).isError).toBeUndefined();
    expect(evals(s)).toHaveLength(1);
  });

  it("ask + approved: confirms (without the expression) then runs", async () => {
    const s = setup({ defaultAction: "ask", confirm: "approved" });
    const res = await evaluateTool.handler(s.host, evalParams);
    expect(res.isError).toBeUndefined();
    expect(s.confirms).toEqual([{ categories: ["evaluate"], site: "example.com", tool: "browser_evaluate" }]);
    expect(evals(s)).toHaveLength(1);
  });

  it("ask + declined: not dispatched", async () => {
    const s = setup({ defaultAction: "ask", confirm: "declined" });
    expect(text(await evaluateTool.handler(s.host, evalParams))).toMatch(/^ACTION_NOT_CONFIRMED:/);
    expect(evals(s)).toHaveLength(0);
  });

  it("ask + unavailable: not dispatched", async () => {
    const s = setup({ defaultAction: "ask", confirm: "unavailable" });
    expect(text(await evaluateTool.handler(s.host, evalParams))).toMatch(/^CLIENT_CONFIRMATION_UNAVAILABLE:/);
    expect(evals(s)).toHaveLength(0);
  });

  it("host lookup fails: SAFETY_CHECK_FAILED, not dispatched", async () => {
    const s = setup({ classifier: "reject", defaultAction: "allow" });
    expect(text(await evaluateTool.handler(s.host, evalParams))).toMatch(/^SAFETY_CHECK_FAILED:/);
    expect(evals(s)).toHaveLength(0);
  });
});
