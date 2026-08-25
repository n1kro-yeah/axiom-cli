import picocolors from "picocolors";
import type { RuntimeBundle } from "./bootstrap.js";
import type { AgentEvent, ChatMessage } from "../types.js";
import { renderMarkdown, stripMarkdown } from "../ui/markdown.js";
import { errorMessage } from "../util/errors.js";

export type HeadlessOutputFormat = "text" | "json" | "stream-json";

export interface HeadlessOptions {
  prompt: string;
  format: HeadlessOutputFormat;
  quiet: boolean;
  maxTurns?: number;
}

export interface HeadlessOutcome {
  exitCode: number;
  text: string;
  message: ChatMessage | undefined;
  errorText?: string;
}

export async function runHeadless(bundle: RuntimeBundle, options: HeadlessOptions): Promise<HeadlessOutcome> {
  const { agent } = bundle;
  const isJsonish = options.format !== "text";

  let finalMessage: ChatMessage | undefined;
  let collectedError: string | undefined;
  const startedAt = Date.now();

  if (options.format === "stream-json") emitStreamJson({ type: "run_started", prompt: options.prompt });

  const off = agent.on((event: AgentEvent) => {
    switch (event.type) {
      case "assistant_finished":
        finalMessage = event.message;
        if (options.format === "stream-json") {
          emitStreamJson({
            type: "assistant_message",
            id: event.message.id,
            model: event.message.model,
            usage: event.message.usage,
            cost_usd: event.message.costUSD,
            stop_reason: event.message.stopReason,
            parts: event.message.parts.map(serializePart)
          });
        }
        break;

      case "text_delta":
        if (options.format === "stream-json") {
          emitStreamJson({ type: "text_delta", delta: event.delta });
        }
        break;

      case "tool_started":
        if (options.format === "stream-json") {
          emitStreamJson({ type: "tool_started", name: event.name, call_id: event.callId, input: event.input });
        }
        break;

      case "tool_progress":
        if (options.format === "stream-json" && !isNoise(event.line)) {
          emitStreamJson({ type: "tool_progress", call_id: event.callId, line: event.line.slice(0, 300) });
        }
        break;

      case "tool_finished":
        if (options.format === "stream-json") {
          emitStreamJson({
            type: "tool_finished",
            call_id: event.callId,
            is_error: event.result.isError,
            content_preview: event.result.content.slice(0, 800)
          });
        }
        break;

      case "notice":
        if (!options.quiet && !isJsonish) {
          const colorize =
            event.level === "error"
              ? picocolors.red
              : event.level === "warn"
                ? picocolors.yellow
                : picocolors.dim;
          process.stderr.write(`${colorize("ℹ")} ${event.text}\n`);
        }
        if (event.level === "error") collectedError = event.text;
        break;

      case "status_changed":
        if (event.status === "error" && !collectedError) {
          collectedError = "agent ended in error state";
        }
        break;

      default:
        break;
    }
  });

  try {
    await agent.send(options.prompt);
  } catch (error) {
    collectedError = errorMessage(error);
  }

  off();

  await bundle.sessions.updateMeta(bundle.sessionId, (draft) => {
    draft.messageCount = agent.messages.length;
    draft.totalCostUSD = agent.cost;
    draft.totalUsage = agent.usage;
    if (draft.title === "New session") {
      draft.title = deriveHeadlessTitle(options.prompt);
    }
  });
  void bundle.mcp.shutdown().catch(() => undefined);
  await bundle.lsp?.shutdownAll().catch(() => undefined);

  const text = extractFinalText(finalMessage);

  if (options.format === "json") {
    const payload = {
      ok: !collectedError,
      session_id: bundle.sessionId,
      duration_ms: Date.now() - startedAt,
      result: text,
      usage: agent.usage,
      cost_usd: Number(agent.cost.toFixed(6)),
      model: agent.modelReference,
      error: collectedError
    };
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  } else if (options.format === "text" && !options.quiet && text.length > 0) {
    process.stdout.write(`${renderPlain(text)}\n`);
  } else if (options.format === "text" && !options.quiet && text.length === 0) {
    process.stdout.write("(no response)\n");
  }

  return {
    exitCode: collectedError ? 1 : 0,
    text,
    message: finalMessage,
    errorText: collectedError
  };
}

function serializePart(part: ChatMessage["parts"][number]): Record<string, unknown> {
  switch (part.type) {
    case "text":
      return { type: "text", text: part.text };
    case "thinking":
      return { type: "thinking", chars: part.thinking.length };
    case "tool_call":
      return { type: "tool_call", id: part.id, name: part.name, input: part.input };
    case "tool_result":
      return { type: "tool_result", tool_call_id: part.toolCallId, name: part.name, is_error: part.isError, chars: part.content.length };
    default:
      return { type: part.type };
  }
}

function emitStreamJson(payload: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function extractFinalText(message: ChatMessage | undefined): string {
  if (!message) return "";
  return message.parts
    .filter((part) => part.type === "text")
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("\n")
    .trim();
}

function renderPlain(text: string): string {
  if (supportsColor()) return renderAnsi(text);
  return stripMarkdown(text);
}

function renderAnsi(text: string): string {
  const rendered = renderMarkdown(text);
  const lines: string[] = [];

  for (const line of rendered.lines) {
    if (line.length === 0) {
      lines.push("");
      continue;
    }
    let out = "";
    for (const segment of line) {
      out += styleSegment(segment.style, segment.text);
    }
    lines.push(out.replace(/\u001b\[0m$/, ""));
  }

  return lines.join("\n");
}

function styleSegment(style: string, text: string): string {
  switch (style) {
    case "bold":
    case "heading1":
    case "heading2":
    case "heading3":
      return picocolors.bold(text);
    case "code":
      return picocolors.green(text);
    case "link":
      return picocolors.cyan(picocolors.underline(text));
    case "quote":
      return picocolors.italic(picocolors.gray(text));
    case "listMarker":
      return picocolors.blue(text);
    case "hr":
      return picocolors.gray(text);
    default:
      return text;
  }
}

function supportsColor(): boolean {
  if (process.env["NO_COLOR"]) return false;
  if (process.env["FORCE_COLOR"]) return true;
  return process.stdout.isTTY === true || process.platform === "win32";
}

function deriveHeadlessTitle(prompt: string): string {
  const firstLine = prompt.split("\n")[0].trim();
  return firstLine.slice(0, 60) || "headless run";
}

function isNoise(line: string): boolean {
  return line.trim().length === 0;
}
