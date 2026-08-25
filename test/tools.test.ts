import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readTool } from "../src/tools/read.js";
import { writeTool } from "../src/tools/write.js";
import { editTool } from "../src/tools/edit.js";
import { globTool } from "../src/tools/glob.js";
import { grepTool } from "../src/tools/grep.js";
import { lsTool } from "../src/tools/ls.js";
import { patchTool } from "../src/tools/patch.js";
import type { ToolContext, ToolDefinition } from "../src/types.js";

let projectRoot: string;

beforeEach(async () => {
  projectRoot = await mkdtemp(join(tmpdir(), "axiom-tools-"));
});

afterEach(async () => {
  await rm(projectRoot, { recursive: true, force: true });
});

function makeContext(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    cwd: projectRoot,
    sessionId: "ses_test",
    mode: "bypass",
    abortSignal: new AbortController().signal,
    requestPermission: async () => "allow_once",
    reportProgress: () => undefined,
    snapshotFiles: () => undefined,
    spawnSubagent: async () => "(stub)",
    getTodoList: () => [],
    setTodoList: () => undefined,
    ...overrides
  };
}

async function run(tool: ToolDefinition, input: Record<string, unknown>, context = makeContext()) {
  const need = tool.needsPermission(input, context.mode);
  if (need.required) await context.requestPermission({ tool: tool.name, title: need.title ?? "", summary: [], risk: need.risk });
  return tool.execute(input, context, "call_1");
}

describe("write + read tools", async () => {
  it("creates nested files and reads them back with numbering", async () => {
    const created = await run(writeTool, { file_path: "deep/nested/app.ts", content: "const a = 1;\nconst b = 2;\n" });
    expect(created.isError).toBe(false);

    const readBack = await run(readTool, { file_path: "deep/nested/app.ts" });
    expect(readBack.content).toContain("1 | const a = 1;");
    expect(readBack.content).toContain("2 | const b = 2;");
  });

  it("reports diff stats when overwriting", async () => {
    await run(writeTool, { file_path: "notes.md", content: "one\ntwo\nthree\n" });
    const updated = await run(writeTool, { file_path: "notes.md", content: "one\nTWO!\nthree\nfour\n" });

    expect(updated.isError).toBe(false);
    expect(updated.metadata?.["additions"]).toBeGreaterThanOrEqual(2);
    expect(updated.content).toContain("+2/-");
  });

  it("rejects paths escaping the project root", async () => {
    const result = await run(readTool, { file_path: "..\\outside.txt" }).catch((error) => error);
    const escaped = result instanceof Error ? result.message : (result as { content?: string }).content ?? "";
    expect(String(escaped)).toMatch(/escapes the project root|not found|File not found/);
  });

  it("refuses writing image extensions as text", async () => {
    const result = await run(writeTool, { file_path: "logo.png", content: "<svg/>" });
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/image/i);
  });
});

describe("edit tool", async () => {
  beforeEach(async () => {
    await writeFile(join(projectRoot, "code.py"), "def run():\n    pass\n\ndef run():\n    pass\n");
  });

  it("fails on ambiguous old_string without replace_all", async () => {
    const result = await run(editTool, {
      file_path: "code.py",
      old_string: "def run():",
      new_string: "def main():"
    });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("2 locations");
  });

  it("replaces all occurrences with replace_all", async () => {
    const result = await run(editTool, {
      file_path: "code.py",
      old_string: "def run():",
      new_string: "def main():",
      replace_all: true
    });
    expect(result.isError).toBe(false);
    expect(result.metadata?.["appliedCount"]).toBe(2);
  });

  it("suggests nearest line when the needle is missing", async () => {
    const result = await run(editTool, {
      file_path: "code.py",
      old_string: "def rn():",
      new_string: "x"
    });
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/closest match|not found/);
  });

  it("supports batch edits array", async () => {
    const result = await run(editTool, {
      file_path: "code.py",
      old_string: "pass",
      new_string: "return None",
      replace_all: true,
      edits: [{ old_string: "run", new_string: "runner", replace_all: false }]
    });
    expect(result.content).toContain("2 replacement(s)");
  });
});

describe("glob + grep tools", async () => {
  beforeEach(async () => {
    await mkdir(join(projectRoot, "src"), { recursive: true });
    await mkdir(join(projectRoot, "node_modules/pkg"), { recursive: true });
    await writeFile(join(projectRoot, "src/a.ts"), "export const A = 'needle';\nexport const B = 1;\n");
    await writeFile(join(projectRoot, "src/b.ts"), "const needleCount = 2;\n// needle again\n");
    await writeFile(join(projectRoot, "README.md"), "# readme needle\n");
    await writeFile(join(projectRoot, "node_modules/pkg/x.js"), "needle inside dependency\n");
  });

  it("finds files by pattern while ignoring node_modules", async () => {
    const result = await run(globTool, { pattern: "**/*.ts" });
    expect(result.content.split("\n")).toHaveLength(2);
    expect(result.content).toContain("src/a.ts");
  });

  it("greps content across files with counts", async () => {
    const result = await run(grepTool, { pattern: "needle", output_mode: "count" });
    expect(result.isError).toBe(false);
    expect(result.content).toContain("total:");
    expect(result.content).not.toContain("node_modules");
  });

  it("returns matching lines with context in content mode", async () => {
    const result = await run(grepTool, { pattern: "needleCount", include: "*.ts" });
    expect(result.content).toContain("needleCount");
    expect(result.content).toContain("src/b.ts");
  });

  it("handles fixed strings with regex metacharacters", async () => {
    const result = await run(grepTool, { pattern: "A = 'needle';", fixed_strings: true });
    expect(result.isError).toBe(false);
    expect(result.content).toContain("a.ts");
  });
});

describe("ls + patch tools", async () => {
  it("lists directories with sizes and DIR markers", async () => {
    await mkdir(join(projectRoot, "sub"));
    await writeFile(join(projectRoot, "sub/file.txt"), "content");

    const result = await run(lsTool, { path: ".", depth: 1 });
    expect(result.content).toContain("DIR  sub/");
    expect(result.content).toContain("sub/file.txt");
  });

  it("applies unified patches with dry-run support", async () => {
    await writeFile(join(projectRoot, "cfg.json"), '{"a": 1,\n "b": 2}\n');

    const patchText = [
      "--- a/cfg.json",
      "+++ b/cfg.json",
      "@@ -1,2 +1,3 @@",
      ' {"a": 1,',
      '- "b": 2}',
      '+ "b": 2,',
      '+ "c": 3}',
      "+"
    ].join("\n");

    const dry = await run(patchTool, { file_path: "cfg.json", diff: patchText, dry_run: true });
    expect(dry.content).toContain("dry run");

    const applied = await run(patchTool, { file_path: "cfg.json", diff: patchText });
    expect(applied.isError).toBe(false);
    expect(applied.content).toContain("Written.");
  });
});
