import { existsSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { AxiomError } from "../util/errors.js";
import { looksBinary } from "../util/walk.js";

export const MAX_TOOL_OUTPUT_CHARS = 30000;
export const MAX_READ_FILE_BYTES = 2 * 1024 * 1024;
export const DEFAULT_READ_LIMIT = 2000;

export interface ResolvedPath {
  absolute: string;
  relative: string;
}

export function resolveWithinRoot(rootCwd: string, rawPath: string): ResolvedPath {
  if (!rawPath || rawPath.trim().length === 0) {
    throw new AxiomError("Empty path provided");
  }

  const trimmed = rawPath.trim().replace(/^"(.*)"$/, "$1");
  const absolute = isAbsolute(trimmed)
    ? resolve(normalizeWindowsPath(trimmed))
    : resolve(rootCwd, normalizeWindowsPath(trimmed));

  const normalizedRoot = resolve(rootCwd);
  const rel = relative(normalizedRoot, absolute);

  if (rel.startsWith("..") || isAbsoluteWindows(rel)) {
    throw new AxiomError(
      `Path "${rawPath}" escapes the project root. Access outside ${normalizedRoot} is not allowed by file tools.`
    );
  }

  return { absolute, relative: rel.split("\\").join("/") };
}

function normalizeWindowsPath(input: string): string {
  return input.replace(/\//g, sep === "\\" ? "\\" : "/");
}

function isAbsoluteWindows(rel: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(rel) || rel.startsWith("/");
}

export function assertFileExists(absolutePath: string): void {
  if (!existsSync(absolutePath)) {
    throw new AxiomError(`File not found: ${absolutePath}`);
  }
  const info = statSync(absolutePath);
  if (!info.isFile()) {
    throw new AxiomError(`Not a regular file: ${absolutePath}`);
  }
}

export function truncateToolOutput(content: string, limit = MAX_TOOL_OUTPUT_CHARS): string {
  if (content.length <= limit) return content;
  const head = content.slice(0, Math.floor(limit * 0.8));
  const tail = content.slice(content.length - Math.floor(limit * 0.15));
  return `${head}\n…[output truncated, ${content.length - limit} chars omitted]…\n${tail}`;
}

export function formatNumberedLines(lines: string[], startLine = 1): string {
  const width = String(startLine + lines.length).length;
  const out: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    out.push(`${String(startLine + i).padStart(width)} | ${lines[i]}`);
  }
  return out.join("\n");
}

const IMAGE_EXTENSIONS: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp"
};

export function imageMimeFromPath(filePath: string): string | undefined {
  const lower = filePath.toLowerCase();
  for (const [extension, mime] of Object.entries(IMAGE_EXTENSIONS)) {
    if (lower.endsWith(extension)) return mime;
  }
  return undefined;
}

export function isImagePath(filePath: string): boolean {
  return imageMimeFromPath(filePath) !== undefined;
}

export async function guardBinaryFile(absolutePath: string): Promise<boolean> {
  return looksBinary(absolutePath);
}

export function clampOffsetLimit(
  offset: number | undefined,
  limit: number | undefined,
  totalLines: number
): { startLine: number; endLine: number } {
  const safeOffset = typeof offset === "number" && Number.isFinite(offset) && offset > 0 ? Math.floor(offset) : 1;
  const requestedLimit =
    typeof limit === "number" && Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : DEFAULT_READ_LIMIT;
  const maxEnd = Math.min(safeOffset - 1 + requestedLimit, totalLines);
  return { startLine: safeOffset, endLine: Math.max(maxEnd, safeOffset - 1) };
}

export function describeFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export interface PermissionSummaryInput {
  title: string;
  lines: string[];
  risk?: "low" | "medium" | "high";
}

export function buildPermissionPayload(input: PermissionSummaryInput): {
  required: boolean;
  risk: "low" | "medium" | "high";
  title: string;
  summary: string[];
} {
  return {
    required: true,
    risk: input.risk ?? "medium",
    title: input.title,
    summary: input.lines.slice(0, 8)
  };
}

export function jsonSafe(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
