import { describe, it, expect } from "vitest";
import { allTools, toolMap } from "../../mcp-server/src/tools/index.js";
import { codedMessageOf, unknownParameterHint } from "../../mcp-server/src/tools/types.js";

/**
 * Strict input schemas (contract 3.0 / FIX-SCHEMA): an unknown key is an
 * error, never silently stripped. Every tool is in the per-tool loops, browser_fill included.
 */
const ownedTools = allTools;

/** The keys a schema reports as unrecognized for this input. */
function unknownKeysOf(schema: { safeParse: (v: unknown) => { success: boolean; error?: { issues: Array<{ code: string; keys?: string[] }> } } }, input: unknown): string[] {
  const result = schema.safeParse(input);
  if (result.success) return [];
  return (result.error?.issues ?? []).filter((i) => i.code === "unrecognized_keys").flatMap((i) => i.keys ?? []);
}

describe("strict input schemas", () => {
  it("every owned tool reports an unknown top-level key by name", () => {
    for (const tool of ownedTools) {
      expect(unknownKeysOf(tool.inputSchema, { bogus: 1 }), tool.name).toEqual(["bogus"]);
    }
  });

  it("a 2.x parameter that 3.0 dropped is an unknown key, not a silent no-op", () => {
    expect(unknownKeysOf(toolMap.get("browser_screenshot")!.inputSchema, { tabId: 1, fullPage: true })).toEqual(["fullPage"]);
    expect(unknownKeysOf(toolMap.get("browser_screenshot")!.inputSchema, { tabId: 1, format: "png", quality: 80, scale: 1, maxWidth: 800 }))
      .toEqual(["format", "quality", "scale", "maxWidth"]);
    expect(unknownKeysOf(toolMap.get("browser_inspect_element")!.inputSchema, { tabId: 1, ref: "e1", selector: "#a", include: ["styles"] }))
      .toEqual(["ref", "selector", "include"]);
    expect(unknownKeysOf(toolMap.get("browser_click")!.inputSchema, { tabId: 1, ref: "e1", selector: "#a" })).toEqual(["ref", "selector"]);
  });

  it("nested objects are strict too", () => {
    const region = toolMap.get("browser_screenshot")!.inputSchema;
    expect(unknownKeysOf(region, { tabId: 1, region: { x: 0, y: 0, width: 10, height: 10, zoom: 2 } })).toEqual(["zoom"]);
    const emulate = toolMap.get("browser_emulate")!.inputSchema;
    expect(unknownKeysOf(emulate, { tabId: 1, viewport: { width: 800, height: 600, zoom: 2 } })).toEqual(["zoom"]);
    expect(unknownKeysOf(emulate, { tabId: 1, geolocation: { latitude: 1, longitude: 2, altitude: 3 } })).toEqual(["altitude"]);
    const mock = toolMap.get("browser_mock")!.inputSchema;
    expect(unknownKeysOf(mock, { tabId: 1, rules: [{ match: "*", mockStatus: 500 }] })).toEqual(["mockStatus"]);
    const batch = toolMap.get("browser_batch")!.inputSchema;
    expect(unknownKeysOf(batch, { actions: [{ tool: "browser_click", params: {}, continueOnError: true }] })).toEqual(["continueOnError"]);
  });

  it("a valid call still passes, nested objects included", () => {
    expect(toolMap.get("browser_screenshot")!.inputSchema.safeParse({ tabId: 1, region: { x: 0, y: 0, width: 10, height: 10 } }).success).toBe(true);
    expect(toolMap.get("browser_emulate")!.inputSchema.safeParse({ tabId: 1, viewport: { width: 800, height: 600 }, geolocation: null }).success).toBe(true);
    expect(toolMap.get("browser_mock")!.inputSchema.safeParse({ tabId: 1, rules: [{ match: "*", status: 500, body: "x", headers: { a: "b" } }] }).success).toBe(true);
  });

  it("refinements still run on the strict schemas (tabs needs tabId for close)", () => {
    const tabs = toolMap.get("browser_tabs")!.inputSchema;
    expect(tabs.safeParse({ action: "close" }).success).toBe(false);
    expect(tabs.safeParse({ action: "close", tabId: 2 }).success).toBe(true);
    expect(toolMap.get("browser_wait")!.inputSchema.safeParse({ tabId: 1 }).success).toBe(false);
  });

  it("hint names are never valid parameters of any 3.0 tool (a hint must not contradict a real key)", () => {
    for (const name of ["ref", "selector", "fullPage", "format", "quality", "scale", "maxWidth", "include", "doubleClick", "clickCount",
      "trusted", "direction", "amount", "toElement", "x", "y", "delay", "urlIncludes", "maxLength", "fullUrls", "bypassCache",
      "continueOnError", "captureBodies", "pattern", "urlPattern", "level", "failed", "mockStatus", "mockBody"]) {
      for (const tool of allTools) {
        expect(Object.keys(tool.inputSchema.shape), `${name} on ${tool.name}`).not.toContain(name);
      }
    }
  });
});

describe("browser_evaluate timeout", () => {
  const evaluate = toolMap.get("browser_evaluate")!;

  it("accepts 1000 ms to 30000 ms: the handler floors at 1000", () => {
    expect(evaluate.inputSchema.safeParse({ tabId: 1, expression: "1", timeout: 1000 }).success).toBe(true);
    expect(evaluate.inputSchema.safeParse({ tabId: 1, expression: "1", timeout: 30_000 }).success).toBe(true);
    expect(evaluate.inputSchema.safeParse({ tabId: 1, expression: "1", timeout: 999 }).success).toBe(false);
    expect(evaluate.inputSchema.safeParse({ tabId: 1, expression: "1", timeout: 30_001 }).success).toBe(false);
  });
});

describe("browser_type requires something to do", () => {
  const type = toolMap.get("browser_type")!;
  const ok = (input: Record<string, unknown>) => type.inputSchema.safeParse({ tabId: 1, ...input }).success;

  it("accepts text, key, clear or submit (any one of them)", () => {
    expect(ok({ text: "hi" })).toBe(true);
    expect(ok({ key: "Enter" })).toBe(true);
    expect(ok({ target: "#a", clear: true })).toBe(true);
    expect(ok({ submit: true })).toBe(true);
    expect(ok({ target: "#a", text: "hi", submit: true })).toBe(true);
  });

  it("rejects a call that would do nothing, as the handler does", () => {
    expect(ok({})).toBe(false);
    expect(ok({ target: "#a" })).toBe(false);
    expect(ok({ clear: false })).toBe(false);
    expect(ok({ submit: false })).toBe(false);
    expect(ok({ text: "" })).toBe(false);
  });
});

describe("unknownParameterHint (one hint map for every tool)", () => {
  it("gives the 3.0 replacement for a removed 2.x name", () => {
    expect(unknownParameterHint("ref")).toBe("use target with the ref from browser_snapshot");
    expect(unknownParameterHint("selector")).toContain("use target");
    expect(unknownParameterHint("fullPage")).toContain("viewport");
    expect(unknownParameterHint("doubleClick")).toContain("count");
  });

  it("has no hint for a name that is not a known 2.x name", () => {
    expect(unknownParameterHint("bogus")).toBeUndefined();
  });

  it("is safe for object prototype names", () => {
    expect(unknownParameterHint("constructor")).toBeUndefined();
    expect(unknownParameterHint("__proto__")).toBeUndefined();
  });
});

describe("codedMessageOf (the CODE: message text of a failure)", () => {
  it("keeps a message that already starts with CODE:", () => {
    expect(codedMessageOf(new Error("TAB_LOCKED: tab 3 belongs to another session"))).toBe("TAB_LOCKED: tab 3 belongs to another session");
    expect(codedMessageOf(new Error("INVALID_ARGUMENT: target is required"))).toBe("INVALID_ARGUMENT: target is required");
  });

  it("gives anything else INTERNAL_ERROR", () => {
    expect(codedMessageOf(new Error("boom"))).toBe("INTERNAL_ERROR: boom");
    expect(codedMessageOf(new Error("Invalid tool arguments for browser_click"))).toBe("INTERNAL_ERROR: Invalid tool arguments for browser_click");
    expect(codedMessageOf("plain string")).toBe("INTERNAL_ERROR: plain string");
  });
});
