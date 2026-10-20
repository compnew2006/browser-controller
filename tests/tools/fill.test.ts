import { describe, expect, it } from "vitest";
import { writeFileSync, mkdtempSync, mkdirSync, symlinkSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { fillTool } from "../../mcp-server/src/tools/fill.js";
import type { ToolHost } from "../../mcp-server/src/tools/types.js";

/** Records what reaches the extension; answers every call with a plain success. */
function recordingHost() {
  const sent: Array<{ tool: string; params: Record<string, unknown> }> = [];
  const host: ToolHost = {
    async callTool(tool, params) {
      sent.push({ tool, params });
      return { success: true, text: "ok (2 fields)" };
    },
  };
  return { host, sent };
}

const textOf = (res: { content: Array<{ type: string; text?: string }> }) =>
  (res.content.find((c) => c.type === "text") as { text: string }).text;

describe("browser_fill: file inputs are checked before anything is sent", () => {
  const dir = mkdtempSync(join(tmpdir(), "bc-fill-"));
  const real = join(dir, "resume.pdf");
  writeFileSync(real, "x");

  it("forwards a list of readable absolute paths untouched", async () => {
    const { host, sent } = recordingHost();
    const res = await fillTool.handler(host, {
      tabId: 3,
      fields: [{ target: "e4", value: [real] }, { target: "e5", value: "Ada" }],
    });
    expect(res.isError).toBeUndefined();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.params.fields).toEqual([{ target: "e4", value: [real] }, { target: "e5", value: "Ada" }]);
  });

  it("forwards a missing path flagged by name only: the extension refuses a file input, nothing else", async () => {
    const { host, sent } = recordingHost();
    const res = await fillTool.handler(host, {
      tabId: 3,
      fields: [{ target: "e4", value: [join(dir, "missing-cv.pdf")] }, { target: "e5", value: "Ada" }],
    });
    expect(res.isError).toBeUndefined();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.params.fields).toEqual([
      { target: "e4", value: [join(dir, "missing-cv.pdf")], missingFiles: ["missing-cv.pdf"] },
      { target: "e5", value: "Ada" },
    ]);
  });

  it("flags a directory as not a file (by name)", async () => {
    const { host, sent } = recordingHost();
    await fillTool.handler(host, { tabId: 3, fields: [{ target: "e4", value: [dir] }] });
    expect(sent[0]!.params.fields).toEqual([{ target: "e4", value: [dir], missingFiles: [dir.split("/").pop()] }]);
  });

  it("expands ~/ to the home directory before checking and forwarding", async () => {
    const { host, sent } = recordingHost();
    await fillTool.handler(host, { tabId: 3, fields: [{ target: "e4", value: ["~/__bc_no_such_file__.pdf"] }] });
    expect(sent[0]!.params.fields).toEqual([
      { target: "e4", value: [join(homedir(), "__bc_no_such_file__.pdf")], missingFiles: ["__bc_no_such_file__.pdf"] },
    ]);
  });

  it("a select whose option values look like paths is forwarded with its values untouched (not refused)", async () => {
    const { host, sent } = recordingHost();
    const res = await fillTool.handler(host, { tabId: 3, fields: [{ target: "select#lang", value: ["/en", "/fr"] }] });
    expect(res.isError).toBeUndefined();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.params.fields).toEqual([{ target: "select#lang", value: ["/en", "/fr"], missingFiles: ["en", "fr"] }]);
  });

  it("refuses hidden and credential files before anything is sent: FILE_NOT_ALLOWED names the file only", async () => {
    const { host, sent } = recordingHost();
    const home = join(dir, "home");
    mkdirSync(join(home, ".ssh"), { recursive: true });
    writeFileSync(join(home, ".ssh", "id_rsa"), "secret");
    symlinkSync(join(home, ".ssh", "id_rsa"), join(dir, "link.pdf"));
    mkdirSync(join(dir, ".zcode", "proj"), { recursive: true });
    writeFileSync(join(dir, ".zcode", "proj", "resume.pdf"), "x");
    const cases: Array<[string, string]> = [
      [join(dir, ".env"), ".env"],
      [join(homedir(), ".aws", "credentials"), "credentials"],
      [join(dir, "link.pdf"), "link.pdf"],
      ["C:/Users/ada/.ssh/id_rsa", "id_rsa"],
    ];
    for (const [path, name] of cases) {
      const res = await fillTool.handler(host, { tabId: 3, fields: [{ target: "e4", value: [path] }] });
      expect(res.isError).toBe(true);
      expect(textOf(res)).toBe(`FILE_NOT_ALLOWED: ${name} is a hidden or credential file; upload only files the user chose.`);
    }
    expect(sent).toHaveLength(0);
    // A refused file in a call with other fields refuses the whole call.
    await fillTool.handler(host, { tabId: 3, fields: [{ target: "e5", value: "Ada" }, { target: "e4", value: [join(dir, ".env")] }] });
    expect(sent).toHaveLength(0);
  });

  it("a relative path into a credential folder is refused before anything is sent (no leading slash needed)", async () => {
    const { host, sent } = recordingHost();
    const res = await fillTool.handler(host, { tabId: 3, fields: [{ target: "input[type=file]", value: ["../.ssh/id_rsa"] }] });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toBe("FILE_NOT_ALLOWED: id_rsa is a hidden or credential file; upload only files the user chose.");
    expect(sent).toHaveLength(0);
  });

  it("a credential path in a mixed list is refused as a whole, bare names and absolute items notwithstanding", async () => {
    const { host, sent } = recordingHost();
    const res = await fillTool.handler(host, { tabId: 3, fields: [{ target: "e4", value: ["Ada", "../.ssh/id_rsa"] }] });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/^FILE_NOT_ALLOWED: id_rsa /);
    expect(sent).toHaveLength(0);
  });

  it("a relative path that is not a credential is forwarded as typed: the extension refuses it for a file input", async () => {
    const { host, sent } = recordingHost();
    const res = await fillTool.handler(host, { tabId: 3, fields: [{ target: "e4", value: ["docs/resume.pdf"] }] });
    expect(res.isError).toBeUndefined();
    expect(sent[0]!.params.fields).toEqual([{ target: "e4", value: ["docs/resume.pdf"] }]);
  });

  it("a real file under a hidden project folder is allowed: only the list and dotfile names are refused", async () => {
    const { host, sent } = recordingHost();
    const res = await fillTool.handler(host, { tabId: 3, fields: [{ target: "e4", value: [join(dir, ".zcode", "proj", "resume.pdf")] }] });
    expect(res.isError).toBeUndefined();
    expect(sent).toHaveLength(1);
  });

  it("does not check plain string or select values", async () => {
    const { host, sent } = recordingHost();
    const res = await fillTool.handler(host, {
      tabId: 3,
      fields: [{ target: "e6", value: ["red", "blue"] }, { target: "e7", value: true }],
    });
    expect(res.isError).toBeUndefined();
    expect(sent).toHaveLength(1);
  });

  it("a dot-led select value without a separator is forwarded as typed (not a FILE_NOT_ALLOWED)", async () => {
    const { host, sent } = recordingHost();
    const res = await fillTool.handler(host, { tabId: 3, fields: [{ target: "e6", value: [".net", "go"] }] });
    expect(res.isError).toBeUndefined();
    expect(sent[0]!.params.fields).toEqual([{ target: "e6", value: [".net", "go"] }]);
  });

  it("validates the field list: 1 to 50 fields, string / number / boolean / string[] values", () => {
    expect(fillTool.inputSchema.safeParse({ tabId: 1, fields: [] }).success).toBe(false);
    expect(fillTool.inputSchema.safeParse({ tabId: 1, fields: Array(51).fill({ target: "e1", value: "x" }) }).success).toBe(false);
    expect(fillTool.inputSchema.safeParse({ tabId: 1, fields: [{ target: "e1", value: null }] }).success).toBe(false);
    expect(fillTool.inputSchema.safeParse({ tabId: 1, fields: [{ target: "e1", value: Number.NaN }] }).success).toBe(false);
    expect(fillTool.inputSchema.safeParse({ tabId: 1, fields: [{ target: "e1", value: 3 }] }).success).toBe(true);
    expect(fillTool.inputSchema.safeParse({ tabId: 1, fields: [{ target: "e1", value: "x" }] }).success).toBe(true);
  });

  it("a number value (a range, a count) reaches the extension as its string", async () => {
    const { host, sent } = recordingHost();
    const res = await fillTool.handler(host, { tabId: 3, fields: [{ target: "#vol", value: 42 }, { target: "#step", value: 2.5 }, { target: "#n", value: 0 }] });
    expect(res.isError).toBeUndefined();
    expect(sent[0]!.params.fields).toEqual([{ target: "#vol", value: "42" }, { target: "#step", value: "2.5" }, { target: "#n", value: "0" }]);
  });
});
