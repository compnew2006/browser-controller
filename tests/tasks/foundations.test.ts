import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(import.meta.dirname, "..", "..");

describe("foundations (spec 011)", () => {
  it("test_product_md_declares_operate_mode", () => {
    const product = readFileSync(join(repoRoot, "PRODUCT.md"), "utf8");
    // The popup works in Operate mode: the user completes a task, so
    // scan clarity and consistency matter more than expression.
    expect(product).toMatch(/Operate/);
    // The current identity is preserved: dark, neutral zinc + indigo accent.
    expect(product).toMatch(/zinc/i);
    expect(product).toMatch(/indigo/i);
  });
});
