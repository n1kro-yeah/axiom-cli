import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { ToolDefinition, ToolInvocationResult, ToolContext } from "../types.js";
import { AxiomError } from "../util/errors.js";
import {
  buildPermissionPayload,
  isImagePath,
  resolveWithinRoot,
  truncateToolOutput
} from "./common.js";
import { splitLines } from "../util/diff.js";
import { renderUnifiedDiff } from "../util/diff.js";
import { summarizeChanges } from "../util/patch.js";

const MAX_WRITE_BYTES = 2 * 1024 * 1024;

export function extractFilePath(input: Record<string, unknown>): string {
  const candidate = input["file_path"] ?? input["path"];
  if (typeof candidate !== "string" || candidate.trim().length === 0) {
    throw new AxiomError("file_path parameter is required");
  }
  return candidate;
}

export const writeTool: ToolDefinition = {
  name: "write",
  label: "Write",
  description:
    "Create a new file or fully overwrite an existing one with the given content. Prefer the edit tool for targeted changes to existing files. Content is written verbatim; parent directories are created automatically.",
  parameters: {
    type: "object",
    properties: {
      file_path: {
        type: "string",
        description: "Path of the file to create or overwrite"
      },
      content: {
        type: "string",
        description: "Full content to write"
      }
    },
    required: ["file_path", "content"]
  },
  readOnly: false,

  needsPermission(input): ReturnType<ToolDefinition["needsPermission"]> {
    const path = String(input["file_path"] ?? "");
    return {
      required: true,
      risk: "medium",
      pattern: `write:${path}`,
      title: "Create or overwrite file",
      summary: [path || "(unknown path)", `${String(input["content"] ?? "").split("\n").length} lines`]
    };
  },

  async execute(
    input: Record<string, unknown>,
    context: ToolContext
  ): Promise<ToolInvocationResult> {
    const rawPath = extractFilePath(input);
    const content = input["content"];

    if (typeof content !== "string") {
      throw new AxiomError("content parameter must be a string");
    }

    if (Buffer.byteLength(content, "utf8") > MAX_WRITE_BYTES) {
      throw new AxiomError(`Content exceeds ${MAX_WRITE_BYTES} bytes limit for the write tool`);
    }

    const resolved = resolveWithinRoot(context.cwd, rawPath);

    if (isImagePath(resolved.absolute)) {
      return {
        content: `Refusing to write binary image data as text. Use bash with an appropriate encoder instead.`,
        isError: true
      };
    }

    let previousContent: string | undefined;
    try {
      const info = await stat(resolved.absolute);
      if (info.isFile()) {
        previousContent = await readFile(resolved.absolute, "utf8");
      }
    } catch {
      previousContent = undefined;
    }

    context.snapshotFiles([resolved.absolute]);

    await mkdir(dirname(resolved.absolute), { recursive: true });
    await writeFile(resolved.absolute, content, "utf8");

    if (previousContent === undefined) {
      const lineCount = splitLines(content).length;
      return {
        content: truncateToolOutput(
          `Created ${resolved.relative} (${lineCount} lines, ${Buffer.byteLength(content)} bytes)`
        ),
        isError: false,
        metadata: {
          filesChanged: [{ path: resolved.relative, kind: "created" }],
          additions: lineCount,
          deletions: 0
        }
      };
    }

    const stats = summarizeChanges(previousContent, content);
    const preview =
      previousContent.length < 20000 ? renderPreview(previousContent, content) : "";
    const diffText = renderUnifiedDiff(previousContent, content, { filePath: resolved.relative });

    return {
      content: truncateToolOutput(
        `Updated ${resolved.relative} (+${stats.additions}/-${stats.deletions})${preview}`
      ),
      isError: false,
      metadata: {
        filesChanged: [{ path: resolved.relative, kind: "updated" }],
        additions: stats.additions,
        deletions: stats.deletions,
        diff: diffText
      }
    };
  }
};

function renderPreview(before: string, after: string): string {
  const beforeLines = new Set(splitLines(before));
  const added = splitLines(after).filter((line) => !beforeLines.has(line));
  if (added.length === 0) return "";
  const shown = added.slice(0, 12).map((line) => `+ ${line}`);
  const rest = added.length - shown.length;
  return `\n${shown.join("\n")}${rest > 0 ? `\n…(+${rest} more lines)` : ""}`;
}
