import { readFile, stat, writeFile } from "node:fs/promises";
import type { ToolDefinition, ToolInvocationResult, ToolContext } from "../types.js";
import { AxiomError } from "../util/errors.js";
import { resolveWithinRoot, truncateToolOutput } from "./common.js";
import { applyExactEdits, countOccurrences, summarizeChanges } from "../util/patch.js";
import { guardBinaryFile } from "./common.js";

interface EditOperationInput {
  old_string?: string;
  new_string?: string;
  replace_all?: boolean;
}

function findNearestLine(haystack: string[], needle: string): number | undefined {
  const needleFirst = needle.split("\n")[0].trim().slice(0, 80);
  if (needleFirst.length === 0) return undefined;
  let bestIndex: number | undefined = undefined;
  let bestScore = 0;

  for (let i = 0; i < haystack.length; i += 1) {
    const score = similarity(needleFirst, haystack[i]?.trim() ?? "");
    if (score > bestScore) {
      bestScore = score;
      bestIndex = i;
    }
  }

  return bestIndex !== undefined && bestScore >= 0.55 ? bestIndex + 1 : undefined;
}

function similarity(a: string, b: string): number {
  if (a.length === 0 || b.length === 0) return 0;
  const gramsA = bigrams(a.toLowerCase());
  const gramsB = bigrams(b.toLowerCase());
  const pool = [...gramsB];
  let hits = 0;
  for (const gram of gramsA) {
    const position = pool.indexOf(gram);
    if (position !== -1) {
      pool.splice(position, 1);
      hits += 1;
    }
  }
  return (2 * hits) / (gramsA.length + gramsB.length);
}

function bigrams(value: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < value.length - 1; i += 1) {
    out.push(value.slice(i, i + 2));
  }
  return out.length > 0 ? out : [value];
}

export const editTool: ToolDefinition = {
  name: "edit",
  label: "Edit",
  description:
    "Perform exact string replacement inside a file. old_string must match exactly and be unique in the file unless replace_all is true. For several changes pass them via edits array. Always read the file first.",
  parameters: {
    type: "object",
    properties: {
      file_path: {
        type: "string",
        description: "Path of the file to edit"
      },
      old_string: {
        type: "string",
        description: "Exact text to replace"
      },
      new_string: {
        type: "string",
        description: "Replacement text"
      },
      replace_all: {
        type: "boolean",
        description: "Replace every occurrence of old_string"
      },
      edits: {
        type: "array",
        description: "List of {old_string,new_string,replace_all} operations applied in order",
        items: {
          type: "object",
          properties: {
            old_string: { type: "string" },
            new_string: { type: "string" },
            replace_all: { type: "boolean" }
          },
          required: ["old_string", "new_string"]
        }
      }
    },
    required: ["file_path", "old_string", "new_string"]
  },
  readOnly: false,

  needsPermission(input): ReturnType<ToolDefinition["needsPermission"]> {
    const path = String(input["file_path"] ?? "");
    return {
      required: true,
      risk: "medium",
      pattern: `edit:${path}`,
      title: "Edit file",
      summary: [path || "(unknown path)", truncateForSummary(String(input["old_string"] ?? ""))]
    };
  },

  async execute(
    input: Record<string, unknown>,
    context: ToolContext
  ): Promise<ToolInvocationResult> {
    const rawPath = String(input["file_path"] ?? input["path"] ?? "");
    if (rawPath.trim().length === 0) {
      throw new AxiomError("edit requires file_path");
    }

    const resolved = resolveWithinRoot(context.cwd, rawPath);

    let info;
    try {
      info = await stat(resolved.absolute);
    } catch {
      throw new AxiomError(`File not found: ${resolved.relative}. Create it with the write tool first.`);
    }
    void info;

    if (await guardBinaryFile(resolved.absolute)) {
      return { content: `${resolved.relative} looks like a binary file; text edit refused`, isError: true };
    }

    const original = await readFile(resolved.absolute, "utf8");

    const operations = collectOperations(input);
    if (operations.length === 0) {
      throw new AxiomError("No edit operations provided");
    }

    const failures: string[] = [];
    for (const [index, operation] of operations.entries()) {
      if (operation.oldText.length === 0) {
        failures.push(`operation #${index + 1}: empty old_string`);
        continue;
      }
      const occurrences = countOccurrences(original, operation.oldText);
      if (occurrences === 0) {
        const allLines = original.split("\n");
        const nearest = findNearestLine(allLines, operation.oldText);
        const hint = nearest !== undefined ? ` The closest match is at line ${nearest}.` : "";
        failures.push(`operation #${index + 1}: old_string not found.${hint}`);
      } else if (occurrences > 1 && !operation.replaceAll) {
        failures.push(
          `operation #${index + 1}: old_string matches ${occurrences} locations. Provide more surrounding context or set replace_all=true.`
        );
      }
    }

    if (failures.length > 0 && failures.length === operations.length) {
      return {
        content: `All edit operations failed:\n${failures.map((failure) => `- ${failure}`).join("\n")}`,
        isError: true
      };
    }

    context.snapshotFiles([resolved.absolute]);

    const applicableOperations = operations.filter((_, index) =>
      !failures.some((failure) => failure.startsWith(`operation #${index + 1}:`))
    );
    const appliedResult = applyExactEdits(original, applicableOperations);

    if (appliedResult.applied === 0) {
      return { content: "Nothing was edited", isError: true };
    }

    await writeFile(resolved.absolute, appliedResult.result, "utf8");

    const stats = summarizeChanges(original, appliedResult.result);
    const warningBlock =
      failures.length > 0 ? `\n\nSkipped operations:\n${failures.map((f) => `- ${f}`).join("\n")}` : "";

    return {
      content: truncateToolOutput(
        `Edited ${resolved.relative}: ${appliedResult.applied} replacement(s), +${stats.additions}/-${stats.deletions}${warningBlock}`
      ),
      isError: false,
      metadata: {
        filesChanged: [{ path: resolved.relative, kind: "edited" }],
        appliedCount: appliedResult.applied,
        additions: stats.additions,
        deletions: stats.deletions
      }
    };
  }
};

function collectOperations(input: Record<string, unknown>): Array<{ oldText: string; newText: string; replaceAll: boolean }> {
  const operations: Array<{ oldText: string; newText: string; replaceAll: boolean }> = [];

  const single = input as EditOperationInput;
  if (
    typeof single.old_string === "string" &&
    typeof single.new_string === "string" &&
    single.old_string.length > 0
  ) {
    operations.push({
      oldText: single.old_string,
      newText: single.new_string,
      replaceAll: single.replace_all === true
    });
  }

  const batch = input["edits"];
  if (Array.isArray(batch)) {
    for (const entry of batch) {
      if (!entry || typeof entry !== "object") continue;
      const record = entry as Record<string, unknown>;
      if (typeof record["old_string"] !== "string" || typeof record["new_string"] !== "string") continue;
      operations.push({
        oldText: record["old_string"],
        newText: record["new_string"],
        replaceAll: record["replace_all"] === true
      });
    }
  }

  return operations;
}

function truncateForSummary(value: string): string {
  const line = value.split("\n")[0] ?? "";
  return line.length > 100 ? `${line.slice(0, 97)}…` : line;
}
