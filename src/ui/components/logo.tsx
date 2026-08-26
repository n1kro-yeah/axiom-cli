import { Box, Text, useWindowSize } from "ink";
import { useTheme } from "../theme.js";

const MARK = ["  ◆◆  ", " ◆◆◆◆ ", "  ◆◆  "];

export function formatWorkspacePath(workspace: string, maxColumns: number): string {
  const home = process.env["USERPROFILE"] ?? process.env["HOME"] ?? "";
  let value = workspace;
  if (home.length > 0 && workspace.toLowerCase().startsWith(home.toLowerCase())) {
    value = `~${workspace.slice(home.length)}`;
  }
  if (value.length <= maxColumns) return value;
  const tail = value.slice(-(maxColumns - 1));
  const cut = tail.indexOf("\\") === -1 ? tail.indexOf("/") : Math.max(tail.indexOf("\\"), tail.indexOf("/"));
  return `…${cut === -1 ? tail : tail.slice(cut)}`;
}

export function Logo({ subtitle, workspace }: { subtitle?: string; workspace?: string }): React.ReactElement {
  const { theme } = useTheme();
  const { columns } = useWindowSize();
  const location = workspace
    ? formatWorkspacePath(workspace, Math.max(6, Math.min(72, columns - 15)))
    : "";

  return (
    <Box width="100%" marginBottom={1}>
      <Box flexDirection="column" flexShrink={0}>
        {MARK.map((line, index) => (
          <Text key={index} color={theme.accent}>
            {line}
          </Text>
        ))}
      </Box>
      <Box flexDirection="column" marginLeft={2} flexGrow={1} flexShrink={1} minWidth={0}>
        <Box>
          <Text color={theme.accent} bold>
            axiom
          </Text>
          <Text dimColor> v0.1.0</Text>
        </Box>
        <Text dimColor wrap="truncate-end">
          {subtitle ?? "agentic coding assistant · / commands · @ files · shift+tab modes"}
        </Text>
        {location ? (
          <Box width="100%">
            <Text color={theme.accent}>⌂ </Text>
            <Box flexGrow={1} flexShrink={1} minWidth={0}>
              <Text dimColor wrap="truncate-start">
                {location}
              </Text>
            </Box>
          </Box>
        ) : null}
      </Box>
    </Box>
  );
}
