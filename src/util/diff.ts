export type DiffOp = "equal" | "insert" | "delete";

export interface DiffEntry {
  op: DiffOp;
  line: string;
  oldIndex: number;
  newIndex: number;
}

const MAX_DIFF_LINES = 20000;

export function splitLines(text: string): string[] {
  if (text.length === 0) return [];
  const normalized = text.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function trimCommonPrefix(a: string[], b: string[]): number {
  let count = 0;
  while (count < a.length && count < b.length && a[count] === b[count]) count += 1;
  return count;
}

function trimCommonSuffix(a: string[], b: string[]): { oldCount: number; newCount: number } {
  let count = 0;
  while (
    count < a.length &&
    count < b.length &&
    a[a.length - 1 - count] === b[b.length - 1 - count]
  ) {
    count += 1;
  }
  return { oldCount: count, newCount: count };
}

function myersCore(a: string[], b: string[]): Array<{ op: DiffOp; line: string }> {
  const n = a.length;
  const m = b.length;

  if (n > MAX_DIFF_LINES || m > MAX_DIFF_LINES) {
    return [
      ...a.map((line) => ({ op: "delete" as DiffOp, line })),
      ...b.map((line) => ({ op: "insert" as DiffOp, line }))
    ];
  }

  if (n === 0 && m === 0) return [];
  if (n === 0) return b.map((line) => ({ op: "insert" as DiffOp, line }));
  if (m === 0) return a.map((line) => ({ op: "delete" as DiffOp, line }));

  const max = n + m;
  const offset = max;
  const v = new Int32Array(2 * max + 1);
  const trace: Int32Array[] = [];

  let foundD = -1;
  for (let d = 0; d <= max; d += 1) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])) {
        x = v[offset + k + 1];
      } else {
        x = v[offset + k - 1] + 1;
      }
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x += 1;
        y += 1;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        foundD = d;
        break;
      }
    }
    if (foundD !== -1) break;
  }

  if (foundD === -1) {
    return [
      ...a.map((line) => ({ op: "delete" as DiffOp, line })),
      ...b.map((line) => ({ op: "insert" as DiffOp, line }))
    ];
  }

  const path: Array<{ op: DiffOp; line: string }> = [];
  let x = n;
  let y = m;

  for (let d = foundD; d > 0; d -= 1) {
    const vv = trace[d];
    const k = x - y;
    let prevK: number;
    if (k === -d || (k !== d && vv[offset + k - 1] < vv[offset + k + 1])) {
      prevK = k + 1;
    } else {
      prevK = k - 1;
    }
    const prevX = vv[offset + prevK];
    const prevY = prevX - prevK;

    while (x > prevX && y > prevY) {
      path.push({ op: "equal", line: a[x - 1] ?? "" });
      x -= 1;
      y -= 1;
    }
    if (x === prevX) {
      path.push({ op: "insert", line: b[y - 1] ?? "" });
      y -= 1;
    } else {
      path.push({ op: "delete", line: a[x - 1] ?? "" });
      x -= 1;
    }
  }

  while (x > 0 && y > 0) {
    path.push({ op: "equal", line: a[x - 1] ?? "" });
    x -= 1;
    y -= 1;
  }
  while (x > 0) {
    path.push({ op: "delete", line: a[x - 1] ?? "" });
    x -= 1;
  }
  while (y > 0) {
    path.push({ op: "insert", line: b[y - 1] ?? "" });
    y -= 1;
  }

  return path.reverse();
}

export function computeLineDiff(oldText: string, newText: string): DiffEntry[] {
  const oldLines = splitLines(oldText);
  const newLines = splitLines(newText);
  const result: DiffEntry[] = [];

  const prefixTrim = trimCommonPrefix(oldLines, newLines);
  for (let i = 0; i < prefixTrim; i += 1) {
    result.push({ op: "equal", line: oldLines[i] ?? "", oldIndex: i, newIndex: i });
  }

  const coreA = oldLines.slice(prefixTrim);
  const coreB = newLines.slice(prefixTrim);
  const suffixTrim = trimCommonSuffix(coreA, coreB);

  const midA = coreA.slice(0, coreA.length - suffixTrim.oldCount);
  const midB = coreB.slice(0, coreB.length - suffixTrim.newCount);
  const coreResult = myersCore(midA, midB);

  let oldCursor = prefixTrim;
  let newCursor = prefixTrim;
  for (const entry of coreResult) {
    if (entry.op === "delete") {
      result.push({ op: "delete", line: entry.line, oldIndex: oldCursor, newIndex: -1 });
      oldCursor += 1;
    } else if (entry.op === "insert") {
      result.push({ op: "insert", line: entry.line, oldIndex: -1, newIndex: newCursor });
      newCursor += 1;
    } else {
      result.push({ op: "equal", line: entry.line, oldIndex: oldCursor, newIndex: newCursor });
      oldCursor += 1;
      newCursor += 1;
    }
  }

  for (let i = 0; i < suffixTrim.oldCount; i += 1) {
    result.push({
      op: "equal",
      line: oldLines[oldCursor] ?? "",
      oldIndex: oldCursor,
      newIndex: newCursor
    });
    oldCursor += 1;
    newCursor += 1;
  }

  return result;
}

export interface DiffStats {
  additions: number;
  deletions: number;
  unchanged: number;
}

export function diffStats(entries: DiffEntry[]): DiffStats {
  const stats: DiffStats = { additions: 0, deletions: 0, unchanged: 0 };
  for (const entry of entries) {
    if (entry.op === "insert") stats.additions += 1;
    else if (entry.op === "delete") stats.deletions += 1;
    else stats.unchanged += 1;
  }
  return stats;
}

export interface UnifiedHunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: Array<{ tag: "+" | "-" | " "; text: string }>;
}

function groupIntoRegions(changedIndexes: number[], total: number, contextSize: number): Array<{ start: number; end: number }> {
  const regions: Array<{ start: number; end: number }> = [];
  let regionStart = Math.max(changedIndexes[0] - contextSize, 0);
  let regionEnd = Math.min(changedIndexes[0] + contextSize + 1, total);

  for (let i = 1; i < changedIndexes.length; i += 1) {
    const current = changedIndexes[i];
    if (current - contextSize <= regionEnd + contextSize) {
      regionEnd = Math.min(current + contextSize + 1, total);
    } else {
      regions.push({ start: regionStart, end: regionEnd });
      regionStart = Math.max(current - contextSize, 0);
      regionEnd = Math.min(current + contextSize + 1, total);
    }
  }
  regions.push({ start: regionStart, end: regionEnd });
  return regions;
}

export function buildHunks(entries: DiffEntry[], contextSize = 3): UnifiedHunk[] {
  const changedIndexes = entries
    .map((entry, index) => (entry.op === "equal" ? -1 : index))
    .filter((index) => index !== -1);
  if (changedIndexes.length === 0) return [];

  const regions = groupIntoRegions(changedIndexes, entries.length, contextSize);
  const hunks: UnifiedHunk[] = [];

  for (const region of regions) {
    const slice = entries.slice(region.start, region.end);
    const oldLinesInRegion = slice.filter((entry) => entry.op !== "insert");
    const newLinesInRegion = slice.filter((entry) => entry.op !== "delete");
    const firstOld = oldLinesInRegion[0]?.oldIndex ?? 0;
    const firstNew = newLinesInRegion[0]?.newIndex ?? 0;
    hunks.push({
      oldStart: firstOld + 1,
      oldCount: oldLinesInRegion.length,
      newStart: firstNew + 1,
      newCount: newLinesInRegion.length,
      lines: slice.map((entry) => ({
        tag: entry.op === "insert" ? ("+" as const) : entry.op === "delete" ? ("-" as const) : (" " as const),
        text: entry.line
      }))
    });
  }

  return hunks;
}

export function renderUnifiedDiff(
  oldText: string,
  newText: string,
  options: { context?: number; filePath?: string } = {}
): string {
  const hunks = buildHunks(computeLineDiff(oldText, newText), options.context ?? 3);
  if (hunks.length === 0) return "";
  const filePath = options.filePath ?? "file";
  const out: string[] = [`--- a/${filePath}`, `+++ b/${filePath}`];

  for (const hunk of hunks) {
    out.push(`@@ -${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount} @@`);
    for (const line of hunk.lines) {
      out.push(`${line.tag}${line.text}`);
    }
  }
  return out.join("\n");
}

export interface SideBySideRow {
  left?: { text: string; kind: "same" | "removed" };
  right?: { text: string; kind: "same" | "added" };
}

export function renderSideBySide(oldText: string, newText: string): SideBySideRow[] {
  const entries = computeLineDiff(oldText, newText);
  const rows: SideBySideRow[] = [];
  let index = 0;

  while (index < entries.length) {
    const entry = entries[index];
    if (entry.op === "equal") {
      rows.push({
        left: { text: entry.line, kind: "same" },
        right: { text: entry.line, kind: "same" }
      });
      index += 1;
    } else if (entry.op === "delete") {
      const removedBatch: DiffEntry[] = [];
      while (index < entries.length && entries[index].op === "delete") {
        removedBatch.push(entries[index]);
        index += 1;
      }
      const addedBatch: DiffEntry[] = [];
      while (index < entries.length && entries[index].op === "insert") {
        addedBatch.push(entries[index]);
        index += 1;
      }
      const maxLen = Math.max(removedBatch.length, addedBatch.length);
      for (let i = 0; i < maxLen; i += 1) {
        const removed = removedBatch[i];
        const added = addedBatch[i];
        rows.push({
          left: removed ? { text: removed.line, kind: "removed" } : undefined,
          right: added ? { text: added.line, kind: "added" } : undefined
        });
      }
    } else {
      const addedBatch: DiffEntry[] = [];
      while (index < entries.length && entries[index].op === "insert") {
        addedBatch.push(entries[index]);
        index += 1;
      }
      for (const added of addedBatch) {
        rows.push({ right: { text: added.line, kind: "added" } });
      }
    }
  }

  return rows;
}
