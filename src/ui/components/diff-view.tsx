import React, { useMemo } from "react";
import { Box, Text } from "ink";
import { computeLineDiff, renderSideBySide, splitLines } from "../../util/diff.js";
import type { DiffStats } from "../../util/diff.js";
import { diffStats } from "../../util/diff.js";
import { useTheme } from "../theme.js";

export interface DiffViewProps {
  before: string;
  after: string;
  filePath?: string;
  mode?: "unified" | "split";
  maxLines?: number;
  showLineNumbers?: boolean;
}

export function DiffView(props: DiffViewProps): React.ReactElement {
  const { theme } = useTheme();
  const mode = props.mode ?? "unified";
  const maxLines = props.maxLines ?? 120;

  const unifiedLines = useMemo(() => {
    const entries = computeLineDiff(props.before, props.after);
    return entries.slice(0, maxLines);
  }, [props.before, props.after, maxLines]);

  const stats = useMemo<DiffStats>(() => {
    return diffStats(computeLineDiff(props.before, props.after));
  }, [props.before, props.after]);

  if (stats.additions === 0 && stats.deletions === 0) {
    return (
      <Text color={theme.textDim}>
        no textual changes{props.filePath ? ` in ${props.filePath}` : ""}
      </Text>
    );
  }

  if (mode === "split") {
    const rows = renderSideBySide(props.before, props.after);
    const halfWidth = Math.max(Math.floor((props.filePath?.length ?? 20) / 2), 30);

    return (
      <Box flexDirection="column">
        <Summary stats={stats} filePath={props.filePath} />
        <Box flexDirection="column" marginTop={0}>
          {rows.slice(0, Math.floor(maxLines / 2)).map((row, index) => {
            const left = row.left;
            const right = row.right;
            return (
              <Box key={index}>
                <Box width={halfWidth}>
                  <Text
                    color={left?.kind === "removed" ? theme.diffDel : theme.textDim}
                    backgroundColor={left?.kind === "removed" ? undefined : undefined}
                  >
                    {(left ? `- ${left.text}` : "").padEnd(halfWidth).slice(0, halfWidth)}
                  </Text>
                </Box>
                <Box width={halfWidth}>
                  <Text color={right?.kind === "added" ? theme.diffAdd : theme.textDim}>
                    {(right ? `+ ${right.text}` : "").padEnd(halfWidth).slice(0, halfWidth)}
                  </Text>
                </Box>
              </Box>
            );
          })}
        </Box>
      </Box>
    );
  }

  let oldNumber = 1;
  let newNumber = 1;
  const rendered: React.ReactElement[] = [];

  for (const [index, entry] of unifiedLines.entries()) {
    const lineNo =
      entry.op === "delete"
        ? `${String(oldNumber).padStart(4)}      `
        : entry.op === "insert"
          ? `      ${String(newNumber).padStart(4)}`
          : `${String(oldNumber).padStart(4)} ${String(newNumber).padStart(4)}`;

    const sign = entry.op === "insert" ? "+" : entry.op === "delete" ? "-" : " ";
    const color =
      entry.op === "insert" ? theme.diffAdd : entry.op === "delete" ? theme.diffDel : theme.textFaint;

    if (entry.op === "equal") oldNumber += 1;
    if (entry.op === "equal") newNumber += 1;
    if (entry.op === "delete") oldNumber += 1;
    if (entry.op === "insert") newNumber += 1;

    rendered.push(
      <Text key={index} color={color}>
        {props.showLineNumbers === false ? "" : lineNo}
        {sign}
        {truncateCell(entry.line)}
      </Text>
    );
  }

  if (unifiedLines.length >= maxLines) {
    rendered.push(
      <Text key="more" dimColor>
        … diff truncated at {maxLines} lines
      </Text>
    );
  }

  return (
    <Box flexDirection="column">
      <Summary stats={stats} filePath={props.filePath} />
      <Box flexDirection="column">{rendered}</Box>
    </Box>
  );
}

function Summary({ stats, filePath }: { stats: DiffStats; filePath?: string }): React.ReactElement {
  const { theme } = useTheme();
  return (
    <Box marginBottom={0} gap={2}>
      {filePath ? <Text bold color={theme.accentBright}>{filePath}</Text> : null}
      <Text color={theme.diffDel}>-{stats.deletions}</Text>
      <Text color={theme.diffAdd}>+{stats.additions}</Text>
    </Box>
  );
}

function truncateCell(line: string, limit = 160): string {
  const clean = line.replace(/\t/g, "  ");
  return clean.length <= limit ? clean : `${clean.slice(0, limit - 1)}…`;
}

export function InlineEditPreview({
  before,
  after,
  filePath,
  collapsed
}: {
  before: string;
  after: string;
  filePath: string;
  collapsed: boolean;
}): React.ReactElement {
  if (collapsed) {
    const stats = diffStats(computeLineDiff(before, after));
    return (
      <Text dimColor>
        {filePath}: +{stats.additions}/-{stats.deletions}
      </Text>
    );
  }
  return <DiffView before={before} after={after} filePath={filePath} maxLines={60} />;
}

export function summarizeFileChanges(before: string, after: string): string {
  const beforeLines = splitLines(before).length;
  const afterLines = splitLines(after).length;
  const delta = afterLines - beforeLines;
  if (delta === 0) return `${afterLines} lines (unchanged count)`;
  return `${beforeLines} → ${afterLines} lines (${delta > 0 ? "+" : ""}${delta})`;
}
