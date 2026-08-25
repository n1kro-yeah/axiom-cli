import { describe, expect, it } from "vitest";
import { AXIOM_BANNER } from "../src/ui/theme.js";

describe("AXIOM banner", () => {
  const lines = AXIOM_BANNER.split("\n");

  it("has exactly four rows", () => {
    expect(lines).toHaveLength(4);
  });

  it("aligns every row to the same width", () => {
    const widths = lines.map((line) => line.length);
    expect(new Set(widths).size).toBe(1);
  });

  it("uses plain ASCII only so cmd.exe raster fonts render it", () => {
    for (const line of lines) {
      for (const char of line) {
        expect(char.charCodeAt(0)).toBeLessThan(128);
      }
    }
  });

  it("spells AXIOM left to right without merged glyph columns", () => {
    expect(lines[0]).toContain("_");
    expect(lines[3]).toContain("/_/");
    expect(lines[1]).toContain("\\ \\/ /");
    expect(lines[3]).toContain("|___|");
  });
});
