import { buildHunks, computeLineDiff, renderUnifiedDiff, splitLines } from "./diff.js";
import type { UnifiedHunk } from "./diff.js";

export interface ParsePatchResult {
  filePath?: string;
  isNewFile: boolean;
  isDeleteFile: boolean;
  hunks: UnifiedHunk[];
}

export function parseUnifiedPatch(patchText: string): ParsePatchResult {
  const lines = splitLines(patchText.replace(/\r\n/g, "\n"));
  const result: ParsePatchResult = {
    isNewFile: false,
    isDeleteFile: false,
    hunks: []
  };

  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (line.startsWith("--- ")) {
      const oldPath = normalizePatchPath(line.slice(4).trim());
      const plusLine = lines[index + 1] ?? "";
      if (plusLine.startsWith("+++ ")) {
        const newPath = normalizePatchPath(plusLine.slice(4).trim());
        result.isNewFile = oldPath === "/dev/null";
        result.isDeleteFile = newPath === "/dev/null";
        result.filePath = result.isNewFile ? newPath : result.isDeleteFile ? oldPath : (newPath !== "unknown" ? newPath : oldPath);
        index += 2;
      } else {
        result.filePath = oldPath;
        index += 1;
      }
      continue;
    }

    if (line.startsWith("@@")) {
      const match = /^@@\s*-(\d+)(?:,(\d+))?\s*\+(\d+)(?:,(\d+))?\s*@/.exec(line);
      if (!match) {
        index += 1;
        continue;
      }
      const hunk: UnifiedHunk = {
        oldStart: Number.parseInt(match[1], 10),
        oldCount: match[2] !== undefined ? Number.parseInt(match[2], 10) : 1,
        newStart: Number.parseInt(match[3], 10),
        newCount: match[4] !== undefined ? Number.parseInt(match[4], 10) : 1,
        lines: []
      };
      index += 1;
      let seenOld = 0;
      let seenNew = 0;
      while (index < lines.length) {
        const body = lines[index] ?? "";
        if (body.startsWith("@@") || body.startsWith("--- ") || body.startsWith("diff ") || body.startsWith("Index: ")) {
          break;
        }
        if (body.startsWith("+")) {
          hunk.lines.push({ tag: "+", text: body.slice(1) });
          seenNew += 1;
        } else if (body.startsWith("-")) {
          hunk.lines.push({ tag: "-", text: body.slice(1) });
          seenOld += 1;
        } else if (body.startsWith(" ")) {
          hunk.lines.push({ tag: " ", text: body.slice(1) });
          seenOld += 1;
          seenNew += 1;
        } else if (body === "") {
          hunk.lines.push({ tag: " ", text: "" });
          seenOld += 1;
          seenNew += 1;
        } else if (body.startsWith("\\")) {
        } else {
          break;
        }
        index += 1;
        if (
          hunk.oldCount > 0 &&
          hunk.newCount > 0 &&
          seenOld >= hunk.oldCount &&
          seenNew >= hunk.newCount
        ) {
          break;
        }
      }
      result.hunks.push(hunk);
      continue;
    }

    index += 1;
  }

  return result;
}

function normalizePatchPath(raw: string): string {
  let path = raw;
  const tabIndex = path.indexOf("\t");
  if (tabIndex !== -1) path = path.slice(0, tabIndex).trim();
  if (path === "/dev/null") return "/dev/null";
  if (path.startsWith("a/")) path = path.slice(2);
  else if (path.startsWith("b/")) path = path.slice(2);
  return path.replace(/\\/g, "/");
}

export interface ApplyPatchOutcome {
  success: boolean;
  newText: string;
  appliedHunks: number[];
  rejectedHunks: number[];
  notes: string[];
}

export function applyUnifiedPatch(originalText: string, hunks: UnifiedHunk[], maxFuzz = 3): ApplyPatchOutcome {
  const working = splitLines(originalText);
  const outcome: ApplyPatchOutcome = {
    success: true,
    newText: originalText,
    appliedHunks: [],
    rejectedHunks: [],
    notes: []
  };

  let offset = 0;
  const sorted = [...hunks].sort((a, b) => a.oldStart - b.oldStart);

  for (let hunkIndex = 0; hunkIndex < sorted.length; hunkIndex += 1) {
    const hunk = sorted[hunkIndex];
    const desiredStart = hunk.oldStart - 1 + offset;
    const removals = hunk.lines.filter((l) => l.tag !== "+").map((l) => l.text);
    const additions = hunk.lines.filter((l) => l.tag !== "-").map((l) => l.text);

    let located = locateHunk(working, removals, desiredStart, maxFuzz);
    if (!located) {
      outcome.rejectedHunks.push(hunkIndex);
      outcome.success = false;
      outcome.notes.push(`hunk #${hunkIndex + 1} could not be applied near line ${hunk.oldStart}`);
      continue;
    }

    if (located.fuzzyDistance > 0) {
      outcome.notes.push(`hunk #${hunkIndex + 1} applied with fuzz ${located.fuzzyDistance}`);
    }

    const before = working.slice(0, located.startIndex);
    const after = working.slice(located.endIndexExclusive);
    const merged = [...before, ...additions, ...after];
    offset += additions.length - removals.length;
    working.length = 0;
    working.push(...merged);
    outcome.appliedHunks.push(hunkIndex);
  }

  outcome.newText = working.join("\n") + (originalText.endsWith("\n") || working.length === 0 ? "\n" : "");
  if (outcome.newText === "\n" && originalText.length === 0) outcome.newText = "";
  return outcome;
}

interface LocatedHunk {
  startIndex: number;
  endIndexExclusive: number;
  fuzzyDistance: number;
}

function locateHunk(lines: string[], removals: string[], desiredStart: number, maxFuzz: number): LocatedHunk | null {
  if (removals.length === 0) {
    const clamped = Math.max(Math.min(desiredStart, lines.length), 0);
    return { startIndex: clamped, endIndexExclusive: clamped, fuzzyDistance: 0 };
  }

  for (let fuzz = 0; fuzz <= maxFuzz; fuzz += 1) {
    const candidates = collectCandidates(lines, removals, desiredStart, fuzz);
    if (candidates.length > 0) {
      return candidates[0];
    }
  }
  return null;
}

function collectCandidates(
  lines: string[],
  removals: string[],
  desiredStart: number,
  fuzz: number
): LocatedHunk[] {
  const results: LocatedHunk[] = [];
  const tolerance = removals.length * fuzz;

  for (let attemptOffset = 0; attemptOffset <= tolerance || attemptOffset === 0; attemptOffset += 1) {
    for (const direction of attemptOffset === 0 ? ([0] as const) : ([-1, 1] as const)) {
      const startCandidate = desiredStart + direction * attemptOffset;
      if (startCandidate < 0 || startCandidate + removals.length > lines.length) continue;
      let mismatches = 0;
      let ok = true;
      for (let i = 0; i < removals.length; i += 1) {
        if ((lines[startCandidate + i] ?? "") !== removals[i]) {
          mismatches += 1;
          if (mismatches > fuzz) {
            ok = false;
            break;
          }
        }
      }
      if (ok) {
        results.push({
          startIndex: startCandidate,
          endIndexExclusive: startCandidate + removals.length,
          fuzzyDistance: fuzz
        });
      }
    }
    if (attemptOffset >= lines.length) break;
  }

  results.sort((a, b) => Math.abs(a.startIndex - desiredStart) - Math.abs(b.startIndex - desiredStart));
  return results;
}

export interface EditOperation {
  oldText: string;
  newText: string;
  replaceAll?: boolean;
}

export function applyExactEdits(original: string, operations: EditOperation[]): { result: string; applied: number } {
  let working = original;
  let applied = 0;

  for (const operation of operations) {
    const occurrences = countOccurrences(working, operation.oldText);
    if (occurrences === 0) continue;
    if (operation.replaceAll) {
      working = replaceAllOccurrences(working, operation.oldText, operation.newText);
      applied += occurrences;
    } else {
      if (occurrences > 1) {
        const firstIndex = working.indexOf(operation.oldText);
        working =
          working.slice(0, firstIndex) +
          operation.newText +
          working.slice(firstIndex + operation.oldText.length);
        applied += 1;
      } else {
        working = working.replace(operation.oldText, () => operation.newText);
        applied += 1;
      }
    }
  }

  return { result: working, applied };
}

export function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let position = haystack.indexOf(needle);
  while (position !== -1) {
    count += 1;
    position = haystack.indexOf(needle, position + needle.length);
  }
  return count;
}

function replaceAllOccurrences(source: string, from: string, to: string): string {
  let out = "";
  let rest = source;
  for (;;) {
    const index = rest.indexOf(from);
    if (index === -1) {
      out += rest;
      break;
    }
    out += rest.slice(0, index) + to;
    rest = rest.slice(index + from.length);
  }
  return out;
}

export function previewEditDiff(original: string, updated: string, filePath: string): string {
  return renderUnifiedDiff(original, updated, { filePath, context: 3 });
}

export function summarizeChanges(original: string, updated: string): { additions: number; deletions: number } {
  const hunks = buildHunks(computeLineDiff(original, updated), 0);
  let additions = 0;
  let deletions = 0;
  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      if (line.tag === "+") additions += 1;
      else if (line.tag === "-") deletions += 1;
    }
  }
  return { additions, deletions };
}
