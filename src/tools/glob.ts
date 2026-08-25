import { stat } from "node:fs/promises";
import { join } from "node:path";
import type { ToolDefinition, ToolInvocationResult, ToolContext } from "../types.js";
import { AxiomError } from "../util/errors.js";
import { matchGlobPath } from "../util/fuzzy.js";
import { walkFiles } from "../util/walk.js";
import { truncateToolOutput } from "./common.js";

const MAX_GLOB_RESULTS = 400;

interface GlobInput {
  pattern?: string;
  path?: string;
  sort_by_mtime?: boolean;
}

export const globTool: ToolDefinition = {
  name: "glob",
  label: "Glob",
  description:
    "Find files by wildcard patterns like **/*.ts or src/**/*.test.*. Supports *, **, ?, [abc], {a,b}. Respects .gitignore. Returns paths sorted by name unless sort_by_mtime is set.",
  parameters: {
    type: "object",
    properties: {
      pattern: {
        type: "string",
        description: "Glob pattern relative to search root"
      },
      path: {
        type: "string",
        description: "Optional subdirectory to search within"
      },
      sort_by_mtime: {
        type: "boolean",
        description: "Sort newest files first"
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
    const typed = input as GlobInput;
    const pattern = typed.pattern?.trim();
    if (!pattern) throw new AxiomError("glob requires a pattern");

    let rootDir = context.cwd;
    if (typed.path && typed.path.trim().length > 0) {
      const joined = join(context.cwd, typed.path);
      const info = await stat(joined).catch(() => undefined);
      if (!info?.isDirectory()) {
        return { content: `Search directory not found: ${typed.path}`, isError: true };
      }
      rootDir = joined;
    }

    const walk = await walkFiles(rootDir, {
      respectGitIgnore: true,
      maxDepth: 20,
      maxEntries: 60000
    });

    const normalizedPattern = pattern.replace(/\\/g, "/");
    const matched = walk.files.filter((file) => matchesPattern(file, normalizedPattern));

    if (matched.length === 0) {
      const dirMatches = walk.directories.filter((dir) => matchGlobPath(dir, normalizedPattern));
      if (dirMatches.length === 0) {
        return {
          content: `No files matched "${normalizedPattern}" (${walk.files.length} files scanned${walk.truncated ? ", scan truncated" : ""}). Try broader patterns like **/${lastSegment(normalizedPattern)}.`,
          isError: false
        };
      }
      return {
        content: truncateToolOutput(dirMatches.slice(0, MAX_GLOB_RESULTS).join("\n")),
        isError: false,
        metadata: { count: dirMatches.length, directoriesOnly: true }
      };
    }

    let ordered = matched;
    if (typed.sort_by_mtime === true) {
      const stamped = await Promise.all(
        matched.map(async (file) => ({
          file,
          mtime: await stat(join(rootDir, file))
            .then((info) => info.mtimeMs)
            .catch(() => 0)
        }))
      );
      stamped.sort((a, b) => b.mtime - a.mtime);
      ordered = stamped.map((entry) => entry.file);
    } else {
      ordered = [...matched].sort((a, b) => a.localeCompare(b));
    }

    const limited = ordered.slice(0, MAX_GLOB_RESULTS);
    const suffix =
      ordered.length > MAX_GLOB_RESULTS ? `\n…and ${ordered.length - MAX_GLOB_RESULTS} more` : "";

    return {
      content: truncateToolOutput(limited.join("\n") + suffix),
      isError: false,
      metadata: {
        count: ordered.length,
        truncated: ordered.length > MAX_GLOB_RESULTS,
        scannedFiles: walk.files.length
      }
    };
  }
};

function matchesPattern(file: string, pattern: string): boolean {
  if (matchGlobPath(file, pattern)) return true;
  const base = file.split("/").pop() ?? "";
  if (!pattern.includes("/")) {
    return matchGlobPath(base, pattern);
  }
  return false;
}

function lastSegment(pattern: string): string {
  const parts = pattern.split("/");
  return parts[parts.length - 1] ?? pattern;
}
