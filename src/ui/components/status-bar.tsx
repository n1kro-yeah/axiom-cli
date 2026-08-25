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

export function ActivityLine({ status }: { status: AgentRuntimeStatus }): React.ReactElement | null {
  const { theme } = useTheme();

  if (status === "idle" || status === "error" || status === "aborted") return null;

  const labels: Partial<Record<AgentRuntimeStatus, string>> = {
    streaming: "thinking",
    executing_tools: "running tools",
    waiting_permission: "waiting for approval",
    compacting: "compacting context"
  };
  const label = labels[status];
  if (!label) return null;

  return (
    <Box paddingLeft={1} gap={1}>
      <Spinner />
      <Text color={theme.textSecondary} italic>
        {label}… (esc to interrupt)
      </Text>
    </Box>
  );
}

const MODE_LABELS: Record<PermissionMode, string> = {
  normal: "build",
  accept: "accept edits",
  plan: "plan",
  bypass: "bypass"
};

const MODE_COLORS: Record<PermissionMode, string> = {
  normal: "accent",
  accept: "success",
  plan: "info",
  bypass: "danger"
};

function modeColorKey(mode: PermissionMode): string {
  return MODE_COLORS[mode];
}

function resolveColor(theme: { accent: string; success: string; info: string; danger: string }, key: string): string {
  switch (key) {
    case "success":
      return theme.success;
    case "info":
      return theme.info;
    case "danger":
      return theme.danger;
    default:
      return theme.accent;
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
  cwd?: string;
  errorText?: string | null;
}

export function StatusBar(props: StatusBarProps): React.ReactElement {
  const { theme } = useTheme();
  const gauge = contextGauge(props.usedTokens, props.model);
  const gaugeColor =
    gauge.level === "critical" ? theme.gaugeCritical : gauge.level === "warn" ? theme.gaugeWarn : theme.gaugeOk;

  if (props.errorText) {
    return (
      <Box flexDirection="column" paddingLeft={1} paddingTop={0}>
        <Text color={theme.danger}>✗ {truncate(props.errorText, 110)}</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" paddingLeft={1} paddingRight={1}>
      <Box width="100%" justifyContent="space-between">
        <Text dimColor>{props.cwd ? shortenHome(props.cwd) : "axiom"}</Text>
        <Text>
          <Text color={gaugeColor}>{formatTokenCount(props.usedTokens)}</Text>
          <Text dimColor> ({Math.round(gauge.percent)}%)</Text>
          {props.costUSD > 0 ? (
            <Text dimColor> · ${formatCost(props.costUSD)}</Text>
          ) : null}
          <Text dimColor>  </Text>
          <Text color={theme.textSecondary}>/ commands</Text>
        </Text>
      </Box>
    </Box>
  );
}

function truncate(value: string, limit: number): string {
  const single = value.replace(/\s+/g, " ").trim();
  return single.length <= limit ? single : `${single.slice(0, limit - 1)}…`;
}

function shortenHome(cwd: string): string {
  const home = process.env["USERPROFILE"] ?? process.env["HOME"] ?? "";
  if (home.length > 0 && cwd.toLowerCase().startsWith(home.toLowerCase())) {
    return `~${cwd.slice(home.length)}`;
  }
  return cwd;
}

export interface HintLineProps {
  text: string;
}

export function HintLine({ text }: HintLineProps): React.ReactElement | null {
  if (!text) return null;
  return null;
}

export function ModeBanner({ mode }: { mode: PermissionMode }): React.ReactElement | null {
  const { theme } = useTheme();
  if (mode === "plan") {
    return (
      <Box paddingLeft={1}>
        <Text color={theme.info}>plan mode — the agent reads and plans, changing nothing</Text>
      </Box>
    );
  }
  if (mode === "bypass") {
    return (
      <Box paddingLeft={1}>
        <Text color={theme.danger}>bypass mode — approvals disabled</Text>
      </Box>
    );
  }
  return null;
}

export function ContextInline({ used, model }: { used: number; model: ModelInfo }): React.ReactElement {
  const { theme } = useTheme();
  const gauge = contextGauge(used, model);
  const color =
    gauge.level === "critical" ? theme.gaugeCritical : gauge.level === "warn" ? theme.gaugeWarn : theme.gaugeOk;
  return (
    <Text color={color}>
      {formatTokenCount(used)} ({Math.round(gauge.percent)}%)
    </Text>
  );
}
