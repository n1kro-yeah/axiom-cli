import { Box, Container, Markdown, Text } from "@earendil-works/pi-tui";
import type { MarkdownTheme } from "@earendil-works/pi-tui";
import type { Bubble, DiffRow, ToolBubble } from "../transcript.js";
import type { AnsiTheme } from "./ansi.js";

export interface TranscriptTheme {
  ansi: AnsiTheme;
}

const MARK_RUNNING = "...";
const MARK_OK = "+";
const MARK_ERROR = "x";
const MARK_DENIED = "!";

function markFor(bubble: ToolBubble, frame: number, ansi: AnsiTheme): { mark: string; color: (text: string) => string } {
  switch (bubble.state) {
    case "running":
      return { mark: SPIN[frame % SPIN.length], color: ansi.accentBright };
    case "ok":
      return { mark: MARK_OK, color: ansi.ok };
    case "denied":
      return { mark: MARK_DENIED, color: ansi.warning };
    default:
      return { mark: MARK_ERROR, color: ansi.error };
  }
}

const SPIN = ["|", "/", "-", "\\"];

export class TranscriptComponent extends Container {
  private currentBubbles: Bubble[] = [];
  private frame = 0;
  private readonly markdownTheme: MarkdownTheme;

  constructor(private readonly ansi: AnsiTheme) {
    super();
    this.markdownTheme = {
      heading: ansi.accentBright,
      link: ansi.info,
      linkUrl: ansi.faint,
      code: ansi.success,
      codeBlock: (text) => ansi.success(text),
      codeBlockBorder: ansi.faint,
      quote: ansi.muted,
      quoteBorder: ansi.faint,
      hr: ansi.faint,
      listBullet: ansi.accent,
      bold: ansi.bold,
      italic: ansi.italic,
      strikethrough: ansi.dim,
      underline: ansi.underline
    };
  }

  override invalidate(): void {
    super.invalidate();
  }

  setFrame(frame: number): void {
    this.frame = frame;
  }

  setBubbles(bubbles: Bubble[]): void {
    const sameLength = this.currentBubbles.length === bubbles.length;
    if (sameLength && bubbles.every((bubble, index) => this.currentBubbles[index] === bubble)) {
      return;
    }
    this.currentBubbles = bubbles;
    this.rebuild();
  }

  tick(): void {
    this.frame = (this.frame + 1) % SPIN.length;
    const last = this.children[this.children.length - 1];
    if (last && (last as { bubbleKind?: string }).bubbleKind === "tool") {
      this.invalidate();
    }
  }

  private rebuild(): void {
    this.clear();
    for (const bubble of this.currentBubbles) {
      this.addChild(this.renderBubble(bubble));
    }
  }

  private renderBubble(bubble: Bubble): Box {
    const ansi = this.ansi;
    const box = new Box(0, 0);
    (box as { bubbleKind?: string }).bubbleKind = bubble.kind;

    switch (bubble.kind) {
      case "user": {
        const first = bubble.text.split("\n")[0];
        const rest = bubble.text.slice(first.length).trimStart();
        box.addChild(new Text(`${ansi.accent("> ")}${ansi.bold(truncateLine(first, 200))}`, 1, 0));
        if (rest) {
          box.addChild(new Text(ansi.muted(truncateLine(rest, 400)), 2, 0));
        }
        return box;
      }

      case "assistant": {
        if (bubble.thinking.trim()) {
          const thinking = clipLines(bubble.thinking.trim(), bubble.streaming ? 4 : 12);
          box.addChild(new Text(ansi.italic(ansi.muted(thinking)), 1, 0));
        }
        if (bubble.streaming && bubble.text === "") {
          box.addChild(new Text(`${ansi.accentBright(SPIN[this.frame])} ${ansi.muted("thinking")}`, 1, 0));
        } else if (bubble.streaming) {
          box.addChild(new Text(bubble.text, 1, 0));
        } else if (bubble.text.trim()) {
          box.addChild(new Markdown(bubble.text, 1, 0, this.markdownTheme));
        }
        return box;
      }

      case "tool": {
        const { mark, color } = markFor(bubble, this.frame, this.ansi);
        const stats =
          bubble.diffRows && bubble.diffRows.length > 0
            ? `${bubble.added > 0 ? ` ${ansi.ok(`+${bubble.added}`)}` : ""}${bubble.removed > 0 ? ` ${ansi.error(`-${bubble.removed}`)}` : ""}`
            : "";
        box.addChild(new Text(`${color(mark)} ${ansi.accentBright(bubble.name)} ${ansi.muted(bubble.summary)}${stats}`, 1, 0));

        if (bubble.state === "running" && bubble.progress.length > 0) {
          for (const line of bubble.progress.slice(-2)) {
            box.addChild(new Text(ansi.faint(truncateLine(line, 130)), 3, 0));
          }
        }

        if (bubble.diffRows && bubble.diffRows.length > 0) {
          for (const row of renderDiffRows(bubble.diffRows, ansi)) {
            box.addChild(new Text(row, 3, 0));
          }
        } else if (bubble.state !== "running" && bubble.preview !== null && bubble.preview.length > 0) {
          const preview = bubble.preview;
          preview.forEach((line, index) => {
            const isLast = index === preview.length - 1;
            const style = isLast && bubble.isError ? ansi.error : ansi.faint;
            box.addChild(new Text(style(truncateLine(line, 130)), 3, 0));
          });
        }
        return box;
      }

      case "notice": {
        const color = bubble.level === "error" ? ansi.error : bubble.level === "warn" ? ansi.warning : ansi.accent;
        box.addChild(new Text(color(truncateLine(bubble.text, 200)), 1, 0));
        return box;
      }
    }
  }
}

function renderDiffRows(rows: DiffRow[], ansi: AnsiTheme): string[] {
  const visible = rows.slice(0, 24);
  const out = visible.map((row) => {
    if (row.tag === "+") return ansi.diffAdd(`+ ${truncateLine(row.text, 150)}`);
    if (row.tag === "-") return ansi.diffDel(`- ${truncateLine(row.text, 150)}`);
    if (row.tag === "@") return ansi.diffMeta(row.text);
    return ansi.faint(`  ${truncateLine(row.text, 150)}`);
  });
  if (rows.length > visible.length) {
    out.push(ansi.faint(`... ${rows.length - visible.length} more`));
  }
  return out;
}

function truncateLine(value: string, limit: number): string {
  const single = value.replace(/\r/g, "");
  return single.length <= limit ? single : `${single.slice(0, limit - 1)}...`;
}

function clipLines(text: string, maxRows: number): string {
  const rows = text.split("\n");
  if (rows.length <= maxRows) return text;
  return ["...", ...rows.slice(-(maxRows - 1))].join("\n");
}
