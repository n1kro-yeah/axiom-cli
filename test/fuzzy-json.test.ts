import { describe, expect, it } from "vitest";
import { fuzzyMatch, rankByFuzzy, matchGlobPath, globToRegExp, commonPrefix } from "../src/util/fuzzy.js";
import { parsePartialJson, salvageTopLevelFields } from "../src/util/json.js";

describe("fuzzyMatch", () => {
  it("matches subsequence with positions", () => {
    const result = fuzzyMatch("usr", "src/utils/user.ts");
    expect(result).not.toBeNull();
    expect(result?.positions.length).toBe(3);
  });

  it("rewards word boundaries and consecutive runs", () => {
    const boundary = fuzzyMatch("us", "user.ts");
    const scattered = fuzzyMatch("us", "asum.ts");
    expect(boundary!.score).toBeGreaterThan(scattered!.score);
  });

  it("returns null when the pattern cannot fit", () => {
    expect(fuzzyMatch("zzzqqq", "user.ts")).toBeNull();
  });

  it("is case-insensitive on matching but case-aware for scoring", () => {
    expect(fuzzyMatch("US", "userSettings.ts")).not.toBeNull();
    const camel = fuzzyMatch("uS", "userSettings");
    expect(camel).not.toBeNull();
  });
});

describe("rankByFuzzy", () => {
  const files = ["src/index.ts", "src/utils/date.ts", "test/index.test.ts", "package.json"];

  it("puts exact prefix matches first", () => {
    const ranked = rankByFuzzy(files, "src/inde", (file) => file, 10);
    expect(ranked[0]?.item).toBe("src/index.ts");
  });

  it("falls back to segment matches with reduced score", () => {
    const ranked = rankByFuzzy(files, "date", (file) => file, 10);
    expect(ranked.map((entry) => entry.item)).toContain("src/utils/date.ts");
  });

  it("limits output size", () => {
    expect(rankByFuzzy(files, "", (file) => file, 2)).toHaveLength(2);
  });
});

describe("glob matching", () => {
  it("handles star, doublestar and question marks", () => {
    expect(matchGlobPath("src/a/b/c.ts", "**/*.ts")).toBe(true);
    expect(matchGlobPath("a.txt", "*.txt")).toBe(true);
    expect(matchGlobPath("dir/a.txt", "*.txt")).toBe(true);
    expect(matchGlobPath("ab", "a?")).toBe(true);
    expect(matchGlobPath("abc", "a?")).toBe(false);
  });

  it("supports brace expansion", () => {
    expect(matchGlobPath("file.ts", "*.{ts,tsx}")).toBe(true);
    expect(matchGlobPath("file.tsx", "*.{ts,tsx}")).toBe(true);
    expect(matchGlobPath("file.js", "*.{ts,tsx}")).toBe(false);
  });

  it("supports character classes and negation-free brackets", () => {
    expect(matchGlobPath("b1", "[abc]1")).toBe(true);
    expect(matchGlobPath("d1", "[abc]1")).toBe(false);
  });

  it("normalizes windows separators", () => {
    expect(matchGlobPath("src\\util\\x.ts", "src/util/*.ts")).toBe(true);
  });

  it("compiles a regex that anchors fully via globToRegExp", () => {
    const regex = globToRegExp("*.spec.ts");
    expect(regex.test("app.spec.ts")).toBe(true);
    expect(regex.test("nested/app.spec.ts")).toBe(false);
  });
});

describe("commonPrefix", () => {
  it("finds shared prefix across values", () => {
    expect(commonPrefix(["src/a.ts", "src/b.ts", "src/c/x.ts"])).toBe("src/");
  });

  it("returns empty for empty arrays or divergent values", () => {
    expect(commonPrefix([])).toBe("");
    expect(commonPrefix(["a", "b"])).toBe("");
  });
});

describe("parsePartialJson", () => {
  it("parses complete JSON directly", () => {
    const result = parsePartialJson('{"name": "axiom", "n": 2}');
    expect(result.complete).toBe(true);
    if (result.complete) {
      expect((result.value as { name: string }).name).toBe("axiom");
    }
  });

  it("repairs an unterminated string value", () => {
    const result = parsePartialJson('{"command": "npm run bui');
    expect(result.value).toEqual({ command: "npm run bui" });
  });

  it("repairs unclosed nested objects", () => {
    const result = parsePartialJson('{"outer": {"inner": [1, 2');
    expect(result.complete).toBe(false);
    expect(result.missingClosers.length).toBeGreaterThanOrEqual(2);
  });

  it("drops dangling keys without values", () => {
    const result = parsePartialJson('{"a": 1, "b":');
    expect(result.value).toEqual({ a: 1 });
  });

  it("salvages complete top-level fields from hopeless input", () => {
    const salvaged = salvageTopLevelFields('{"keep": "yes", "broken": {"x": [1,');
    expect(salvaged["keep"]).toBe("yes");
  });

  it("tolerates escaped quotes mid-string", () => {
    const result = parsePartialJson('{"s": "a\\"b"}');
    expect(result.complete).toBe(true);
  });

  it("returns undefined-ish value for empty input", () => {
    const result = parsePartialJson("");
    expect(result.complete).toBe(false);
  });
});
