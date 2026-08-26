import { Box } from "ink";
import type { ReactNode } from "react";

export function interactiveViewportRows(rows: number): number {
  if (!Number.isFinite(rows)) return 22;
  return Math.max(1, Math.floor(rows) - 2);
}

const INTERACTIVE_CHROME_ROWS = 14;

export function liveTranscriptRows(rows: number): number {
  return Math.max(1, interactiveViewportRows(rows) - INTERACTIVE_CHROME_ROWS);
}

export function TerminalViewport({ children, rows }: { children: ReactNode; rows: number }): React.ReactElement {
  return (
    <Box flexDirection="column" maxHeight={interactiveViewportRows(rows)} overflowY="hidden">
      {children}
    </Box>
  );
}
