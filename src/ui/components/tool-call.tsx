import React, { useMemo } from "react";
import { Box, Text } from "ink";
import type { Part } from "../../types.js";
import { useTheme } from "../theme.js";
import { InlineEditPreview } from "./diff-view.js";

export type ToolCallStatus = "pending" | "running" | "done" | "error" | "denied";

export interface ToolCallViewProps {
  name: string;
  callPart: Extract<Part, { type: "tool_call" }>;
  result?: Extract<Part, { type: "tool_result" }>;
  status: ToolCallStatus;
  progressLines?: string[];
  expanded: boolean;
}

const TOOL_ICONS: Record<string, string> = {
  read: "▤",
  write: "✎",
  edit: "⌁",
  patch: "⎘",
  bash: "❯",
  glob: "◈",
  grep: "◎",
  ls: "▸",
  fetch: "↧",
  todo_write: "☰",
  task: "⇉"
};

function summarizeInput(name: string, input: unknown): string {
  if (input === null || input === undefined) return "";
  const record = typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : { value: input };

  switch (name) {
    case "bash":
      return String(record["command"] ?? "").replace(/\s+/g, " ").slice(0, 120);
    case "read":
    case "write":
    case "edit":
    case "patch":
      return String(record["file_path"] ?? record["path"] ?? "");
    case "glob":
      return `${record["pattern"] ?? ""}${record["path"] ? ` in ${record["path"]}` : ""}`;
    case "grep":
      return `"${String(record["pattern"] ?? "")}"${record["include"] ? ` in ${record["include"]}` : ""}`;
    case "ls":
      return String(record["path"] ?? ".");
    case "fetch":
      return String(record["url"] ?? "");
    case "task":
      return String(record["description"] ?? "").slice(0, 100);
    case "todo_write":
      return `${Array.isArray(record["todos"]) ? record["todos"].length : 0} items`;
    default: {
      const json = JSON.stringify(record);
      return json.length > 90 ? `${json.slice(0, 87)}…` : json;
    }
  }
}

export function ToolCallView(props: ToolCallViewProps): React.ReactElement {
  const { theme } = useTheme();
  const icon = TOOL_ICONS[props.name] ?? "◆";
  const summary = summarizeInput(props.name, props.callPart.input);

  const statusColor =
    props.status === "done"
      ? theme.toolDone
      : props.status === "error"
        ? theme.toolError
        : props.status === "denied"
          ? theme.warning
          : props.status === "running"
            ? theme.toolRunning
            : theme.toolPending;

  const statusGlyph =
    props.status === "done" ? "✓" : props.status === "error" ? "✗" : props.status === "denied" ? "⊘" : "…";

  const preview = useMemo(() => {
    if (!props.result) return [];
    const lines = props.result.content.split("\n");
    return props.expanded ? lines.slice(0, 40) : lines.slice(0, 3);
  }, [props.result, props.expanded]);

  const hiddenCount = useMemo(() => {
    if (!props.result) return 0;
    const total = props.result.content.split("\n").length;
    const shown = props.expanded ? 40 : 3;
    return Math.max(total - shown, 0);
  }, [props.result, props.expanded]);

  return (
    <Box flexDirection="column" paddingLeft={2}>
      <Box gap={1}>
        <Text color={statusColor}>{statusGlyph}</Text>
        <Text color={theme.accentBright}>
          {icon} {props.name}
        </Text>
        <Text color={theme.textSecondary} wrap="truncate-end">
          {summary}
        </Text>
      </Box>

      {props.progressLines && props.progressLines.length > 0 && props.status === "running" ? (
        <Box flexDirection="column" paddingLeft={4}>
          {props.progressLines.slice(-2).map((line, index) => (
            <Text key={index} dimColor wrap="truncate-end">
              {line.slice(0, 140)}
            </Text>
          ))}
        </Box>
      ) : null}

      {(props.name === "edit" || props.name === "patch") && props.result?.metadata ? null : null}

      {preview.length > 0 ? (
        <Box flexDirection="column" paddingLeft={4}>
          {preview.map((line, index) => (
            <Text key={index} color={props.result?.isError ? theme.toolError : theme.textDim} wrap="truncate">
              {line.length > 160 ? `${line.slice(0, 157)}…` : line}
            </Text>
          ))}
          {hiddenCount > 0 ? (
            <Text dimColor>… {hiddenCount} more lines</Text>
          ) : null}
        </Box>
      ) : null}

      {props.name === "edit" && props.expanded && props.callPart.input !== undefined ? (
        <EditDiffPreview callInput={props.callPart.input} />
      ) : null}
    </Box>
  );
}

function EditDiffPreview({ callInput }: { callInput: unknown }): React.ReactElement | null {
  const record = typeof callInput === "object" && callInput !== null ? (callInput as Record<string, unknown>) : {};
  void record;
  return null;
}

export function ThinkingBlockView({
  text,
  expanded,
  streaming
}: {
  text: string;
  expanded: boolean;
  streaming: boolean;
}): React.ReactElement {
  const { theme } = useTheme();
  const lines = text.split("\n").filter((line) => line.trim().length > 0);

  if (!expanded && !streaming) {
    return (
      <Box paddingLeft={2}>
        <Text italic dimColor>
          ✦ thinking ({lines.length} lines)
        </Text>
      </Box>
    );
  }

  const visible = expanded || streaming ? lines.slice(-14) : [];

  return (
    <Box flexDirection="column" paddingLeft={2}>
      <Text italic dimColor>
        ✦ thinking{streaming ? "…" : ""}
      </Text>
      <Box flexDirection="column" paddingLeft={3}>
        {visible.map((line, index) => (
          <Text key={index} italic color={theme.textFaint} wrap="truncate">
            {line.slice(0, 150)}
          </Text>
        ))}
      </Box>
    </Box>
  );
}

export function buildToolStatus(
  callId: string,
  results: Map<string, Extract<Part, { type: "tool_result" }>>,
  runningIds: Set<string>
): ToolCallStatus {
  if (results.has(callId)) {
    const result = results.get(callId);
    if (!result) return "done";
    const denied = /permission denied|user denied/i.test(result.content);
    if (result.isError) return denied ? "denied" : "error";
    return "done";
  }
  if (runningIds.has(callId)) return "running";
  return "pending";
}
