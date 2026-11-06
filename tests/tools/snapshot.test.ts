import { describe, expect, it } from "vitest";
import { snapshotTool } from "../../mcp-server/src/tools/snapshot.js";
import type { ToolHost } from "../../mcp-server/src/tools/types.js";
import { VaultRedactionRegistry } from "../../mcp-server/src/vault/redaction.js";

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
    expect(keys.sort()).toEqual(["delta", "maxChars", "query", "since", "tabId", "target"]);
  });

  it("accepts an opt-in delta baseline and bounded revision", () => {
    expect(parse({ delta: true, since: "revision" }).success).toBe(true);
    expect(parse({ delta: "true" }).success).toBe(false);
    expect(parse({ since: "x".repeat(101) }).success).toBe(false);
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

  it("compares sanitized snapshots, so changes to redacted values do not leak through the delta kind", async () => {
    const registry = new VaultRedactionRegistry();
    const firstValue = 'fixture-private-alpha';
    const secondValue = 'fixture-private-bravo';
    registry.register('scope', firstValue, 'doc');
    registry.register('scope', secondValue, 'doc');
    let value = firstValue;
    const host: ToolHost = { callTool: async () => registry.sanitize('scope', {
      success: true, text: `${'visible line\n'.repeat(25)}${value}`, url: 'https://fixture.test/', snapshotEpoch: [1, 2, 3, 4, 5],
    }, { toolName: 'browser_snapshot' }) };
    const first = await snapshotTool.handler(host, { tabId: 1, delta: true });
    const firstText = (first.content[0] as { text: string }).text;
    const revision = JSON.parse(firstText.split('\n')[0]).revision;
    value = secondValue;
    const next = await snapshotTool.handler(host, { tabId: 1, delta: true, since: revision });
    const nextText = (next.content[0] as { text: string }).text;
    expect(JSON.parse(nextText)).toMatchObject({ kind: 'delta', deleteCount: 0, lines: [] });
    expect(firstText + nextText).not.toContain(firstValue);
    expect(firstText + nextText).not.toContain(secondValue);
  });

  it("builds protocol metadata after sanitization even when a secret matches a metadata word", async () => {
    const registry = new VaultRedactionRegistry();
    registry.register('scope', 'revision', 'doc');
    const host: ToolHost = { callTool: async () => registry.sanitize('scope', {
      success: true, text: 'Page content', url: 'https://fixture.test/', snapshotEpoch: [7, 8, 9, 10, 11],
    }, { toolName: 'browser_snapshot' }) };
    const first = await snapshotTool.handler(host, { tabId: 1, delta: true });
    const envelope = (first.content[0] as { text: string }).text;
    expect(JSON.parse(envelope.split('\n')[0])).toMatchObject({ kind: 'full', revision: expect.any(String) });
  });
});
