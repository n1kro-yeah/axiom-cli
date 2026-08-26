import { Box, Text, useWindowSize } from "ink";
import { useTheme } from "../theme.js";

export function formatWorkspacePath(workspace: string, maxColumns: number): string {
  const home = process.env["USERPROFILE"] ?? process.env["HOME"] ?? "";
  let value = workspace;
  if (home.length > 0 && workspace.toLowerCase().startsWith(home.toLowerCase())) {
    value = `~${workspace.slice(home.length)}`;
  }
  if (value.length <= maxColumns) return value;
  const tail = value.slice(-(maxColumns - 1));
  const cut = tail.indexOf("\\") === -1 ? tail.indexOf("/") : Math.max(tail.indexOf("\\"), tail.indexOf("/"));
  return `...${cut === -1 ? tail : tail.slice(cut)}`;
}

export function Logo({ subtitle, workspace }: { subtitle?: string; workspace?: string }): React.ReactElement {
  const { theme } = useTheme();
  const { columns } = useWindowSize();
  const location = workspace
    ? formatWorkspacePath(workspace, Math.max(6, Math.min(72, columns - 6)))
    : "";

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text>
        <Text color={theme.accent} bold>
          axiom
        </Text>
        <Text dimColor> v0.1.0</Text>
      </Text>
      <Text dimColor wrap="truncate-end">
        {subtitle ?? "agentic coding assistant · / commands · @ files · shift+tab modes"}
      </Text>
      {location ? (
        <Text dimColor wrap="truncate-start">
          {location}
        </Text>
      ) : null}
    </Box>
  );
}
