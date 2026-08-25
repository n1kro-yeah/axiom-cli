import { readdir, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import type { ToolDefinition, ToolInvocationResult, ToolContext } from "../types.js";
import { AxiomError } from "../util/errors.js";
import { IgnoreStack, walkFiles } from "../util/walk.js";
import { truncateToolOutput } from "./common.js";

interface LsInput {
  path?: string;
  depth?: number;
  show_hidden?: boolean;
}

interface DirectoryEntryView {
  name: string;
  relativePath: string;
  kind: "dir" | "file";
  sizeBytes?: number;
}

export const lsTool: ToolDefinition = {
  name: "ls",
  label: "List",
  description:
    "List directory contents with sizes. Non-recursive by default; pass depth to recurse (respects .gitignore). Hidden files are shown for the immediate directory only.",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Directory to list; defaults to project root"
      },
      depth: {
        type: "number",
        description: "Recursion depth (0 = flat listing)"
      },
      show_hidden: {
        type: "boolean",
        description: "Include dotfiles"
      }
    },
    required: []
  },
  readOnly: true,

  needsPermission(): { required: boolean; risk: "low" } {
    return { required: false, risk: "low" };
  },

  async execute(
    input: Record<string, unknown>,
    context: ToolContext
  ): Promise<ToolInvocationResult> {
    const typed = input as LsInput;
    const targetRelative = typed.path?.trim() || ".";
    const targetAbsolute = join(context.cwd, targetRelative);

    const info = await stat(targetAbsolute).catch(() => undefined);
    if (!info) return { content: `Directory not found: ${targetRelative}`, isError: true };
    if (!info.isDirectory()) {
      return { content: `${targetRelative} is a file, not a directory`, isError: true };
    }

    const depth = clampDepth(typed.depth ?? 0);
    const entries = await collectEntries(targetAbsolute, context.cwd, depth, typed.show_hidden === true);

    if (entries.length === 0) {
      return { content: `${targetRelative} is empty`, isError: false };
    }

    entries.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
      return a.relativePath.localeCompare(b.relativePath);
    });

    const lines = entries.map((entry) => renderEntry(entry));
    const header =
      depth === 0
        ? `${targetRelative} (${countFiles(entries)} files, ${countDirs(entries)} dirs)`
        : `${targetRelative} tree depth ${depth}`;

    return {
      content: truncateToolOutput(`${header}\n${lines.join("\n")}`),
      isError: false,
      metadata: {
        fileCount: countFiles(entries),
        dirCount: countDirs(entries)
      }
    };
  }
};

function clampDepth(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(Math.floor(value), 4));
}

async function collectEntries(
  absoluteDir: string,
  rootCwd: string,
  depth: number,
  includeHidden: boolean
): Promise<DirectoryEntryView[]> {
  if (depth >= 1) {
    const walked = await walkFiles(absoluteDir, {
      respectGitIgnore: true,
      maxDepth: depth,
      maxEntries: 5000,
      includeHidden
    });
    const views: DirectoryEntryView[] = [];
    const basePrefix = relative(rootCwd, absoluteDir).split("\\").join("/");

    for (const dir of walked.directories) {
      views.push({
        name: lastSegment(dir),
        relativePath: basePrefix === "" ? `${dir}/` : `${basePrefix}/${dir}/`,
        kind: "dir"
      });
    }
    for (const file of walked.files.slice(0, 2000)) {
      views.push({
        name: lastSegment(file),
        relativePath: basePrefix === "" ? file : `${basePrefix}/${file}`,
        kind: "file",
        sizeBytes: await fileSize(join(absoluteDir, file))
      });
    }
    return views;
  }

  let dirents;
  try {
    dirents = await readdir(absoluteDir, { withFileTypes: true });
  } catch (error) {
    throw new AxiomError(`Cannot read directory: ${describeError(error)}`);
  }

  const ignoreStack = new IgnoreStack(rootCwd);
  ignoreStack.addDefaults();

  const views: DirectoryEntryView[] = [];
  for (const dirent of dirents) {
    const isHidden = dirent.name.startsWith(".");
    if (isHidden && !includeHidden && dirent.name !== ".gitignore") continue;

    const entryAbsolute = join(absoluteDir, dirent.name);
    const entryRelative = relative(rootCwd, entryAbsolute).split("\\").join("/");

    if (dirent.isDirectory()) {
      if (ignoreStack.isIgnored(entryRelative, true)) continue;
      views.push({ name: dirent.name, relativePath: entryRelative, kind: "dir" });
      continue;
    }
    if (dirent.isFile()) {
      if (!isHidden && ignoreStack.isIgnored(entryRelative, false)) continue;
      views.push({
        name: dirent.name,
        relativePath: entryRelative,
        kind: "file",
        sizeBytes: await fileSize(entryAbsolute)
      });
    }
  }

  return views;
}

async function fileSize(absolutePath: string): Promise<number | undefined> {
  try {
    const info = await stat(absolutePath);
    return info.size;
  } catch {
    return undefined;
  }
}

function renderEntry(entry: DirectoryEntryView): string {
  if (entry.kind === "dir") return `DIR  ${entry.relativePath}/`;
  const size = entry.sizeBytes ?? 0;
  return `FILE ${entry.relativePath}${size > 0 ? ` (${formatSize(size)})` : ""}`;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function countFiles(entries: DirectoryEntryView[]): number {
  return entries.filter((entry) => entry.kind === "file").length;
}

function countDirs(entries: DirectoryEntryView[]): number {
  return entries.filter((entry) => entry.kind === "dir").length;
}

function lastSegment(pathValue: string): string {
  const normalized = pathValue.split("\\").join("/");
  const parts = normalized.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? normalized;
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
