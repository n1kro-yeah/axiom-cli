import { Container, Text } from "@earendil-works/pi-tui";
import type { AnsiTheme } from "./ansi.js";
import { formatWorkspacePath } from "./workspace.js";

export class LogoComponent extends Container {
  constructor(ansi: AnsiTheme, version: string, subtitle: string, workspace: string, columns: number) {
    super();

    this.addChild(
      new Text(
        `${ansi.accent("axiom")} ${ansi.muted(`v${version}`)}${workspace ? `  ${ansi.faint(formatWorkspacePath(workspace, Math.max(6, Math.min(72, columns - 8))))}` : ""}`,
        1,
        0
      )
    );
    this.addChild(new Text(ansi.muted(subtitle), 1, 0));
  }
}
