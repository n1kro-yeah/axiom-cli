import React from "react";
import { Box, Static, Text } from "ink";
import type { ChatMessage, Part } from "../../types.js";
import { renderMarkdown } from "../markdown.js";
import { useTheme } from "../theme.js";
import { ToolCallView, ThinkingBlockView, buildToolStatus } from "./tool-call.js";
import type { ToolCallStatus } from "./tool-call.js";

const USER_MARKER = "›";
const ASSISTANT_MARKER = "◆";

export interface MessageListViewProps {
  messages: ChatMessage[];
  expandedToolIds: Set<string>;
  expandedThinkingIds: Set<string>;
  runningToolIds: Set<string>;
}

export function CompletedMessages(props: MessageListViewProps): React.ReactElement {
  return (
    <Static items={props.messages}>
      {(message) => (
        <MessageBlock
          key={message.id}
          message={message}
          expandedToolIds={props.expandedToolIds}
          expandedThinkingIds={props.expandedThinkingIds}
          runningToolIds={props.runningToolIds}
        />
      )}
    </Static>
  );
}

export function StreamingMessage({
  message,
  runningToolIds,
  progressByCall,
  pendingPermissionTool
}: {
  message: ChatMessage;
  runningToolIds: Set<string>;
  progressByCall: Map<string, string[]>;
  pendingPermissionTool?: string;
}): React.ReactElement {
  const results = new Map<string, Extract<Part, { type: "tool_result" }>>();
  for (const part of message.parts) {
    if (part.type === "tool_result") results.set(part.toolCallId, part);
  }

  return (
    <Box flexDirection="column">
      <MessageBody
        message={message}
        results={results}
        expandedToolIds={new Set()}
        expandedThinkingIds={new Set()}
        runningToolIds={runningToolIds}
        progressByCall={progressByCall}
      />
      {pendingPermissionTool ? <PendingApprovalLine toolName={pendingPermissionTool} /> : null}
    </Box>
  );
}

export function MessageBlock(props: {
  message: ChatMessage;
  expandedToolIds: Set<string>;
  expandedThinkingIds: Set<string>;
  runningToolIds: Set<string>;
}): React.ReactElement {
  const results = new Map<string, Extract<Part, { type: "tool_result" }>>();
  for (const part of props.message.parts) {
    if (part.type === "tool_result") results.set(part.toolCallId, part);
  }

  return (
    <Box flexDirection="column">
      <MessageHeader message={props.message} />
      <MessageBody
        message={props.message}
        results={results}
        expandedToolIds={props.expandedToolIds}
        expandedThinkingIds={props.expandedThinkingIds}
        runningToolIds={props.runningToolIds}
        progressByCall={new Map()}
      />
      {props.message.errorMessage ? (
        <Box paddingLeft={2}>
          <Text color="red">error: {props.message.errorMessage.slice(0, 300)}</Text>
        </Box>
      ) : null}
    </Box>
  );
}

function MessageHeader({ message }: { message: ChatMessage }): React.ReactElement {
  const { theme } = useTheme();

  if (message.role === "user") {
    return (
      <Box paddingLeft={0}>
        <Text color={theme.accentBright} bold>
          {USER_MARKER}{" "}
        </Text>
      </Box>
    );
  }

  const meta: string[] = [];
  if (message.model && !message.model.startsWith("msg")) meta.push(message.model);
  if (message.usage?.outputTokens) meta.push(`${message.usage.outputTokens}tok`);
  if (typeof message.costUSD === "number" && message.costUSD > 0) meta.push(`$${message.costUSD.toFixed(4)}`);

  return (
    <Box gap={1} paddingLeft={0}>
      <Text color={theme.accent} bold>
        {ASSISTANT_MARKER}
      </Text>
      {meta.length > 0 ? <Text dimColor>{meta.join(" · ")}</Text> : null}
      {message.summary ? <Text color={theme.info}>[summary]</Text> : null}
    </Box>
  );
}

function PendingApprovalLine({ toolName }: { toolName: string }): React.ReactElement {
  const { theme } = useTheme();
  return (
    <Box paddingLeft={2}>
      <Text color={theme.warning}>⚠ approval required for {toolName}</Text>
    </Box>
  );
}

function MessageBody(props: {
  message: ChatMessage;
  results: Map<string, Extract<Part, { type: "tool_result" }>>;
  expandedToolIds: Set<string>;
  expandedThinkingIds: Set<string>;
  runningToolIds: Set<string>;
  progressByCall: Map<string, string[]>;
}): React.ReactElement {
  const blocks: React.ReactElement[] = [];
  let textBuffer = "";
  let keyCounter = 0;

  const flushText = (): void => {
    if (textBuffer.trim().length === 0) {
      textBuffer = "";
      return;
    }
    const rendered = renderMarkdown(textBuffer);
    blocks.push(
      <Box key={`text_${keyCounter++}`} flexDirection="column" paddingLeft={2}>
        {rendered.lines.map((line, index) => (
          <SegmentLineText key={index} line={line} />
        ))}
      </Box>
    );
    textBuffer = "";
  };

  for (const [index, part] of props.message.parts.entries()) {
    switch (part.type) {
      case "text": {
        if (props.message.role === "user") {
          flushText();
          blocks.push(
            <Box key={`user_${index}`} paddingLeft={1}>
              <Text bold wrap="wrap">
                {part.text}
              </Text>
            </Box>
          );
        } else {
          textBuffer += (textBuffer.length > 0 ? "\n" : "") + part.text;
        }
        break;
      }

      case "thinking": {
        flushText();
        blocks.push(
          <ThinkingBlockView
            key={`think_${index}`}
            text={part.thinking}
            streaming={!props.results.size && index === props.message.parts.length - 1}
            expanded={props.expandedThinkingIds.has(props.message.id)}
          />
        );
        break;
      }

      case "tool_call": {
        flushText();
        const status = buildToolStatus(part.id, props.results, props.runningToolIds);
        blocks.push(
          <ToolCallView
            key={`call_${index}_${part.id}`}
            name={part.name}
            callPart={part}
            result={props.results.get(part.id)}
            status={status}
            progressLines={props.progressByCall.get(part.id)}
            expanded={props.expandedToolIds.has(part.id)}
          />
        );
        break;
      }

      case "tool_result":
      case "image":
        break;
    }
  }

  flushText();
  return <Box flexDirection="column">{blocks}</Box>;
}

export function SegmentLineText({ line }: { line: ReturnType<typeof renderMarkdown>["lines"][number] }): React.ReactElement {
  const { theme } = useTheme();

  if (line.length === 0) return <Text> </Text>;

  const firstStyle = line[0]?.style ?? "plain";

  if (firstStyle === "heading1") {
    return (
      <Text bold color={theme.accentBright}>
        {" "}
        {line.map((segment) => segment.text).join("")}
      </Text>
    );
  }
  if (firstStyle === "heading2") {
    return (
      <Text bold color={theme.accent}>
        {" "}
        {line.map((segment) => segment.text).join("")}
      </Text>
    );
  }
  if (firstStyle === "heading3") {
    return (
      <Text bold underline={false} color={theme.textPrimary}>
        {" "}
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
      return <Text italic dimColor>{text}</Text>;
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

export function ToolStatusSummary(statuses: ToolCallStatus[]): string {
  const counts: Record<ToolCallStatus, number> = { pending: 0, running: 0, done: 0, error: 0, denied: 0 };
  for (const status of statuses) counts[status] += 1;
  return `done:${counts.done} err:${counts.error} denied:${counts.denied} run:${counts.running}`;
}
