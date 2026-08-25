import { readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { SkillEntry, SkillFrontmatter } from "../types.js";
import { createLogger } from "../util/log.js";

const log = createLogger("skills");

const SKILL_FILE_NAME = "SKILL.md";
const MAX_BODY_CHARS = 60000;

export function parseFrontmatter(rawText: string): { frontmatter: Record<string, unknown>; body: string } {
  const normalized = rawText.replace(/\r\n/g, "\n");

  if (!normalized.startsWith("---")) {
    return { frontmatter: {}, body: normalized };
  }

  const closingIndex = findClosingFence(normalized);
  if (closingIndex === -1) {
    return { frontmatter: {}, body: normalized };
  }

  const headerBlock = normalized.slice(4, closingIndex);
  const body = normalized.slice(closingIndex + 4).replace(/^\n+/, "");

  return { frontmatter: parseSimpleYaml(headerBlock), body };
}

function findClosingFence(text: string): number {
  let searchFrom = 3;
  for (;;) {
    const candidate = text.indexOf("\n---", searchFrom);
    if (candidate === -1) return -1;
    const after = text[candidate + 4];
    if (after === "\n" || after === undefined || after === "\r") {
      return candidate + 1;
    }
    searchFrom = candidate + 1;
  }
}

export function parseSimpleYaml(block: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  let currentListKey: string | null = null;

  for (const rawLine of block.split("\n")) {
    const line = rawLine.replace(/\t/g, "  ");
    if (line.trim().length === 0 || line.trim().startsWith("#")) continue;

    const listItemMatch = /^\s+-\s+(.*)$/.exec(line);
    if (listItemMatch && currentListKey) {
      const existing = result[currentListKey];
      const list = Array.isArray(existing) ? existing : [];
      list.push(scalar(listItemMatch[1]));
      result[currentListKey] = list;
      continue;
    }

    const pairMatch = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line.trim());
    if (!pairMatch) continue;

    const key = pairMatch[1];
    const valuePart = pairMatch[2]?.trim() ?? "";

    currentListKey = null;

    if (valuePart.length === 0) {
      currentListKey = key;
      result[key] = [];
      continue;
    }

    if (valuePart.startsWith("[") && valuePart.endsWith("]")) {
      result[key] = valuePart
        .slice(1, -1)
        .split(",")
        .map((entry) => scalar(entry))
        .filter((entry) => String(entry).length > 0);
      continue;
    }

    result[key] = scalar(valuePart);
  }

  return result;
}

function scalar(raw: string): string | boolean | number {
  const trimmed = raw.trim().replace(/^["']|["']$/g, "");
  if (/^(true|yes)$/i.test(trimmed)) return true;
  if (/^(false|no)$/i.test(trimmed)) return false;
  if (/^-?\d+$/.test(trimmed)) return Number.parseInt(trimmed, 10);
  return trimmed;
}

function toFrontmatter(source: Record<string, unknown>, fallbackName: string): SkillFrontmatter {
  const name =
    typeof source["name"] === "string" && source["name"].trim().length > 0
      ? source["name"].trim()
      : fallbackName;
  const description =
    typeof source["description"] === "string"
      ? source["description"]
      : "(no description provided)";

  const frontmatter: SkillFrontmatter = { name, description };

  if (Array.isArray(source["allowed-tools"])) {
    frontmatter.allowedTools = source["allowed-tools"].map((entry) => String(entry));
  } else if (Array.isArray(source["allowedTools"])) {
    frontmatter.allowedTools = source["allowedTools"].map((entry) => String(entry));
  }

  if (source["disable-model-invocation"] === true || source["disableModelInvocation"] === true) {
    frontmatter.disableModelInvocation = true;
  }

  return frontmatter;
}

export async function loadSkills(globalSkillsDir: string, projectSkillsDir: string): Promise<SkillEntry[]> {
  const global = await loadFromDirectory(globalSkillsDir, "global");
  const project = await loadFromDirectory(projectSkillsDir, "project");

  const merged = new Map<string, SkillEntry>();
  for (const entry of global) merged.set(entry.name, entry);
  for (const entry of project) merged.set(entry.name, entry);

  return [...merged.values()].sort((a, b) => a.name.localeCompare(b.name));
}

async function loadFromDirectory(dir: string, scope: "global" | "project"): Promise<SkillEntry[]> {
  if (!existsSync(dir)) return [];

  const entries: SkillEntry[] = [];
  let dirents;
  try {
    dirents = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  for (const dirent of dirents) {
    if (!dirent.isDirectory()) continue;

    const skillFile = join(dir, dirent.name, SKILL_FILE_NAME);
    if (!existsSync(skillFile)) continue;

    try {
      const raw = await readFile(skillFile, "utf8");
      const { frontmatter, body } = parseFrontmatter(raw);
      const parsed = toFrontmatter(frontmatter, dirent.name);

      entries.push({
        name: slugifyName(parsed.name),
        description: parsed.description.slice(0, 1200),
        body: body.slice(0, MAX_BODY_CHARS),
        frontmatter: parsed,
        scope,
        path: skillFile
      });
    } catch (error) {
      log.warn(`failed to load skill at ${skillFile}`, error);
    }
  }

  return entries;
}

export function slugifyName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64) || "unnamed-skill";
}
