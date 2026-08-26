import React from "react";
import { Box, Text, useInput } from "ink";
import type { PermissionRequest } from "../../types.js";
import { useTheme } from "../theme.js";

export interface PermissionDialogProps {
  request: PermissionRequest;
  onDecision: (decision: "allow_once" | "allow_always" | "deny") => void;
  allowAlwaysLabel?: string;
}

export function PermissionDialog(props: PermissionDialogProps): React.ReactElement {
  const { theme } = useTheme();

  useInput((_input, key) => {
    if (key.return || _input === "y" || _input === "Y") {
      props.onDecision("allow_once");
      return;
    }
    if (_input === "a" || _input === "A") {
      props.onDecision("allow_always");
      return;
    }
    if (key.escape || _input === "n" || _input === "N") {
      props.onDecision("deny");
      return;
    }
  });

  const riskColor = props.request.risk === "high" ? theme.danger : props.request.risk === "medium" ? theme.warning : theme.textSecondary;
  const riskTag = props.request.risk.toUpperCase();

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.warning} paddingX={1} paddingY={0} marginTop={1}>
      <Box gap={2}>
        <Text bold color={riskColor}>
          ! {props.request.title}
        </Text>
        <Text dimColor>[{riskTag}]</Text>
      </Box>

      <Box flexDirection="column" paddingX={2} marginY={0}>
        {props.request.summary.map((line, index) => (
          <Text key={index} wrap="truncate">
            {line.length > 110 ? `${line.slice(0, 107)}...` : line}
          </Text>
        ))}
      </Box>

      <Box gap={2} marginTop={0}>
        <Text>
          <Text bold color={theme.success}>
            [y/enter]
          </Text>
          <Text> allow once</Text>
        </Text>
        <Text>
          <Text bold color={theme.accentBright}>
            [a]
          </Text>
          <Text> always for this pattern</Text>
        </Text>
        <Text>
          <Text bold color={theme.danger}>
            [n/esc]
          </Text>
          <Text> deny</Text>
        </Text>
      </Box>
    </Box>
  );
}

export interface ConfirmDialogProps {
  title: string;
  detail?: string[];
  onAnswer: (yes: boolean) => void;
}

export function ConfirmDialog(props: ConfirmDialogProps): React.ReactElement {
  const { theme } = useTheme();

  useInput((input, key) => {
    if (key.return || input === "y" || input === "Y") props.onAnswer(true);
    else if (key.escape || input === "n" || input === "N") props.onAnswer(false);
  });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.danger} paddingX={1} marginTop={1}>
      <Text bold color={theme.danger}>
        ? {props.title}
      </Text>
      {props.detail?.map((line, index) => (
        <Text key={index} dimColor>
          {line}
        </Text>
      ))}
      <Box gap={2}>
        <Text>
          <Text bold>[y/enter]</Text> yes
        </Text>
        <Text>
          <Text bold>[n/esc]</Text> no
        </Text>
      </Box>
    </Box>
  );
}

export function NoticeLine({ level, text }: { level: "info" | "warn" | "error"; text: string }): React.ReactElement {
  const { theme } = useTheme();
  const glyph = level === "error" ? "x" : level === "warn" ? "!" : "i";
  const color = level === "error" ? theme.danger : level === "warn" ? theme.warning : theme.info;

  return (
    <Box paddingLeft={1}>
      <Text color={color}>
        {glyph} {text}
      </Text>
    </Box>
  );
}

export function QueuedMessagePreview({ texts }: { texts: string[] }): React.ReactElement | null {
  const { theme } = useTheme();
  if (texts.length === 0) return null;

  return (
    <Box paddingLeft={1} flexDirection="column">
      <Text dimColor>queued:</Text>
      {texts.slice(0, 3).map((text, index) => (
        <Text key={index} color={theme.warning} wrap="truncate">
          + {text.slice(0, 80)}
        </Text>
      ))}
    </Box>
  );
}
