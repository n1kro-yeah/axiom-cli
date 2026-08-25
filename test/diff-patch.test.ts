import { describe, expect, it } from "vitest";
import {
  computeLineDiff,
  diffStats,
  buildHunks,
  renderUnifiedDiff,
  splitLines
} from "../src/util/diff.js";
import {
  applyExactEdits,
  applyUnifiedPatch,
  countOccurrences,
  parseUnifiedPatch
} from "../src/util/patch.js";

describe("computeLineDiff", () => {
  it("detects pure insertion", () => {
    const entries = computeLineDiff("a\nb\nc", "a\nX\nb\nc");
    expect(diffStats(entries)).toEqual({ additions: 1, deletions: 0, unchanged: 3 });
    expect(entries.find((entry) => entry.op === "insert")?.line).toBe("X");
  });

  it("detects pure deletion", () => {
    const entries = computeLineDiff("a\nb\nc", "a\nc");
    expect(diffStats(entries)).toEqual({ additions: 0, deletions: 1, unchanged: 2 });
    expect(entries.find((entry) => entry.op === "delete")?.line).toBe("b");
  });

  it("handles complete replacement", () => {
    const stats = diffStats(computeLineDiff("x\ny", "1\n2\n3"));
    expect(stats.additions).toBe(3);
    expect(stats.deletions).toBe(2);
  });

  it("returns no changes for identical input", () => {
    expect(computeLineDiff("same\ntext", "same\ntext")).toHaveLength(2);
  });

  it("normalizes CRLF input", () => {
    expect(splitLines("a\r\nb\r\n")).toEqual(["a", "b"]);
  });
});

describe("buildHunks and renderUnifiedDiff", () => {
  const before = ["l1", "l2", "l3", "l4", "l5", "l6", "l7"].join("\n");
  const after = ["l1", "l2", "L3", "l4", "l5", "l6", "l7!"].join("\n");

  it("produces hunks with context", () => {
    const hunks = buildHunks(computeLineDiff(before, after), 1);
    expect(hunks.length).toBeGreaterThanOrEqual(1);
    const flat = hunks.flatMap((hunk) => hunk.lines);
    expect(flat.some((line) => line.tag === "-" && line.text === "l3")).toBe(true);
    expect(flat.some((line) => line.tag === "+" && line.text === "L3")).toBe(true);
  });

  it("renders a valid unified header", () => {
    const text = renderUnifiedDiff(before, after, { filePath: "src/x.ts" });
    expect(text.startsWith("--- a/src/x.ts\n+++ b/src/x.ts")).toBe(true);
    expect(text).toContain("@@");
  });

  it("returns empty string when there are no changes", () => {
    expect(renderUnifiedDiff("a", "a")).toBe("");
  });
});

describe("parseUnifiedPatch + applyUnifiedPatch", () => {
  const original = ["alpha", "beta", "gamma", "delta"].join("\n");
  const patchText = [
    "--- a/f.txt",
    "+++ b/f.txt",
    "@@ -1,4 +1,4 @@",
    " alpha",
    "-beta",
    "+BETA",
    " gamma",
    " delta"
  ].join("\n");

  it("parses headers and hunk bodies", () => {
    const parsed = parseUnifiedPatch(patchText);
    expect(parsed.filePath).toBe("f.txt");
    expect(parsed.hunks).toHaveLength(1);
    expect(parsed.hunks[0].lines).toHaveLength(5);
    expect(parsed.isNewFile).toBe(false);
  });

  it("applies cleanly with exact context", () => {
    const parsed = parseUnifiedPatch(patchText);
    const outcome = applyUnifiedPatch(original, parsed.hunks);
    expect(outcome.success).toBe(true);
    expect(outcome.newText).toContain("BETA");
    expect(outcome.newText).not.toContain("-beta");
  });

  it("locates shifted hunks with fuzz", () => {
    const shiftedOriginal = ["prefix", "alpha", "beta", "gamma", "delta"].join("\n");
    const parsed = parseUnifiedPatch(patchText);
    const outcome = applyUnifiedPatch(shiftedOriginal, parsed.hunks);
    expect(outcome.appliedHunks).toEqual([0]);
    expect(outcome.notes.some((note) => note.includes("fuzz"))).toBe(true);
    expect(outcome.newText).toContain("BETA");
  });

  it("rejects impossible hunks and reports them", () => {
    const parsed = parseUnifiedPatch(patchText.replace(/alpha|beta|gamma|delta/g, "missing-line"));
    const outcome = applyUnifiedPatch(original, parsed.hunks, 0);
    expect(outcome.success).toBe(false);
    expect(outcome.rejectedHunks).toEqual([0]);
    expect(outcome.appliedHunks).toHaveLength(0);
  });

  it("supports multi-hunk patches in order", () => {
    const big = Array.from({ length: 30 }, (_, i) => `line-${i}`).join("\n");
    const multiPatch = [
      "@@ -2,3 +2,3 @@",
      " line-1",
      "-line-2",
      "+LINE-2",
      " line-3",
      "@@ -20,3 +20,3 @@",
      " line-19",
      "-line-20",
      "+LINE-20",
      " line-21"
    ].join("\n");
    const parsed = parseUnifiedPatch(multiPatch);
    expect(parsed.hunks).toHaveLength(2);
    const outcome = applyUnifiedPatch(big, parsed.hunks);
    expect(outcome.appliedHunks.sort()).toEqual([0, 1]);
    expect(outcome.newText).toContain("LINE-2");
    expect(outcome.newText).toContain("LINE-20");
  });
});

describe("applyExactEdits", () => {
  const source = "function add(a, b) {\n  return a + b;\n}\n";

  it("replaces a unique match", () => {
    const result = applyExactEdits(source, [{ oldText: "add", newText: "sum" }]);
    expect(result.result).toContain("function sum(a, b)");
    expect(result.applied).toBe(1);
  });

  it("respects replace_all semantics", () => {
    const repeated = "x y x y x";
    const single = applyExactEdits(repeated, [{ oldText: "x", newText: "z" }]);
    expect(single.applied).toBe(1);
    expect(countOccurrences(single.result, "z")).toBe(1);

    const every = applyExactEdits(repeated, [{ oldText: "x", newText: "z", replaceAll: true }]);
    expect(every.applied).toBe(3);
    expect(every.result).toBe("z y z y z");
  });

  it("skips missing needles without failing others", () => {
    const result = applyExactEdits(source, [
      { oldText: "does-not-exist", newText: "?" },
      { oldText: "return a + b;", newText: "return Number(a) + Number(b);" }
    ]);
    expect(result.applied).toBe(1);
    expect(result.result).toContain("Number(a)");
  });
});
