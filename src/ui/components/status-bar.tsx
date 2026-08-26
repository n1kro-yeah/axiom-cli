import { Box, Text } from "ink";
import { Fragment } from "react";
import type { ReactNode } from "react";
import type { PermissionMode } from "../../types.js";
import { useTheme } from "../theme.js";

const BAR_WIDTH = 12;

export interface StatusBarData {
  modelRef: string;
  effort: "low" | "medium" | "high";
  thinking: boolean;
  mode: PermissionMode;
  usage: { input: number; output: number; cacheRead: number; costUsd: number };
  context: { window: number; used: number; exact: boolean };
  turnMs: number | null;
  sessionMs: number;
  bypass: boolean;
  busy: boolean;
  mcpConnected: number;
  mcpFailed: number;
  activeAgents: number;
  queueDepth: number;
}

export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const restSeconds = seconds % 60;
  if (minutes < 60) return `${minutes}m ${restSeconds}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function tokens(count: number): string {
  if (count < 1000) return String(count);
  if (count < 1_000_000) {
    const value = count / 1000;
    return `${value.toFixed(value < 10 ? 1 : 0).replace(/\.0$/, "")}k`;
  }
  return `${(count / 1_000_000).toFixed(2)}M`;
}

function shortModel(ref: string): string {
  const slash = ref.lastIndexOf("/");
  return slash === -1 ? ref : ref.slice(slash + 1);
}

export function StatusBar({ status }: { status: StatusBarData }): React.ReactElement {
  const { theme } = useTheme();

  const details: ReactNode[] = [];

  if (!status.thinking) {
    details.push(
      <Text key="think" color={theme.warning}>
        thinking off
      </Text>
    );
  }

  if (status.mode !== "normal") {
    const modeColor = status.mode === "accept" ? theme.warning : status.mode === "plan" ? theme.info : theme.danger;
    details.push(
      <Text key="mode" color={modeColor}>
        {status.mode} mode
      </Text>
    );
  }

  details.push(
    <Text key="usage">
      <Text color={theme.textPrimary} bold>
        {tokens(status.usage.input)}
      </Text>
      <Text dimColor> in </Text>
      <Text color={theme.ok}>{tokens(status.usage.output)}</Text>
      <Text dimColor> out</Text>
      {status.usage.cacheRead > 0 ? (
        <>
          <Text dimColor> (</Text>
          <Text color="gray">{tokens(status.usage.cacheRead)} cache</Text>
          <Text dimColor>)</Text>
        </>
      ) : null}
      {status.usage.costUsd > 0 ? (
        <>
          <Text dimColor> · </Text>
          <Text color={theme.warning} bold>
            ${status.usage.costUsd < 0.01 ? status.usage.costUsd.toFixed(4) : status.usage.costUsd.toFixed(3)}
          </Text>
        </>
      ) : null}
    </Text>
  );

  details.push(
    <Text
      key="elapsed"
      color={status.turnMs !== null ? theme.accentBright : undefined}
      bold={status.turnMs !== null}
    >
      {status.turnMs !== null
        ? `working ${formatDuration(status.turnMs)}`
        : `session for ${formatDuration(status.sessionMs)}`}
    </Text>
  );

  if (status.queueDepth > 0) {
    details.push(
      <Text key="queue" color={theme.warning}>
        +{status.queueDepth} queued
      </Text>
    );
  }

  if (status.bypass) {
    details.push(
      <Text key="bypass" color="black" backgroundColor={theme.warning} bold>
        {" "}BYPASS{" "}
      </Text>
    );
  }

  return (
    <Box
      width="100%"
      flexShrink={0}
      marginTop={1}
      paddingX={1}
      borderStyle="single"
      borderTop
      borderBottom={false}
      borderLeft={false}
      borderRight={false}
      borderColor={theme.accent}
      borderDimColor
      flexDirection="column"
      alignItems="flex-start"
    >
      <Box width="100%">
        <Box flexGrow={1} flexShrink={1} flexWrap="wrap" alignItems="flex-start">
          <ModelBadge modelRef={status.modelRef} />
          <Text dimColor>{" · "}</Text>
          <EffortBadge effort={status.effort} />
        </Box>
        <Box flexShrink={0} marginLeft={2} flexDirection="column" alignItems="flex-end">
          <ContextMeter window={status.context.window} used={status.context.used} exact={status.context.exact} />
          {status.mcpConnected > 0 || status.mcpFailed > 0 ? (
            <Text>
              {status.mcpConnected > 0 ? <Text color={theme.ok}>mcp:{status.mcpConnected}</Text> : null}
              {status.mcpConnected > 0 && status.mcpFailed > 0 ? <Text dimColor> · </Text> : null}
              {status.mcpFailed > 0 ? <Text color={theme.error}>{status.mcpFailed} failed</Text> : null}
            </Text>
          ) : null}
          {status.activeAgents > 0 ? (
            <Text color={theme.accent}>{status.activeAgents} agent(s)</Text>
          ) : null}
        </Box>
      </Box>
      <Box flexWrap="wrap" marginTop={0}>
        {details.map((item, index) => (
          <Fragment key={index}>
            {index > 0 ? <Text dimColor>{" · "}</Text> : null}
            {item}
          </Fragment>
        ))}
      </Box>
    </Box>
  );
}

function ModelBadge({ modelRef }: { modelRef: string }): React.ReactElement {
  const { theme } = useTheme();
  return (
    <Box borderColor={theme.accent} borderStyle="round" paddingX={1}>
      <Text color={theme.accent} bold>
        {shortModel(modelRef)}
      </Text>
    </Box>
  );
}

const EFFORT_STYLES: Record<string, { label: string; color: string; bold?: boolean; dim?: boolean }> = {
  high: { label: "high", color: "cyan" },
  medium: { label: "medium", color: "blue" },
  low: { label: "low", color: "gray", dim: true }
};

function EffortBadge({ effort }: { effort: string }): React.ReactElement {
  const style = EFFORT_STYLES[effort] ?? EFFORT_STYLES.medium;
  return (
    <Box borderColor={style.color} borderStyle="round" paddingX={1}>
      <Text color={style.color} bold={style.bold} dimColor={style.dim}>
        {style.label}
      </Text>
    </Box>
  );
}

function ContextMeter({ window: win, used, exact }: { window: number; used: number; exact: boolean }): React.ReactElement {
  const { theme } = useTheme();

  if (!exact || win <= 0) {
    return (
      <Text>
        <Text dimColor>ctx </Text>
        <Text color="gray">{tokens(used)}</Text>
        {win > 0 ? <Text dimColor>/{tokens(win)}</Text> : null}
      </Text>
    );
  }

  const pct = Math.min(Math.max(used / win, 0), 1);
  const filled = Math.max(0, Math.min(BAR_WIDTH, Math.round(BAR_WIDTH * pct)));
  const color = pct < 0.6 ? theme.ok : pct < 0.85 ? theme.warning : theme.error;
  const percent = Math.round(pct * 100);

  return (
    <Text>
      <Text dimColor>ctx </Text>
      <Text color={color} bold>
        {`${percent}%`.padStart(4)}
      </Text>
      <Text color={color} bold>
        {"[" + "#".repeat(filled) + ".".repeat(BAR_WIDTH - filled) + "]"}
      </Text>
      <Text dimColor> {tokens(used)}/{tokens(win)}</Text>
    </Text>
  );
}

