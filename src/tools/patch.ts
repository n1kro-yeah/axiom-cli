import { readFile, stat, writeFile } from "node:fs/promises";
import type { ToolDefinition, ToolInvocationResult, ToolContext } from "../types.js";
import { AxiomError } from "../util/errors.js";
import { resolveWithinRoot } from "./common.js";
import { applyUnifiedPatch, parseUnifiedPatch } from "../util/patch.js";
import { renderUnifiedDiff } from "../util/diff.js";
import { guardBinaryFile } from "./common.js";

export const patchTool: ToolDefinition = {
  name: "patch",
  label: "Patch",
  description:
    "Apply a unified diff to a file. The patch must use standard unified format with @@ hunks. Small context mismatches are tolerated with fuzz matching. Set dry_run=true to preview without writing.",
  parameters: {
    type: "object",
    properties: {
      file_path: {
        type: "string",
        description: "Target file for the patch"
      },
      diff: {
        type: "string",
        description: "Unified diff content"
      },
      dry_run: {
        type: "boolean",
        description: "Compute the result without writing it"
      }
    },
    required: ["file_path", "diff"]
  },
  readOnly: false,

  needsPermission(input): ReturnType<ToolDefinition["needsPermission"]> {
    if (input["dry_run"] === true) {
      return { required: false, risk: "low" };
    }
    const path = String(input["file_path"] ?? "");
    return {
      required: true,
      risk: "medium",
      pattern: `patch:${path}`,
      title: "Apply patch",
      summary: [path || "(unknown path)", `${String(input["diff"] ?? "").split("\n").length} patch lines`]
    };
  },

  async execute(
    input: Record<string, unknown>,
    context: ToolContext
  ): Promise<ToolInvocationResult> {
    const rawPath = String(input["file_path"] ?? "");
    const diffText = String(input["diff"] ?? "");
    const dryRun = input["dry_run"] === true;

    if (rawPath.trim().length === 0) throw new AxiomError("patch requires file_path");
    if (diffText.trim().length === 0) throw new AxiomError("patch requires non-empty diff");

    const parsed = parseUnifiedPatch(diffText);
    if (parsed.hunks.length === 0) {
      return {
        content:
          "No valid @@ hunks found in the provided diff. Ensure it uses the unified format:\n--- a/file\n+++ b/file\n@@ -1,3 +1,4 @@\n context\n-removed\n+added",
        isError: true
      };
    }

    const resolved = resolveWithinRoot(context.cwd, rawPath);

    try {
      await stat(resolved.absolute);
    } catch {
      return { content: `File not found: ${resolved.relative}`, isError: true };
    }

    if (await guardBinaryFile(resolved.absolute)) {
      return { content: `${resolved.relative} looks binary; refusing to patch`, isError: true };
    }

    const original = await readFile(resolved.absolute, "utf8");
    const outcome = applyUnifiedPatch(original, parsed.hunks);

    const report: string[] = [];
    report.push(`Parsed ${parsed.hunks.length} hunk(s) targeting ${resolved.relative}`);

    if (outcome.appliedHunks.length > 0) {
      report.push(`Applied hunks: ${outcome.appliedHunks.map((n) => `#${n + 1}`).join(", ")}`);
    }
    if (outcome.rejectedHunks.length > 0) {
      report.push(`REJECTED hunks: ${outcome.rejectedHunks.map((n) => `#${n + 1}`).join(", ")}`);
    }
    for (const note of outcome.notes) {
      report.push(note);
    }

    if (!outcome.success && outcome.appliedHunks.length === 0) {
      report.push("No changes were written.");
      return { content: report.join("\n"), isError: true };
    }

    if (dryRun) {
      report.push("(dry run — file not modified)");
      return {
        content: report.join("\n"),
        isError: outcome.rejectedHunks.length > 0,
        metadata: {
          dryRun: true,
          appliedHunks: outcome.appliedHunks.length,
          rejectedHunks: outcome.rejectedHunks.length
        }
      };
    }

    context.snapshotFiles([resolved.absolute]);
    await writeFile(resolved.absolute, outcome.newText, "utf8");

    const changedLines = countChangedLines(original, outcome.newText);
    const resultDiff = renderUnifiedDiff(original, outcome.newText, { filePath: resolved.relative });
    report.push(
      `Written. +${changedLines.additions}/-${changedLines.deletions}${outcome.rejectedHunks.length > 0 ? " (partial)" : ""}`
    );

    return {
      content: report.join("\n"),
      isError: outcome.rejectedHunks.length > 0,
      metadata: {
        filesChanged: [{ path: resolved.relative, kind: "patched" }],
        additions: changedLines.additions,
        deletions: changedLines.deletions,
        rejectedHunks: outcome.rejectedHunks,
        diff: resultDiff
      }
    };
  }
};

function countChangedLines(before: string, after: string): { additions: number; deletions: number } {
  const beforeSet = lineMultiset(before);
  const afterSet = lineMultiset(after);

  let additions = 0;
  let deletions = 0;

  for (const [line, count] of beforeSet) {
    const afterCount = afterSet.get(line) ?? 0;
    if (count > afterCount) deletions += count - afterCount;
  }
  for (const [line, count] of afterSet) {
    const beforeCount = beforeSet.get(line) ?? 0;
    if (count > beforeCount) additions += count - beforeCount;
  }

  return { additions, deletions };
}

function lineMultiset(text: string): Map<string, number> {
  const map = new Map<string, number>();
  for (const line of text.split("\n")) {
    map.set(line, (map.get(line) ?? 0) + 1);
  }
  return map;
}
