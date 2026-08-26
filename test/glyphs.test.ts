import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const FORBIDDEN_RANGES: Array<[number, number, string]> = [
  [0x2190, 0x21ff, "arrows"],
  [0x2300, 0x23ff, "misc technical"],
  [0x2500, 0x25ff, "box drawing + geometric shapes"],
  [0x2600, 0x27bf, "misc symbols + dingbats"],
  [0x2800, 0x28ff, "braille"],
  [0x1f300, 0x1faff, "emoji"]
];

const ALLOWED_NON_ASCII = new Set(["·", "—", "…"]);

function* walkTs(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* walkTs(full);
    else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) yield full;
  }
}

function uiSourceFiles(): string[] {
  const roots = ["src/ui", "src/commands", "src/cli"];
  const files: string[] = [];
  for (const root of roots) {
    try {
      files.push(...walkTs(root));
    } catch {
    }
  }
  return files.filter((file) => !file.includes("i18n"));
}

describe("terminal glyph safety", () => {
  it("keeps every UI source file free of glyphs missing from cmd.exe raster fonts", () => {
    const offenders: string[] = [];

    for (const file of uiSourceFiles()) {
      const src = readFileSync(file, "utf8");
      for (const [index, char] of [...src].entries()) {
        const code = char.codePointAt(0);
        if (code === undefined) continue;
        if (code < 0x80) continue;
        if (ALLOWED_NON_ASCII.has(char)) continue;
        if (code >= 0x0400 && code <= 0x04ff) continue;

        for (const [from, to, family] of FORBIDDEN_RANGES) {
          if (code >= from && code <= to) {
            const line = src.slice(0, index).split("\n").length;
            offenders.push(`${file}:${line} U+${code.toString(16)} (${family}) "${char}"`);
            break;
          }
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it("uses only ASCII frames for the spinner", () => {
    const src = readFileSync("src/ui/pi/transcript-component.ts", "utf8");
    const match = /const SPIN = \[([^\]]+)\]/.exec(src);
    expect(match).not.toBeNull();
    for (const char of match?.[1] ?? "") {
      expect(char.charCodeAt(0)).toBeLessThan(0x80);
    }
    expect(match?.[1]).toContain("|");
    expect(match?.[1]).toContain("/");
  });

  it("renders the context meter with plain ASCII blocks", () => {
    const src = readFileSync("src/ui/pi/status-component.ts", "utf8");
    expect(src).toContain('"#"');
    expect(src).toContain('"."');
    expect(src).not.toMatch(/[█░▐▌]/);
  });

  it("keeps the logo text-only", () => {
    const src = readFileSync("src/ui/pi/logo-component.ts", "utf8");
    expect(src).not.toMatch(/[◆█╔═╗╱╲]/);
    expect(src).toContain("axiom");
  });

  it("does not depend on react or ink anymore", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const all = { ...pkg.dependencies, ...pkg.devDependencies };
    expect(all["ink"]).toBeUndefined();
    expect(all["react"]).toBeUndefined();
    expect(all["@types/react"]).toBeUndefined();
  });
});
