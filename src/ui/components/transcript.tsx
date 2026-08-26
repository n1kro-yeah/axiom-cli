import { Box, Static, Text, useWindowSize } from "ink";
import { memo, useEffect, useMemo, useState } from "react";
import { clipTextToRows, firstMutableBubbleIndex } from "../transcript.js";
import type { AssistantBubble, Bubble, DiffRow, ToolBubble } from "../transcript.js";
import { useTheme } from "../theme.js";
import { renderMarkdown } from "../markdown.js";
import { computeLineDiff } from "../../util/diff.js";
import { Logo } from "./logo.js";

const SPINNER_FRAMES = ["|", "/", "-", "\\"];

function Spinner(): React.ReactElement {
  const { theme } = useTheme();
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => {
      setFrame((current) => (current + 1) % SPINNER_FRAMES.length);
    }, 80);
    return () => clearInterval(timer);
  }, []);

  return <Text color={theme.accentBright}>{SPINNER_FRAMES[frame] ?? "·"}</Text>;
}

const HEADER = { kind: "header" } as const;
type StaticItem = typeof HEADER | Bubble;

interface TranscriptProps {
  bubbles: Bubble[];
  workspace: string;
  maxLiveRows: number;
}

export const Transcript = memo(function Transcript({ bubbles, workspace, maxLiveRows }: TranscriptProps) {
  const liveAt = firstMutableBubbleIndex(bubbles);
  const stableCount = liveAt === -1 ? bubbles.length : liveAt;
  const stable = bubbles.slice(0, stableCount);
  const live = liveAt === -1 ? [] : bubbles.slice(liveAt);

  const staticItems: StaticItem[] = useMemo(
    () => [HEADER, ...stable],
    [stable]
  );

  return (
    <Box flexDirection="column" marginBottom={0} flexShrink={1} minHeight={0} overflowY="hidden">
      <Static items={staticItems}>
        {(item) =>
          item.kind === "header" ? (
            <Logo key="axiom-header" workspace={workspace} />
          ) : (
            <BubbleView key={item.id} bubble={item} />
          )
        }
      </Static>

      <Box
        flexDirection="column"
        flexShrink={1}
        minHeight={0}
        maxHeight={maxLiveRows}
        overflowY="hidden"
        justifyContent="flex-end"
      >
        {live.map((bubble) => (
          <BubbleView key={bubble.id} bubble={bubble} maxRows={maxLiveRows} />
        ))}
      </Box>
    </Box>
  );
});

const BubbleView = memo(function BubbleView({ bubble, maxRows }: { bubble: Bubble; maxRows?: number }): React.ReactElement {
  if (bubble.kind === "user") return <UserView bubble={bubble} />;
  if (bubble.kind === "notice") return <NoticeView bubble={bubble} />;
  if (bubble.kind === "assistant") return <AssistantView bubble={bubble} maxRows={maxRows} />;
  return <ToolView bubble={bubble} />;
});

function UserView({ bubble }: { bubble: Extract<Bubble, { kind: "user" }> }): React.ReactElement {
  const { theme } = useTheme();
  const firstLine = bubble.text.split("\n")[0];
  const rest = bubble.text.slice(firstLine.length).trimStart();

  return (
    <Box flexDirection="column" marginTop={1}>
      <Text>
        <Text color={theme.accent} bold>
          {"> "}
        </Text>
        <Text color={theme.textPrimary} bold wrap="wrap">
          {firstLine}
        </Text>
      </Text>
      {rest ? (
        <Box paddingLeft={2}>
          <Text dimColor wrap="wrap">
            {rest.length > 300 ? `${rest.slice(0, 300)}...` : rest}
          </Text>
        </Box>
      ) : null}
    </Box>
  );
}

function NoticeView({ bubble }: { bubble: Extract<Bubble, { kind: "notice" }> }): React.ReactElement {
  const { theme } = useTheme();
  const color = bubble.level === "error" ? theme.error : bubble.level === "warn" ? theme.warning : theme.accent;
  const firstLine = bubble.text.split("\n")[0];

  return (
    <Box marginTop={1}>
      <Text color={color} wrap="wrap">
        {firstLine}
      </Text>
    </Box>
  );
}

const AssistantView = memo(function AssistantView({
  bubble,
  maxRows
}: {
  bubble: AssistantBubble;
  maxRows?: number;
}): React.ReactElement {
  const { theme } = useTheme();
  const { columns } = useWindowSize();

  const thinkingLines = bubble.thinking.trim();
  const budget = bubble.streaming && maxRows !== undefined ? Math.max(1, maxRows - 2) : undefined;

  const frameThinking =
    budget === undefined ? thinkingLines : clipTextToRows(thinkingLines, Math.min(3, Math.max(0, budget - 1)), columns);
  const usedThinking = frameThinking === "" ? 0 : frameThinking.split("\n").length;
  const frameText = budget === undefined ? bubble.text : clipTextToRows(bubble.text, Math.max(1, budget - usedThinking), columns);

  return (
    <Box flexDirection="column" marginTop={1}>
      {frameThinking !== "" ? (
        <Text dimColor italic wrap="wrap">
          {frameThinking}
        </Text>
      ) : null}

      {bubble.streaming ? (
        bubble.text === "" ? (
          <Text dimColor>
            <Spinner /> thinking
          </Text>
        ) : (
          <Text wrap="wrap">{frameText}</Text>
        )
      ) : (
        <Box flexDirection="column" paddingLeft={2}>
          {renderMarkdown(bubble.text).lines.map((line, index) => (
            <SegmentLine key={index} line={line} />
          ))}
        </Box>
      )}
    </Box>
  );
});

const ToolView = memo(function ToolView({ bubble }: { bubble: ToolBubble }): React.ReactElement {
  const { theme } = useTheme();
  const mark = bubble.state === "running" ? "..." : bubble.state === "ok" ? "+" : "x";
  const color =
    bubble.state === "error" ? theme.error : bubble.state === "denied" ? theme.warning : bubble.state === "ok" ? theme.ok : theme.warning;

  const diffRows = bubble.diffRows;
  const hasDiff = diffRows !== null && diffRows.length > 0;

  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color={color} wrap="truncate-end">
        {mark} {bubble.summary}
        {hasDiff && bubble.added > 0 ? (
          <Text color={theme.ok} bold>
            {" "}
            +{bubble.added}
          </Text>
        ) : null}
        {hasDiff && bubble.removed > 0 ? (
          <Text color={theme.error} bold>
            {" "}
            -{bubble.removed}
          </Text>
        ) : null}
      </Text>

      {bubble.state === "running" && bubble.progress.length > 0 ? (
        <Box flexDirection="column" marginLeft={3}>
          {bubble.progress.slice(-2).map((line, index) => (
            <Text key={index} dimColor wrap="truncate-end">
              {line.slice(0, 130)}
            </Text>
          ))}
        </Box>
      ) : null}

      {hasDiff ? (
        <Box flexDirection="column" marginLeft={3}>
          <DiffRowsView rows={diffRows} />
        </Box>
      ) : null}

      {!hasDiff && bubble.state !== "running" && bubble.preview && bubble.preview.length > 0 ? (
        <Box flexDirection="column" marginLeft={3}>
          {bubble.preview.map((line, index) => (
            <Text key={index} dimColor={bubble.preview !== null && (index < bubble.preview.length - 1 || !bubble.isError)} color={bubble.preview !== null && index === bubble.preview.length - 1 && bubble.isError ? theme.error : undefined} wrap="truncate-end">
              {line.length > 130 ? `${line.slice(0, 127)}...` : line}
            </Text>
          ))}
        </Box>
      ) : null}
    </Box>
  );
});

function DiffRowsView({ rows }: { rows: DiffRow[] }): React.ReactElement {
  const { theme } = useTheme();
  const visible = rows.slice(0, 24);

  return (
    <Box flexDirection="column">
      {visible.map((row, index) => (
        <Text
          key={index}
          color={
            row.tag === "+"
              ? theme.diffAdd
              : row.tag === "-"
                ? theme.diffDel
                : row.tag === "@"
                  ? theme.diffMeta
                  : theme.textFaint
          }
          wrap="truncate-end"
        >
          {row.tag === "@" ? row.text : `${row.tag} ${row.text}`.slice(0, 160)}
        </Text>
      ))}
      {rows.length > visible.length ? <Text dimColor>... {rows.length - visible.length} more</Text> : null}
    </Box>
  );
}

export function SegmentLine({ line }: { line: ReturnType<typeof renderMarkdown>["lines"][number] }): React.ReactElement {
  const { theme } = useTheme();

  if (line.length === 0) return <Text> </Text>;

  const firstStyle = line[0]?.style ?? "plain";

  if (firstStyle === "heading1") {
    return (
      <Text bold color={theme.accentBright}>
        {line.map((segment) => segment.text).join("")}
      </Text>
    );
  }
  if (firstStyle === "heading2") {
    return (
      <Text bold color={theme.accent}>
        {line.map((segment) => segment.text).join("")}
      </Text>
    );
  }
  if (firstStyle === "heading3") {
    return (
      <Text bold color={theme.textPrimary}>
        {line.map((segment) => segment.text).join("")}
      </Text>
    );
  }
  if (firstStyle === "hr") {
    return <Text dimColor>{line.map((segment) => segment.text).join("")}</Text>;
  }
  if (firstStyle === "code") {
    return (
      <Text backgroundColor="#111827" color={theme.success}>
        {line.map((segment) => segment.text).join("")}
      </Text>
    );
  }
  if (firstStyle === "quote") {
    return (
      <Text color={theme.textSecondary} italic>
        {line.map((segment) => segment.text).join("")}
      </Text>
    );
  }

  return (
    <Text wrap="wrap">
      {line.map((segment, index) => (
        <InlineSegment key={index} text={segment.text} style={segment.style} />
      ))}
    </Text>
  );
}

function InlineSegment({ text, style }: { text: string; style: string }): React.ReactElement {
  const { theme } = useTheme();

  switch (style) {
    case "bold":
      return <Text bold>{text}</Text>;
    case "italic":
      return (
        <Text italic dimColor>
          {text}
        </Text>
      );
    case "code":
      return <Text color={theme.success}>{text}</Text>;
    case "link":
      return (
        <Text color={theme.info} underline>
          {text}
        </Text>
      );
    default:
      return <Text>{text}</Text>;
  }
}

export function diffStatsQuick(before: string, after: string): { added: number; removed: number } {
  const rows = computeLineDiff(before, after);
  let added = 0;
  let removed = 0;
  for (const row of rows) {
    if (row.op === "insert") added += 1;
    else if (row.op === "delete") removed += 1;
  }
  return { added, removed };
}

