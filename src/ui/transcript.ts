import type { AgentEvent, ChatMessage } from "../types.js";

export type ToolState = "running" | "ok" | "error" | "denied";

export interface UserBubble {
  kind: "user";
  id: string;
  text: string;
}

export interface AssistantBubble {
  kind: "assistant";
  id: string;
  text: string;
  thinking: string;
  streaming: boolean;
}

export interface DiffRow {
  tag: "+" | "-" | "@" | " ";
  text: string;
}

export interface ToolBubble {
  kind: "tool";
  id: string;
  name: string;
  summary: string;
  state: ToolState;
  progress: string[];
  diffRows: DiffRow[] | null;
  added: number;
  removed: number;
  preview: string[] | null;
  isError: boolean;
}

export interface NoticeBubble {
  kind: "notice";
  id: string;
  level: "info" | "warn" | "error";
  text: string;
}

export type Bubble = UserBubble | AssistantBubble | ToolBubble | NoticeBubble;

let bubbleCounter = 0;

function nextBubbleId(prefix: string): string {
  bubbleCounter += 1;
  return `${prefix}_${bubbleCounter}`;
}

export function bubblesFromMessages(messages: ChatMessage[]): Bubble[] {
  const bubbles: Bubble[] = [];
  const resultById = new Map<string, { isError: boolean; content: string }>();

  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type === "tool_result") {
        resultById.set(part.toolCallId, { isError: part.isError, content: part.content });
      }
    }
  }

  for (const message of messages) {
    if (message.role === "user") {
      const text = message.parts
        .filter((part) => part.type === "text")
        .map((part) => (part.type === "text" ? part.text : ""))
        .join("\n");
      if (text.trim().length > 0) {
        bubbles.push({ kind: "user", id: message.id, text });
      }
      continue;
    }

    let assistantText = "";
    let assistantThinking = "";
    let assistantId: string | null = null;

    for (const part of message.parts) {
      if (part.type === "text") {
        assistantText += (assistantText ? "\n" : "") + part.text;
        if (assistantId === null) assistantId = `${message.id}_a`;
      } else if (part.type === "thinking") {
        assistantThinking += (assistantThinking ? "\n" : "") + part.thinking;
        if (assistantId === null) assistantId = `${message.id}_a`;
      } else if (part.type === "tool_call") {
        if (assistantText.trim().length > 0 || assistantThinking.trim().length > 0) {
          bubbles.push({
            kind: "assistant",
            id: assistantId ?? nextBubbleId("as"),
            text: assistantText,
            thinking: assistantThinking,
            streaming: false
          });
          assistantText = "";
          assistantThinking = "";
          assistantId = null;
        }

        const result = resultById.get(part.id);
        const summary = toolSummary(part.name, part.input);
        const diffRows = result ? extractDiffRows(result.content) : null;
        bubbles.push({
          kind: "tool",
          id: part.id,
          name: part.name,
          summary,
          state: result ? (result.isError ? "error" : "ok") : "ok",
          progress: [],
          diffRows,
          added: 0,
          removed: 0,
          preview: result && !diffRows ? previewLines(result.content) : null,
          isError: result?.isError ?? false
        });
      }
    }

    if (assistantText.trim().length > 0 || assistantThinking.trim().length > 0) {
      bubbles.push({
        kind: "assistant",
        id: assistantId ?? nextBubbleId("as"),
        text: assistantText,
        thinking: assistantThinking,
        streaming: false
      });
    }

    if (message.errorMessage) {
      bubbles.push({ kind: "notice", id: `${message.id}_err`, level: "error", text: message.errorMessage });
    }
  }

  return bubbles;
}

export function applyAgentEvents(bubbles: Bubble[], events: AgentEvent[]): Bubble[] {
  const working = bubbles.map((bubble) => ({ ...bubble })) as Bubble[];

  for (const event of events) {
    applyOne(working, event);
  }

  return working;
}

function applyOne(bubbles: Bubble[], event: AgentEvent): void {
  switch (event.type) {
    case "user_message_added": {
      const text = event.message.parts
        .filter((part) => part.type === "text")
        .map((part) => (part.type === "text" ? part.text : ""))
        .join("\n");
      if (text.trim().length > 0) {
        bubbles.push({ kind: "user", id: event.message.id, text });
      }
      break;
    }

    case "assistant_started": {
      bubbles.push({
        kind: "assistant",
        id: event.messageId,
        text: "",
        thinking: "",
        streaming: true
      });
      break;
    }

    case "text_delta": {
      const target = lastAssistant(bubbles);
      if (target) target.text += event.delta;
      break;
    }

    case "thinking_delta": {
      const target = lastAssistant(bubbles);
      if (target && event.delta.length > 0) target.thinking += event.delta;
      break;
    }

    case "assistant_finished": {
      const index = findLastIndex(bubbles, (bubble) => bubble.kind === "assistant" && bubble.id === event.message.id);
      if (index !== -1) {
        const bubble = bubbles[index];
        if (bubble && bubble.kind === "assistant") {
          bubble.text = joinedText(event.message);
          bubble.thinking = joinedThinking(event.message);
          bubble.streaming = false;
        }
      } else {
        const text = joinedText(event.message);
        const thinking = joinedThinking(event.message);
        if (text.trim().length > 0 || thinking.trim().length > 0) {
          bubbles.push({
            kind: "assistant",
            id: event.message.id,
            text,
            thinking,
            streaming: false
          });
        }
      }
      break;
    }

    case "tool_started": {
      bubbles.push({
        kind: "tool",
        id: event.callId,
        name: event.name,
        summary: toolSummary(event.name, event.input),
        state: "running",
        progress: [],
        diffRows: null,
        added: 0,
        removed: 0,
        preview: null,
        isError: false
      });
      break;
    }

    case "tool_progress": {
      const target = findTool(bubbles, event.callId);
      if (target) {
        target.progress = [...target.progress.slice(-2), event.line];
      }
      break;
    }

    case "tool_finished": {
      const target = findTool(bubbles, event.callId);
      if (!target) break;
      const denied = /user denied|permission denied/i.test(event.result.content);
      target.state = event.result.isError ? (denied ? "denied" : "error") : "ok";
      target.isError = event.result.isError;
      target.progress = [];

      const metadata = event.result.metadata ?? {};
      const diffText = typeof metadata["diff"] === "string" ? metadata["diff"] : null;
      if (diffText) {
        target.diffRows = parseDiffRows(diffText);
        target.added = typeof metadata["additions"] === "number" ? metadata["additions"] : 0;
        target.removed = typeof metadata["deletions"] === "number" ? metadata["deletions"] : 0;
      } else if (!event.result.isError) {
        target.preview = previewLines(event.result.content);
      } else {
        target.preview = previewLines(event.result.content);
      }
      break;
    }

    case "notice": {
      bubbles.push({
        kind: "notice",
        id: nextBubbleId("nt"),
        level: event.level,
        text: event.text
      });
      break;
    }

    default:
      break;
  }
}

function lastAssistant(bubbles: Bubble[]): AssistantBubble | undefined {
  for (let index = bubbles.length - 1; index >= 0; index -= 1) {
    const bubble = bubbles[index];
    if (bubble && bubble.kind === "assistant") return bubble;
  }
  return undefined;
}

function findTool(bubbles: Bubble[], callId: string): ToolBubble | undefined {
  for (let index = bubbles.length - 1; index >= 0; index -= 1) {
    const bubble = bubbles[index];
    if (bubble && bubble.kind === "tool" && bubble.id === callId) return bubble;
  }
  return undefined;
}

function findLastIndex(bubbles: Bubble[], predicate: (bubble: Bubble) => boolean): number {
  for (let index = bubbles.length - 1; index >= 0; index -= 1) {
    if (predicate(bubbles[index])) return index;
  }
  return -1;
}

function joinedText(message: ChatMessage): string {
  return message.parts
    .filter((part) => part.type === "text")
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("\n");
}

function joinedThinking(message: ChatMessage): string {
  return message.parts
    .filter((part) => part.type === "thinking")
    .map((part) => (part.type === "thinking" ? part.thinking : ""))
    .join("\n");
}

export function firstMutableBubbleIndex(bubbles: Bubble[]): number {
  return bubbles.findIndex(
    (bubble) =>
      (bubble.kind === "assistant" && bubble.streaming) ||
      (bubble.kind === "tool" && bubble.state === "running")
  );
}

export function toolSummary(name: string, input: unknown): string {
  const record =
    input !== null && typeof input === "object" && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : {};

  switch (name) {
    case "bash":
      return `$ ${String(record["command"] ?? "").replace(/\s+/g, " ").slice(0, 110)}`;
    case "read":
    case "write":
    case "edit":
    case "patch":
      return `${name} ${String(record["file_path"] ?? record["path"] ?? "")}`;
    case "glob":
      return `glob ${record["pattern"] ?? ""}`;
    case "grep":
      return `grep ${record["pattern"] ?? ""}${record["include"] ? ` in ${record["include"]}` : ""}`;
    case "ls":
      return `ls ${record["path"] ?? "."}`;
    case "fetch":
      return `fetch ${record["url"] ?? ""}`;
    case "task":
      return `task: ${String(record["description"] ?? "").slice(0, 90)}`;
    case "todo_write":
      return `todo (${Array.isArray(record["todos"]) ? record["todos"].length : 0} items)`;
    case "lsp_diagnostics":
      return `diagnostics ${record["file_path"] ?? ""}`.trim();
    default:
      return `${name} ${JSON.stringify(record).slice(0, 80)}`;
  }
}

export function parseDiffRows(diffText: string): DiffRow[] {
  const rows: DiffRow[] = [];
  for (const raw of diffText.replace(/\r\n/g, "\n").split("\n")) {
    if (raw.startsWith("--- ") || raw.startsWith("+++ ")) continue;
    if (raw.startsWith("@@")) {
      rows.push({ tag: "@", text: raw });
      continue;
    }
    if (raw.startsWith("+")) rows.push({ tag: "+", text: raw.slice(1) });
    else if (raw.startsWith("-")) rows.push({ tag: "-", text: raw.slice(1) });
    else rows.push({ tag: " ", text: raw.slice(1) });
  }
  return rows.slice(0, 60);
}

function extractDiffRows(content: string): DiffRow[] | null {
  if (!content.includes("@@") && !content.split("\n").some((line) => line.startsWith("+") || line.startsWith("-"))) {
    return null;
  }
  if (!content.includes("@@")) return null;
  return parseDiffRows(content);
}

export function previewLines(content: string): string[] {
  const lines = content
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0);
  if (lines.length <= 6) return lines;
  return [...lines.slice(0, 6), `… ${lines.length - 6} more lines`];
}

export function charWidth(char: string): number {
  const code = char.codePointAt(0) ?? 0;
  if (code >= 0x1100 && (code <= 0x115f || code >= 0x2e80)) return 2;
  return 1;
}

export function wrapVisualLine(line: string, columns: number): string[] {
  if (line === "") return [""];
  const rows: string[] = [];
  let current = "";
  let currentWidth = 0;
  for (const char of line) {
    const width = charWidth(char);
    if (current !== "" && currentWidth + width > columns) {
      rows.push(current);
      current = "";
      currentWidth = 0;
    }
    current += char;
    currentWidth += width;
  }
  if (current !== "" || rows.length === 0) rows.push(current);
  return rows;
}

export function clipTextToRows(text: string, maxRows: number, columns: number): string {
  if (text === "" || maxRows <= 0) return "";
  const width = Number.isFinite(columns) ? Math.max(1, Math.floor(columns)) : 80;
  const rows = text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .flatMap((line) => wrapVisualLine(line, width));
  if (rows.length <= maxRows) return rows.join("\n");
  const tail = rows.slice(-Math.max(1, maxRows - 1));
  return maxRows === 1 ? (tail[tail.length - 1] ?? "") : ["…", ...tail].join("\n");
}
