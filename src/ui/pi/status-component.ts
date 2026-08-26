import { Container, Text, TruncatedText } from "@earendil-works/pi-tui";
import type { AnsiTheme } from "./ansi.js";


export interface StatusData {
  modelRef: string;
  effort: "low" | "medium" | "high";
  thinking: boolean;
  mode: "normal" | "accept" | "plan" | "bypass";
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  costUsd: number;
  contextWindow: number;
  turnMs: number | null;
  sessionMs: number;
  bypass: boolean;
  busy: boolean;
  mcpConnected: number;
  queueDepth: number;
  cwd: string;
}

const BAR_WIDTH = 12;

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

function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes < 60) return `${minutes}m ${rest}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export class StatusComponent extends Container {
  private readonly line1: Text;
  private readonly line2: Text;
  private readonly ansi: AnsiTheme;
  private data: StatusData | null = null;

  constructor(ansi: AnsiTheme) {
    super();
    this.ansi = ansi;
    this.line1 = new Text("", 0, 0);
    this.line2 = new Text("", 0, 0);
    this.addChild(new Text(this.ansi.faint("-".repeat(60)), 0, 0));
    this.addChild(this.line1);
    this.addChild(this.line2);
  }

  update(data: StatusData): void {
    this.data = data;
    this.renderLines();
  }

  override invalidate(): void {
    super.invalidate();
    if (this.data) this.renderLines();
  }

  private renderLines(): void {
    const data = this.data;
    if (!data) return;
    const ansi = this.ansi;

    const used = data.inputTokens;
    const pct = data.contextWindow > 0 ? Math.min(used / data.contextWindow, 1) : 0;
    const filled = Math.max(0, Math.min(BAR_WIDTH, Math.round(BAR_WIDTH * pct)));
    const meterColor = pct < 0.6 ? ansi.ok : pct < 0.85 ? ansi.warning : ansi.error;
    const meter = `[${"#".repeat(filled)}${".".repeat(BAR_WIDTH - filled)}]`;

    const modeLabel =
      data.mode === "normal"
        ? ansi.accent("build")
        : data.mode === "accept"
          ? ansi.warning("accept")
          : data.mode === "plan"
            ? ansi.info("plan")
            : ansi.error("bypass");

    const right = `${meterColor(`${Math.round(pct * 100)}%`)} ${ansi.muted(meter)} ${ansi.muted(`${tokens(used)}/${tokens(data.contextWindow)}`)}`;

    this.line1.setText(
      `${modeLabel} ${ansi.muted("·")} ${ansi.bold(shortModel(data.modelRef))}${
        data.queueDepth > 0 ? ansi.warning(` · +${data.queueDepth} queued`) : ""
      }   ${right}`
    );

    const parts: string[] = [];
    if (!data.thinking) parts.push(ansi.warning("thinking off"));
    if (data.mode !== "normal") parts.push(ansi.warning(`${data.mode} mode`));
    parts.push(
      `${ansi.bold(tokens(data.inputTokens))} ${ansi.muted("in")} ${ansi.ok(tokens(data.outputTokens))} ${ansi.muted("out")}${
        data.cacheReadTokens > 0 ? ansi.muted(` (${tokens(data.cacheReadTokens)} cache)`) : ""
      }${data.costUsd > 0 ? ` ${ansi.warning(`$${data.costUsd < 0.01 ? data.costUsd.toFixed(4) : data.costUsd.toFixed(3)}`)}` : ""}`
    );
    parts.push(
      data.turnMs !== null
        ? ansi.accentBright(`working ${formatDuration(data.turnMs)}`)
        : ansi.muted(`session for ${formatDuration(data.sessionMs)}`)
    );
    if (data.mcpConnected > 0) parts.push(ansi.ok(`mcp:${data.mcpConnected}`));
    if (data.bypass) parts.push(ansi.error("BYPASS"));
    if (data.busy) parts.push(ansi.muted("esc to interrupt"));

    this.line2.setText(parts.join(ansi.muted(" · ")));
  }
}
