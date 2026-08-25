import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ToolDefinition, ToolInvocationResult, ToolContext } from "../types.js";
import { AxiomError } from "../util/errors.js";
import { matchGlobPath } from "../util/fuzzy.js";
import { walkFiles } from "../util/walk.js";
import { truncateToolOutput } from "./common.js";

const MAX_MATCH_LINES = 250;
const MAX_BYTES_PER_FILE = 1_500_000;
const MAX_FILES_SCANNED = 12000;

interface GrepInput {
  pattern?: string;
  path?: string;
  include?: string;
  case_insensitive?: boolean;
  fixed_strings?: boolean;
  context?: number;
  output_mode?: "content" | "files_with_matches" | "count";
  head_limit?: number;
}

export const grepTool: ToolDefinition = {
  name: "grep",
  label: "Search",
  description:
    "Search file contents with a regular expression across the project (respects .gitignore). Supports an optional glob include-filter like *.ts. Modes: content (default, shows matching lines), files_with_matches, count.",
  parameters: {
    type: "object",
    properties: {
      pattern: {
        type: "string",
        description: "Regular expression to search for"
      },
      path: {
        type: "string",
        description: "Optional directory to limit the search"
      },
      include: {
        type: "string",
        description: "Glob filter for filenames, e.g. *.ts"
      },
      case_insensitive: {
        type: "boolean",
        description: "Case-insensitive matching"
      },
      fixed_strings: {
        type: "boolean",
        description: "Treat pattern as a literal string"
      },
      context: {
        type: "number",
        description: "Lines of context around matches"
      },
      output_mode: {
        type: "string",
        enum: ["content", "files_with_matches", "count"],
        description: "Result format"
      },
      head_limit: {
        type: "number",
        description: "Maximum number of result lines"
      }
    },
    required: ["pattern"]
  },
  readOnly: true,

  needsPermission(): { required: boolean; risk: "low" } {
    return { required: false, risk: "low" };
  },

  async execute(
    input: Record<string, unknown>,
    context: ToolContext
  ): Promise<ToolInvocationResult> {
    const typed = input as GrepInput;
    const rawPattern = typed.pattern?.trim();
    if (!rawPattern) throw new AxiomError("grep requires a pattern");

    let regexSource = rawPattern;
    if (typed.fixed_strings === true) {
      regexSource = rawPattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }

    let matcher: RegExp;
    try {
      matcher = new RegExp(regexSource, typed.case_insensitive === true ? "gi" : "g");
    } catch (error) {
      return {
        content: `Invalid regex "${rawPattern}": ${describeError(error)}. Simplify the expression or set fixed_strings=true.`,
        isError: true
      };
    }

    const rootDir = typed.path?.trim() ? join(context.cwd, typed.path.trim()) : context.cwd;
    const includeGlobs = parseInclude(typed.include);
    const contextLines = clampContext(typed.context ?? 0);

    const walk = await walkFiles(rootDir, {
      respectGitIgnore: true,
      maxDepth: 20,
      maxEntries: MAX_FILES_SCANNED
    });

    let filesToScan = walk.files;
    if (includeGlobs.length > 0) {
      filesToScan = filesToScan.filter((file) => includeGlobs.some((glob) => matchInclude(file, glob)));
    }
    filesToScan.sort((a, b) => a.localeCompare(b));

    const outputMode = typed.output_mode ?? "content";
    const headLimit = clampHeadLimit(typed.head_limit ?? MAX_MATCH_LINES);
    const resultLines: string[] = [];
    const fileMatches: string[] = [];
    const countEntries: Array<{ file: string; count: number }> = [];

    let totalMatches = 0;
    let scanned = 0;
    let hitOutputLimit = false;

    for (const relativeFile of filesToScan) {
      if (scanned >= MAX_FILES_SCANNED || hitOutputLimit) break;

      const absolutePath = join(rootDir, relativeFile);
      let text: string;
      try {
        const buffer = await readFile(absolutePath);
        if (buffer.byteLength > MAX_BYTES_PER_FILE) continue;
        if (containsNullByte(buffer)) continue;
        text = buffer.toString("utf8");
      } catch {
        continue;
      }

      scanned += 1;
      const lines = text.split("\n");
      const matchedLineNumbers: number[] = [];

      for (let index = 0; index < lines.length; index += 1) {
        matcher.lastIndex = 0;
        if (!matcher.test(lines[index])) continue;
        matchedLineNumbers.push(index + 1);
        totalMatches += 1;
        if (totalMatches >= headLimit * 6) break;
      }

      if (matchedLineNumbers.length === 0) continue;
      fileMatches.push(relativeFile);
      countEntries.push({ file: relativeFile, count: matchedLineNumbers.length });

      if (outputMode === "content") {
        const blocks = renderContentBlocks(lines, matchedLineNumbers, contextLines, relativeFile);
        for (const block of blocks) {
          if (resultLines.length >= headLimit) {
            hitOutputLimit = true;
            break;
          }
          resultLines.push(block);
        }
      } else if (outputMode === "count" && countEntries.length >= headLimit) {
        hitOutputLimit = true;
      } else if (outputMode === "files_with_matches" && fileMatches.length >= headLimit) {
        hitOutputLimit = true;
      }
    }

    if (totalMatches === 0) {
      return {
        content: `No matches for "${rawPattern}"${includeGlobs.length > 0 ? ` in ${typed.include}` : ""} (${scanned} files scanned).`,
        isError: false
      };
    }

    if (outputMode === "files_with_matches") {
      const body = fileMatches.slice(0, headLimit).join("\n");
      return {
        content: truncateToolOutput(`${body}${fileMatches.length > headLimit ? `\n…(${fileMatches.length - headLimit} more)` : ""}`),
        isError: false,
        metadata: { totalMatches, files: fileMatches.length }
      };
    }

    if (outputMode === "count") {
      const body = countEntries
        .slice(0, headLimit)
        .map((entry) => `${entry.count.toString().padStart(4)} ${entry.file}`)
        .join("\n");
      const total = countEntries.reduce((sum, entry) => sum + entry.count, 0);
      return {
        content: truncateToolOutput(`${body}\n\ntotal: ${total} matches in ${countEntries.length} files`),
        isError: false,
        metadata: { totalMatches }
      };
    }

    const suffix =
      resultLines.length > headLimit
        ? `\n…truncated at ${headLimit} lines (use head_limit or narrow the pattern)`
        : "";
    return {
      content: truncateToolOutput(resultLines.slice(0, headLimit).join("\n") + suffix),
      isError: false,
      metadata: {
        totalMatches,
        filesWithMatches: fileMatches.length,
        filesScanned: scanned
      }
    };
  }
};

function matchInclude(file: string, glob: string): boolean {
  if (matchGlobPath(file, glob)) return true;
  if (matchGlobPath(file, `**/${glob}`)) return true;
  const base = file.split("/").pop() ?? "";
  return matchGlobPath(base, glob);
}

function parseInclude(include: string | undefined): string[] {
  if (!include || include.trim().length === 0) return [];
  return include
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map((part) => part.replace(/\\/g, "/"));
}

function clampContext(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(Math.floor(value), 8));
}

function clampHeadLimit(value: number): number {
  if (!Number.isFinite(value)) return MAX_MATCH_LINES;
  return Math.max(5, Math.min(Math.floor(value), 1000));
}

function containsNullByte(buffer: Buffer): boolean {
  const sampleLength = Math.min(buffer.byteLength, 4096);
  for (let i = 0; i < sampleLength; i += 1) {
    if (buffer[i] === 0) return true;
  }
  return false;
}

function renderContentBlocks(
  lines: string[],
  matchedLineNumbers: number[],
  contextSize: number,
  filePath: string
): string[] {
  const out: string[] = [];
  const matchedSet = new Set(matchedLineNumbers);

  let currentBlockStart: number | null = null;
  let lastIncluded = -1;

  for (const lineNumber of matchedLineNumbers) {
    const blockStart = Math.max(lineNumber - contextSize, 1);
    const blockEnd = Math.min(lineNumber + contextSize, lines.length);

    if (currentBlockStart !== null && blockStart > lastIncluded + 1) {
      out.push("");
    }
    if (currentBlockStart === null || blockStart > lastIncluded + 1) {
      if (contextSize > 0) {
        out.push(`${filePath}:`);
      }
    }
    currentBlockStart = currentBlockStart ?? blockStart;

    for (let index = Math.max(blockStart, lastIncluded + 2); index <= blockEnd; index += 1) {
      const prefix = matchedSet.has(index) ? ">" : " ";
      const rendered = lines[index - 1] ?? "";
      out.push(`${filePath}:${String(index).padStart(4)}${prefix}${rendered}`);
    }

    lastIncluded = blockEnd;
  }

  void currentBlockStart;
  return out;
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
