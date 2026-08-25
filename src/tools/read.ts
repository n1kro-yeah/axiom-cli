import { readFile, stat } from "node:fs/promises";
import type { ToolDefinition, ToolInvocationResult, ToolContext } from "../types.js";
import { AxiomError } from "../util/errors.js";
import {
  assertFileExists,
  clampOffsetLimit,
  formatNumberedLines,
  guardBinaryFile,
  isImagePath,
  MAX_READ_FILE_BYTES,
  resolveWithinRoot,
  truncateToolOutput,
  describeFileSize
} from "./common.js";
import { splitLines } from "../util/diff.js";

interface ReadInput {
  file_path?: string;
  path?: string;
  offset?: number;
  limit?: number;
}

function extractPath(input: Record<string, unknown>): string {
  const candidate = input["file_path"] ?? input["path"];
  if (typeof candidate !== "string" || candidate.length === 0) {
    throw new AxiomError("read requires a file_path parameter");
  }
  return candidate;
}

export const readTool: ToolDefinition = {
  name: "read",
  label: "Read",
  description:
    "Read a file from the project. Returns numbered lines. Use offset and limit to page through large files; default limit is 2000 lines. Images are returned as visual attachments.",
  parameters: {
    type: "object",
    properties: {
      file_path: {
        type: "string",
        description: "Path to the file, relative to the project root or absolute"
      },
      offset: {
        type: "number",
        description: "1-based line number to start reading from"
      },
      limit: {
        type: "number",
        description: "Maximum number of lines to read"
      }
    },
    required: ["file_path"]
  },
  readOnly: true,

  needsPermission(): { required: boolean; risk: "low" } {
    return { required: false, risk: "low" };
  },

  async execute(
    input: Record<string, unknown>,
    context: ToolContext
  ): Promise<ToolInvocationResult> {
    const rawPath = extractPath(input);
    const resolved = resolveWithinRoot(context.cwd, rawPath);
    assertFileExists(resolved.absolute);

    const info = await stat(resolved.absolute);
    if (info.size > MAX_READ_FILE_BYTES) {
      return {
        content: `File too large (${describeFileSize(info.size)}, limit ${describeFileSize(MAX_READ_FILE_BYTES)}). Use bash or targeted search instead.`,
        isError: true
      };
    }

    if (isImagePath(resolved.absolute)) {
      const buffer = await readFile(resolved.absolute);
      const mime = imageMimeFor(resolved.absolute);
      return {
        content: `Image loaded: ${resolved.relative} (${describeFileSize(info.size)})`,
        isError: false,
        images: [{ mediaType: mime, data: buffer.toString("base64") }]
      };
    }

    if (await guardBinaryFile(resolved.absolute)) {
      return {
        content: `Binary file detected (${resolved.relative}, ${describeFileSize(info.size)}). Text tools cannot display it.`,
        isError: true
      };
    }

    const text = await readFile(resolved.absolute, "utf8");
    const allLines = splitLines(text);
    const typedInput = input as ReadInput;
    const { startLine, endLine } = clampOffsetLimit(typedInput.offset, typedInput.limit, allLines.length);

    if (startLine > allLines.length) {
      return {
        content: `offset ${startLine} is beyond end of file (${allLines.length} lines total)`,
        isError: true
      };
    }

    const slice = allLines.slice(startLine - 1, endLine);
    const numbered = formatNumberedLines(slice, startLine);

    let header = resolved.relative;
    if (startLine > 1 || endLine < allLines.length) {
      header += ` [lines ${startLine}-${Math.min(endLine, allLines.length)} of ${allLines.length}]`;
    }

    const result = `${header}\n${numbered}`;
    return {
      content: truncateToolOutput(result),
      isError: false,
      metadata: {
        path: resolved.relative,
        totalLines: allLines.length,
        returnedLines: slice.length
      }
    };
  }
};

function imageMimeFor(filePath: string): string {
  const lower = filePath.toLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".bmp")) return "image/bmp";
  return "image/png";
}
