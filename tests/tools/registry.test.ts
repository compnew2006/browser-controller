import { describe, it, expect } from "vitest";
import {
  allTools,
  toolManifest,
  toolMap,
  isIdempotent,
  toolTimeoutMs,
} from "../../mcp-server/src/tools/index.js";

describe("Tool Registry", () => {
  // Browser Controller 3.0: the public tools, in tools/list order.
  const expectedTools = [
    'browser_navigate', 'browser_tabs', 'browser_snapshot', 'browser_text',
    'browser_screenshot', 'browser_click', 'browser_type', 'browser_fill',
    'browser_scroll', 'browser_wait', 'browser_evaluate', 'browser_handle_dialog',
    'browser_batch', 'browser_emulate', 'browser_logs', 'browser_mock',
    'browser_inspect_element', 'browser_safety', 'browser_vault', 'browser_memory',
  ];
  // Runs entirely in the MCP process (it calls other tools' handlers): no wire name.
  const localTools = new Set(['browser_batch', 'browser_safety']);

  it("registers the public tools, in contract order", () => {
    expect(allTools.map((t) => t.name)).toEqual(expectedTools);
  });

  it("all tools have unique names", () => {
    const names = allTools.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("all tools have description, inputSchema and a handler", () => {
    for (const tool of allTools) {
      expect(tool.description, tool.name).toBeTruthy();
      expect(tool.inputSchema, tool.name).toBeTruthy();
      expect(typeof tool.handler).toBe("function");
    }
  });

  it("every tool has a one-line summary of 10 to 79 characters", () => {
    for (const tool of allTools) {
      expect(tool.summary.length, `${tool.name} summary`).toBeGreaterThan(10);
      expect(tool.summary.length, `${tool.name} summary`).toBeLessThan(80);
    }
  });

  it("toolMap and the manifest cover every tool", () => {
    expect(toolMap.size).toBe(allTools.length);
    expect(toolManifest.map((t) => t.name)).toEqual(expectedTools);
    for (const entry of toolManifest) {
      const tool = toolMap.get(entry.name);
      expect(tool, `${entry.name} must exist in toolMap`).toBeTruthy();
      expect(entry.inputSchema).toMatchObject({ type: "object" });
      expect(entry.timeoutMs).toBe(tool?.timeoutMs);
      expect(entry.idempotent).toBe(tool?.idempotent === true);
      expect(["read", "write", "mixed"]).toContain(entry.capability);
    }
  });

  // --- Wire-name drift guard ------------------------------------------------
  // The tool's .name MUST equal the wire name it sends to bridge.callTool(),
  // otherwise the idempotency-retry lookup silently fails. forwardHandler and
  // the custom fill handler tag their closures with the wire name.
  describe("wire name == .name (no drift)", () => {
    for (const tool of allTools) {
      it(`${tool.name} sends its own wire name`, () => {
        if (localTools.has(tool.name)) return;
        const tagged = (tool.handler as { toolName?: string }).toolName;
        expect(tagged, `${tool.name} must be tagged with its wire name`).toBe(tool.name);
      });
    }
  });

  // --- Target grammar: compatible strings and structured role/name locators ---
  it("every element parameter accepts a string or structured target", () => {
    for (const tool of allTools) {
      const shape = tool.inputSchema.shape as Record<string, { safeParse: (v: unknown) => { success: boolean } }>;
      if (!("target" in shape)) continue;
      expect(shape.target!.safeParse("e12").success, `${tool.name} accepts a string target`).toBe(true);
      expect(shape.target!.safeParse({ role: "button", name: "Sign in" }).success, `${tool.name} accepts a structured target`).toBe(true);
      expect(shape.target!.safeParse(12).success, `${tool.name} rejects a number target`).toBe(false);
    }
    // click, type, scroll, wait, text, snapshot, screenshot, inspect and fill all name elements by target.
    for (const name of ["browser_click", "browser_type", "browser_scroll", "browser_wait", "browser_text",
      "browser_snapshot", "browser_screenshot", "browser_inspect_element"]) {
      expect(toolMap.get(name)!.inputSchema.shape, name).toHaveProperty("target");
    }
    const fieldSchema = (toolMap.get("browser_fill")!.inputSchema.shape.fields as unknown as { element: { shape: Record<string, { safeParse: (v: unknown) => { success: boolean } }> } }).element;
    expect(fieldSchema.shape.target!.safeParse("text=Sign in").success).toBe(true);
    expect(fieldSchema.shape.target!.safeParse({ role: "textbox", name: "Email" }).success).toBe(true);
    expect(fieldSchema.shape.target!.safeParse(3).success).toBe(false);
  });

  // Tool definitions are re-sent every turn: no ±2^53 bounds from unbounded
  // .int() (tabId alone cost ~850 tokens across tools), validation kept.
  it('tabId stays integer-only without publishing safe-integer bounds', () => {
    const click = toolMap.get('browser_click')!;
    expect(click.inputSchema.safeParse({ tabId: 1.5, target: 'a' }).success).toBe(false);
    expect(click.inputSchema.safeParse({ tabId: 15, target: 'a' }).success).toBe(true);
    expect(JSON.stringify(toolManifest.map((t) => t.inputSchema))).not.toContain('9007199254740991');
  });

  it('browser_vault accepts opaque handles only and rejects secret-bearing fields', () => {
    const vault = toolMap.get('browser_vault')!;
    expect(vault.inputSchema.safeParse({ action: 'fill', tabId: 1, handle: 'cred_0123456789abcdef0123456789abcdef' }).success).toBe(true);
    expect(vault.inputSchema.safeParse({ action: 'save_login', tabId: 1, password: 'fixture-only-secret' }).success).toBe(false);
    expect(vault.inputSchema.safeParse({ action: 'fill', tabId: 1, handle: 'x', identifier: 'user' }).success).toBe(false);
    expect(vault.inputSchema.safeParse({ action: 'grant', tabId: 1, grantId: 'x' }).success).toBe(false);
    expect(vault.inputSchema.safeParse({ action: 'save_login' }).success).toBe(false);
  });

  // --- Idempotency classification -------------------------------------------
  describe('idempotency classification', () => {
    it('marks the read tools as idempotent', () => {
      for (const name of ['browser_snapshot', 'browser_text', 'browser_screenshot', 'browser_inspect_element']) {
        expect(isIdempotent(name), name).toBe(true);
      }
    });
    it('marks actions, navigation, scripts and log reads that can clear as NON-idempotent', () => {
      for (const name of [
        'browser_navigate', 'browser_tabs', 'browser_click', 'browser_type', 'browser_fill', 'browser_scroll',
        'browser_wait', 'browser_evaluate', 'browser_handle_dialog', 'browser_emulate', 'browser_logs',
        'browser_mock', 'browser_batch',
      ]) {
        expect(isIdempotent(name), `${name} must not be retried`).toBe(false);
      }
    });
  });

  // --- timeoutMs guard --------------------------------------------------------
  // Every tool MUST declare a positive numeric timeoutMs; the lookup helper must agree.
  it("every tool declares a positive numeric timeoutMs", () => {
    for (const tool of allTools) {
      expect(typeof tool.timeoutMs, `${tool.name} must declare timeoutMs`).toBe("number");
      expect(tool.timeoutMs!, `${tool.name} timeoutMs must be > 0`).toBeGreaterThan(0);
      expect(toolTimeoutMs(tool.name)).toBe(tool.timeoutMs);
    }
  });

  it("each timeout covers its handler's own cap", () => {
    expect(toolTimeoutMs("browser_wait")).toBeGreaterThanOrEqual(55_000); // wait: up to 50 s
    expect(toolTimeoutMs("browser_evaluate")).toBeGreaterThanOrEqual(35_000); // evaluate: up to 30 s
    expect(toolTimeoutMs("browser_navigate")).toBeGreaterThanOrEqual(20_000); // navigate: 15 s load wait
    expect(toolTimeoutMs("browser_batch")).toBe(50_000); // batch = its budget
  });
});
