import React, { useEffect, useState } from "react";
import { Box, Text } from "ink";
import type { AgentRuntimeStatus, ModelInfo, PermissionMode, TodoItem } from "../../types.js";
import { useTheme, SPINNER_VARIANTS, statusColor } from "../theme.js";
import { contextGauge, formatCost, formatTokenCount } from "../../agent/tokens.js";

export function Spinner({ kind = "dots", color }: { kind?: keyof typeof SPINNER_VARIANTS | string; color?: string }): React.ReactElement {
  const variant = SPINNER_VARIANTS[kind] ?? SPINNER_VARIANTS.dots;
  const [frame, setFrame] = useState(0);
  const theme = useTheme().theme;

  useEffect(() => {
    const timer = setInterval(() => {
      setFrame((current) => (current + 1) % variant.frames.length);
    }, variant.intervalMs);
    return () => clearInterval(timer);
  }, [variant]);

  return <Text color={color ?? theme.accentBright}>{variant.frames[frame] ?? "·"}</Text>;
}

function statusLabel(status: AgentRuntimeStatus): string {
  switch (status) {
    case "idle":
      return "";
    case "streaming":
      return "thinking";
    case "executing_tools":
      return "tools";
    case "waiting_permission":
      return "approval";
    case "compacting":
      return "compact";
    case "error":
      return "error";
    case "aborted":
      return "stopped";
    default:
      return String(status);
  }
}

export interface StatusBarProps {
  status: AgentRuntimeStatus;
  mode: PermissionMode;
  model: ModelInfo;
  providerLabel: string;
  usedTokens: number;
  totalTokens: number;
  costUSD: number;
  queueDepth: number;
  mcpCount: number;
  todos: TodoItem[];
  sessionTitle?: string;
}

export function StatusBar(props: StatusBarProps): React.ReactElement {
  const { theme } = useTheme();
  const gauge = contextGauge(props.usedTokens, props.model);
  const gaugeColor =
    gauge.level === "critical" ? theme.gaugeCritical : gauge.level === "warn" ? theme.gaugeWarn : theme.gaugeOk;

  const modeColors: Record<PermissionMode, string> = {
    normal: theme.textSecondary,
    accept: theme.success,
    plan: theme.info,
    bypass: theme.danger
  };
  const modeLabels: Record<PermissionMode, string> = {
    normal: "NORMAL",
    accept: "ACCEPT",
    plan: "PLAN",
    bypass: "BYPASS"
  };

  const openTodos = props.todos.filter((todo) => todo.status === "pending" || todo.status === "in_progress");
  const busy = props.status !== "idle" && props.status !== "error" && props.status !== "aborted";

  return (
    <Box borderStyle="round" borderColor={busy ? theme.borderActive : theme.border} paddingX={1} flexDirection="column" gap={0}>
      <Box justifyContent="space-between">
        <Box gap={1}>
          {busy ? (
            <Spinner />
          ) : (
            <Text color={props.status === "error" ? theme.danger : theme.success}>{props.status === "error" ? "✗" : "✓"}</Text>
          )}
          <Text bold color={statusColor(props.status, theme)}>
            {statusLabel(props.status).toUpperCase() || "READY"}
          </Text>
          {props.queueDepth > 0 ? <Text color={theme.warning}>+{props.queueDepth} queued</Text> : null}
        </Box>

        <Box gap={1}>
          <Text color={modeColors[props.mode]}>[{modeLabels[props.mode]}]</Text>
          <Text color={theme.textSecondary}>
            {props.providerLabel}/{props.model.id}
          </Text>
        </Box>
      </Box>

      <Box justifyContent="space-between">
        <Box gap={2}>
          <Text color={theme.textDim}>
            in {formatTokenCount(props.totalTokens)}
          </Text>
          <Text color={theme.textDim}>${formatCost(props.costUSD)}</Text>
          {openTodos.length > 0 ? (
            <Text color={theme.textDim}>
              tasks {openTodos.filter((t) => t.status === "completed").length}/{openTodos.length}
            </Text>
          ) : null}
          {props.mcpCount > 0 ? <Text color={theme.textFaint}>mcp:{props.mcpCount}</Text> : null}
        </Box>

        <Box gap={1}>
          <Text color={gaugeColor}>ctx</Text>
          <ContextBar percent={gauge.percent} width={16} color={gaugeColor} />
          <Text color={gaugeColor}>{Math.round(gauge.percent)}%</Text>
        </Box>
      </Box>
    </Box>
  );
}

function ContextBar({ percent, width, color }: { percent: number; width: number; color: string }): React.ReactElement {
  const clamped = Math.max(0, Math.min(100, percent));
  const filled = Math.round((clamped / 100) * width);
  const cells: string[] = [];
  for (let i = 0; i < filled; i += 1) cells.push("█");
  for (let i = filled; i < width; i += 1) cells.push("░");

  return (
    <Text>
      <Text color={color}>{cells.slice(0, Math.max(filled, 0)).join("")}</Text>
      <Text color="gray">{cells.slice(Math.max(filled, 0)).join("")}</Text>
    </Text>
  );
}

export interface HintLineProps {
  text: string;
}

export function HintLine({ text }: HintLineProps): React.ReactElement {
  const { theme } = useTheme();
  return (
    <Box paddingLeft={1}>
      <Text dimColor>{text}</Text>
    </Box>
  );
}

export function ModeBanner({ mode }: { mode: PermissionMode }): React.ReactElement | null {
  const { theme } = useTheme();
  if (mode === "plan") {
    return (
      <Box paddingX={1}>
        <Text bold color={theme.info}>
          PLAN MODE — the agent reads and plans but changes nothing
        </Text>
      </Box>
    );
  }
  if (mode === "bypass") {
    return (
      <Box paddingX={1}>
        <Text bold color={theme.danger}>
          BYPASS MODE — approvals disabled
        </Text>
      </Box>
    );
  }
  return null;
}
