import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { AxiomPaths } from "../config/paths.js";
import { localRulesCandidate, ruleCandidatesForRoot, userRulesCandidate } from "../config/paths.js";

const MAX_TOTAL_RULES_CHARS = 48000;
const MAX_SINGLE_FILE_CHARS = 24000;

export interface RulesLoadResult {
  combined: string;
  sources: Array<{ path: string; lines: number; chars: number; tier: "user" | "project" | "local" | "rules-dir" }>;
  truncatedFiles: number;
}

interface RuleSourcePlan {
  path: string;
  tier: "user" | "project" | "local" | "rules-dir";
}

export function planRuleSources(paths: AxiomPaths, projectTrusted: boolean): RuleSourcePlan[] {
  const plan: RuleSourcePlan[] = [
    { path: userRulesCandidate(paths.homeDir), tier: "user" }
  ];

  for (const candidate of ruleCandidatesForRoot(paths.projectRoot)) {
    plan.push({ path: candidate, tier: "project" });
  }
  plan.push({ path: localRulesCandidate(paths.projectRoot), tier: "local" });

  if (projectTrusted && existsSync(paths.projectRulesDir)) {
    plan.push({ path: paths.projectRulesDir, tier: "rules-dir" });
  }

  return plan.filter((entry) => existsSync(entry.path));
}

export async function loadRules(paths: AxiomPaths, projectTrusted: boolean): Promise<RulesLoadResult> {
  const plan = planRuleSources(paths, projectTrusted);
  const sources: RulesLoadResult["sources"] = [];
  const chunks: string[] = [];
  let totalChars = 0;
  let truncatedFiles = 0;

  for (const entry of plan) {
    const contents = entry.tier === "rules-dir" ? await readRulesDirectory(entry.path) : [await safeRead(entry.path)];

    for (const content of contents) {
      if (content === null || content.trim().length === 0) continue;

      let effective = content;
      if (effective.length > MAX_SINGLE_FILE_CHARS) {
        effective = `${effective.slice(0, MAX_SINGLE_FILE_CHARS)}\n\n[…file truncated at ${MAX_SINGLE_FILE_CHARS} chars]`;
        truncatedFiles += 1;
      }

      if (totalChars + effective.length > MAX_TOTAL_RULES_CHARS) {
        const remaining = MAX_TOTAL_RULES_CHARS - totalChars;
        if (remaining < 500) break;
        effective = `${effective.slice(0, remaining)}\n\n[…rules budget exhausted]`;
        truncatedFiles += 1;
      }

      totalChars += effective.length;
      chunks.push(`<!-- rules: ${labelPath(entry.path)} (${entry.tier}) -->\n${effective}`);
      sources.push({
        path: entry.path,
        lines: effective.split("\n").length,
        chars: effective.length,
        tier: entry.tier
      });
    }
  }

  return {
    combined: chunks.join("\n\n"),
    sources,
    truncatedFiles
  };
}

async function readRulesDirectory(dir: string): Promise<Array<string | null>> {
  const { readdir } = await import("node:fs/promises");
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [null];
  }

  const files = entries
    .filter((entry) => entry.isFile() && /\.(md|txt)$/i.test(entry.name))
    .map((entry) => entry.name)
    .sort();

  const contents: Array<string | null> = [];
  for (const file of files) {
    contents.push(await safeRead(join(dir, file)));
  }
  return contents.length > 0 ? contents : [null];
}

async function safeRead(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

function labelPath(path: string): string {
  const segments = path.split(/[\\/]/);
  const depth = Math.min(segments.length, 3);
  return segments.slice(-depth).join("/");
}

export function describeRulesSources(result: RulesLoadResult): string {
  if (result.sources.length === 0) return "no rules files found";
  return result.sources.map((source) => `${source.tier}: ${labelPath(source.path)} (${source.lines}L)`).join(", ");
}
