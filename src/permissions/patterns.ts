import type { PermissionDecision, PermissionMode, PermissionRequest, PermissionRule } from "../types.js";
import { matchGlobPath } from "../util/fuzzy.js";

export function ruleKey(tool: string, pattern?: string): string {
  return `${tool}::${pattern ?? "*"}`;
}

export function splitRuleKey(key: string): [string, string] {
  const index = key.indexOf("::");
  if (index === -1) return [key, "*"];
  return [key.slice(0, index), key.slice(index + 2)];
}

export function requestSummaryPattern(request: Omit<PermissionRequest, "id">): string | undefined {
  if (request.tool === "bash" || request.tool === "fetch" || request.tool === "task") {
    const firstLine = request.summary[0] ?? "";
    if (request.tool === "fetch") {
      try {
        const host = new URL(firstLine).host;
        return `fetch:${host}`;
      } catch {
        return "fetch:*";
      }
    }
    if (request.tool === "task") {
      const typeLine = request.summary.find((line) => line.startsWith("type:"));
      return `task:${typeLine?.slice(5).trim() ?? "*"}`;
    }
    const words = firstLine.split(/\s+/).filter(Boolean);
    if (words.length >= 2) return `bash:${words[0]} ${words[1]}`;
    if (words.length === 1) return `bash:${words[0]}`;
    return undefined;
  }

  const pathLine = request.summary.find((line) => /^File:|^path:/i.test(line) || /^[^\s]+\.[a-z0-9]{1,6}$/i.test(line.split(" ")[0]));
  const candidate = pathLine ?? request.summary[0];
  if (!candidate) return undefined;
  const token = candidate.replace(/^File:\s*/i, "").split(/\s+/)[0];
  return `${request.tool}:${token}`;
}

export function matchesPattern(rulePattern: string, candidate: string): boolean {
  const normalizedRule = normalize(rulePattern);
  const normalizedCandidate = normalize(candidate);

  if (normalizedRule === normalizedCandidate) return true;

  const colonIndex = normalizedRule.indexOf(":");
  if (colonIndex !== -1) {
    const ruleTool = normalizedRule.slice(0, colonIndex);
    const ruleValue = normalizedRule.slice(colonIndex + 1);
    const candidateColon = normalizedCandidate.indexOf(":");
    if (candidateColon !== -1) {
      const candidateTool = normalizedCandidate.slice(0, candidateColon);
      const candidateValue = normalizedCandidate.slice(candidateColon + 1);
      if (ruleTool !== candidateTool && ruleTool !== "*") return false;
      if (matchGlobPath(candidateValue, ruleValue)) return true;
      if (matchGlobPath(normalizedCandidate, normalizedRule)) return true;
      if (/\/\*$/.test(ruleValue)) {
        return matchGlobPath(candidateValue, `${ruleValue.slice(0, -1)}**`);
      }
      return false;
    }
    return matchGlobPath(normalizedCandidate, normalizedRule);
  }

  const candidateColonIndex = normalizedCandidate.indexOf(":");
  if (candidateColonIndex !== -1) {
    const candidateValueOnly = normalizedCandidate.slice(candidateColonIndex + 1);
    if (matchGlobPath(candidateValueOnly, normalizedRule)) return true;
  }

  return matchGlobPath(normalizedCandidate, normalizedRule);
}

function normalize(value: string): string {
  return value.trim().replace(/\\/g, "/").replace(/^\.\/+/, "");
}

export function specificityOf(pattern: string): number {
  const stars = (pattern.match(/\*/g) ?? []).length;
  return pattern.length - stars * 4 + (pattern.includes("*") ? 0 : 10);
}

export function sortedBySpecificity(matches: Array<{ rule: PermissionRule; specificity: number }>): Array<{ rule: PermissionRule; specificity: number }> {
  return [...matches].sort((a, b) => b.specificity - a.specificity);
}

export interface DecisionTraceEntry {
  timestamp: number;
  tool: string;
  pattern?: string;
  decision: PermissionDecision | "rule_allow" | "rule_deny" | "mode_auto";
  mode: PermissionMode;
}

export class DecisionAuditLog {
  private entries: DecisionTraceEntry[] = [];
  private readonly capacity: number;

  constructor(capacity = 500) {
    this.capacity = capacity;
  }

  record(entry: Omit<DecisionTraceEntry, "timestamp">): void {
    this.entries.push({ ...entry, timestamp: Date.now() });
    if (this.entries.length > this.capacity) {
      this.entries.splice(0, this.entries.length - this.capacity);
    }
  }

  recent(count: number): DecisionTraceEntry[] {
    return this.entries.slice(-count);
  }

  dump(): DecisionTraceEntry[] {
    return [...this.entries];
  }
}
