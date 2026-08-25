export type InlineStyle =
  | "plain"
  | "bold"
  | "italic"
  | "code"
  | "link"
  | "heading1"
  | "heading2"
  | "heading3"
  | "listMarker"
  | "quote"
  | "tableCell"
  | "hr";

export interface Segment {
  text: string;
  style: InlineStyle;
}

export type SegmentLine = Segment[];

export interface RenderedMarkdown {
  lines: SegmentLine[];
  codeBlocks: number;
}

export function renderMarkdown(source: string): RenderedMarkdown {
  const normalized = source.replace(/\r\n/g, "\n").replace(/\t/g, "  ");
  const rawLines = normalized.split("\n");
  const out: SegmentLine[] = [];
  let codeBlocks = 0;

  let index = 0;
  while (index < rawLines.length) {
    const line = rawLines[index] ?? "";

    if (isFence(line)) {
      const language = extractFenceLanguage(line);
      const body: SegmentLine[] = [];
      index += 1;
      while (index < rawLines.length && !isFence(rawLines[index] ?? "")) {
        body.push([{ text: ` ${rawLines[index] ?? ""}`, style: "code" }]);
        index += 1;
      }
      index += 1;
      out.push([{ text: "╭─" + (language ? `[${language}]` : "[code]") + "─", style: "code" }]);
      if (body.length === 0) {
        out.push([{ text: " (empty)", style: "code" }]);
      }
      for (const bodyLine of body) out.push(bodyLine);
      out.push([{ text: "╰────", style: "code" }]);
      codeBlocks += 1;
      continue;
    }

    const headingMatch = /^(#{1,6})\s+(.*)$/.exec(line);
    if (headingMatch) {
      const level = headingMatch[1].length;
      const text = headingMatch[2]?.trim() ?? "";
      const style: InlineStyle = level <= 1 ? "heading1" : level === 2 ? "heading2" : "heading3";
      const underline =
        style === "heading1" ? "═".repeat(Math.min(text.length + 2, 60)) : style === "heading2" ? "─".repeat(Math.min(text.length + 2, 60)) : "";
      out.push([{ text: text.toUpperCase() === text && level >= 3 ? text : text, style }]);
      if (underline) out.push([{ text: underline, style: "hr" }]);
      index += 1;
      continue;
    }

    if (/^\s*([-*_])\s*\1\s*\1[\s\-*_]*$/.test(line)) {
      out.push([{ text: "─".repeat(40), style: "hr" }]);
      index += 1;
      continue;
    }

    if (/^\s*>\s?/.test(line)) {
      const quoteText = line.replace(/^\s*>\s?/, "");
      const segments = parseInlineSegments(quoteText);
      out.push([
        { text: "▌ ", style: "quote" },
        ...segments.map((segment) => ({ ...segment, style: segment.style === "plain" ? ("quote" as InlineStyle) : segment.style }))
      ]);
      index += 1;
      continue;
    }

    const listMatch = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (listMatch) {
      const indent = Math.floor((listMatch[1]?.length ?? 0) / 2);
      const markerRaw = listMatch[2] ?? "-";
      const marker = /\d/.test(markerRaw) ? `${markerRaw}` : "•";
      const prefix = `${" ".repeat(indent * 2)}${marker} `;
      out.push([
        { text: prefix, style: "listMarker" },
        ...parseInlineSegments(listMatch[3] ?? "")
      ]);
      index += 1;
      continue;
    }

    if (/^\s*\|.*\|\s*$/.test(line)) {
      const cells = splitTableRow(line);
      const isSeparatorRow = cells.every((cell) => /^\s*:?-{2,}:?\s*$/.test(cell));
      if (!isSeparatorRow) {
        const rowSegments: SegmentLine = [{ text: "│ ", style: "tableCell" }];
        cells.forEach((cell, cellIndex) => {
          if (cellIndex > 0) rowSegments.push({ text: " │ ", style: "tableCell" });
          rowSegments.push(...parseInlineSegments(cell.trim()));
        });
        rowSegments.push({ text: " │", style: "tableCell" });
        out.push(rowSegments);
      }
      index += 1;
      continue;
    }

    if (line.trim().length === 0) {
      out.push([]);
      index += 1;
      continue;
    }

    out.push(parseInlineSegments(line));
    index += 1;
  }

  return { lines: out, codeBlocks };
}

function isFence(line: string): boolean {
  return /^\s*(```|~~~)/.test(line);
}

function extractFenceLanguage(line: string): string {
  const match = /^\s*(```|~~~)\s*([\w+#-]*)/.exec(line);
  return match?.[2] ?? "";
}

function splitTableRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|");
}

const INLINE_PATTERN = /(\*\*([^*]+)\*\*)|(\*([^*]+)\*)|(`([^`]+)`)|(\[([^\]]+)\]\(([^)]+)\))|(~~([^~]+)~~)|(_([^_]+)_)/g;

export function parseInlineSegments(text: string): SegmentLine {
  const segments: SegmentLine = [];
  let lastIndex = 0;

  INLINE_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null = INLINE_PATTERN.exec(text);

  while (match !== null) {
    if (match.index > lastIndex) {
      segments.push({ text: text.slice(lastIndex, match.index), style: "plain" });
    }

    if (match[2] !== undefined) {
      segments.push({ text: match[2], style: "bold" });
    } else if (match[4] !== undefined) {
      segments.push({ text: match[4], style: "italic" });
    } else if (match[6] !== undefined) {
      segments.push({ text: match[6], style: "code" });
    } else if (match[8] !== undefined && match[9] !== undefined) {
      segments.push({ text: match[8], style: "link" });
    } else if (match[11] !== undefined) {
      segments.push({ text: match[11], style: "italic" });
    } else if (match[13] !== undefined) {
      segments.push({ text: match[13], style: "italic" });
    }

    lastIndex = match.index + match[0].length;
    INLINE_PATTERN.lastIndex = lastIndex;
    match = INLINE_PATTERN.exec(text);
  }

  if (lastIndex < text.length) {
    segments.push({ text: text.slice(lastIndex), style: "plain" });
  }

  if (segments.length === 0 && text.length > 0) {
    segments.push({ text, style: "plain" });
  }

  return segments;
}

export function stripMarkdown(text: string): string {
  return renderMarkdown(text)
    .lines.map((line) => line.map((segment) => segment.text).join(""))
    .join("\n");
}

export function countRenderedLines(text: string): number {
  return renderMarkdown(text).lines.length;
}
