import type {
  ChatMessage,
  ImagePart,
  ModelInfo,
  Part,
  StreamRequestSystemBlock,
  TextPart,
  ToolResultPart,
  Usage
} from "../types.js";

export const IMAGE_MEDIA_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;

export function normalizeMediaType(input: string): string {
  const lowered = input.toLowerCase();
  if (lowered === "jpg") return "image/jpeg";
  if (lowered.startsWith("image/")) return lowered;
  return `image/${lowered}`;
}

export interface AnthropicContentBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  source?: { type: string; media_type: string; data: string };
  thinking?: string;
  signature?: string;
  tool_use_id?: string;
  content?: string | Array<AnthropicContentBlock>;
  is_error?: boolean;
  cache_control?: { type: string };
}

export interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | AnthropicContentBlock[];
}

export function toAnthropicMessages(messages: ChatMessage[]): AnthropicMessage[] {
  const out: AnthropicMessage[] = [];

  for (const message of messages) {
    if (message.role === "assistant") {
      out.push({ role: "assistant", content: assistantBlocks(message.parts) });
      continue;
    }

    const userBlocks = collectUserBlocks(message.parts);
    if (userBlocks.length === 0) continue;

    const previous = out[out.length - 1];
    if (previous && previous.role === "user" && Array.isArray(previous.content)) {
      previous.content.push(...userBlocks);
    } else {
      out.push({ role: "user", content: userBlocks });
    }
  }

  return mergeConsecutiveUserTurns(out);
}

function assistantBlocks(parts: Part[]): AnthropicContentBlock[] {
  const blocks: AnthropicContentBlock[] = [];
  for (const part of parts) {
    switch (part.type) {
      case "text":
        if (part.text.trim().length > 0) blocks.push({ type: "text", text: part.text });
        break;
      case "thinking":
        if (part.thinking.trim().length > 0) {
          const block: AnthropicContentBlock = { type: "thinking", thinking: part.thinking };
          if (part.signature) block.signature = part.signature;
          blocks.push(block);
        }
        break;
      case "tool_call":
        blocks.push({ type: "tool_use", id: part.id, name: part.name, input: part.input });
        break;
      case "tool_result":
      case "image":
        break;
    }
  }
  return blocks;
}

function collectUserBlocks(parts: Part[]): AnthropicContentBlock[] {
  const blocks: AnthropicContentBlock[] = [];
  for (const part of parts) {
    switch (part.type) {
      case "text": {
        if (part.text.trim().length === 0 && !containsToolResults(parts)) continue;
        blocks.push({ type: "text", text: part.text });
        break;
      }
      case "image":
        blocks.push(imageBlock(part));
        break;
      case "tool_result":
        blocks.push(toolResultBlock(part));
        break;
      default:
        break;
    }
  }
  return blocks;
}

function containsToolResults(parts: Part[]): boolean {
  return parts.some((part) => part.type === "tool_result");
}

function imageBlock(part: ImagePart): AnthropicContentBlock {
  return {
    type: "image",
    source: { type: "base64", media_type: part.mediaType, data: part.data }
  };
}

function toolResultBlock(part: ToolResultPart): AnthropicContentBlock {
  return {
    type: "tool_result",
    tool_use_id: part.toolCallId,
    content: part.content,
    is_error: part.isError || undefined
  };
}

function mergeConsecutiveUserTurns(messages: AnthropicMessage[]): AnthropicMessage[] {
  const merged: AnthropicMessage[] = [];
  for (const message of messages) {
    const tail = merged[merged.length - 1];
    if (
      tail &&
      tail.role === "user" &&
      message.role === "user" &&
      Array.isArray(tail.content) &&
      Array.isArray(message.content)
    ) {
      tail.content.push(...message.content);
      continue;
    }
    merged.push(message);
  }
  return merged;
}

export function buildAnthropicSystem(system: StreamRequestSystemBlock[], cacheEnabled: boolean): AnthropicContentBlock[] {
  return system.map((block, index) => {
    const payload: AnthropicContentBlock = { type: "text", text: block.text };
    if (cacheEnabled && block.cache && index === system.length - 1) {
      payload.cache_control = { type: "ephemeral" };
    }
    return payload;
  });
}

export interface OpenAiChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | Array<{ type: string; text?: string; image_url?: { url: string } }>;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
  reasoning_content?: string;
}

export function toOpenAiMessages(systemText: string, messages: ChatMessage[]): OpenAiChatMessage[] {
  const out: OpenAiChatMessage[] = [];
  if (systemText.trim().length > 0) {
    out.push({ role: "system", content: systemText });
  }

  for (const message of messages) {
    if (message.role === "assistant") {
      const textParts: string[] = [];
      const toolCalls: NonNullable<OpenAiChatMessage["tool_calls"]> = [];
      let reasoning: string | undefined;

      for (const part of message.parts) {
        if (part.type === "text" && part.text.trim().length > 0) textParts.push(part.text);
        else if (part.type === "thinking" && part.thinking.trim().length > 0) reasoning = part.thinking;
        else if (part.type === "tool_call") {
          toolCalls.push({
            id: part.id,
            type: "function",
            function: { name: part.name, arguments: JSON.stringify(part.input ?? {}) }
          });
        }
      }

      const chatMessage: OpenAiChatMessage = {
        role: "assistant",
        content: textParts.join("\n")
      };
      if (toolCalls.length > 0) chatMessage.tool_calls = toolCalls;
      if (reasoning !== undefined) chatMessage.reasoning_content = reasoning;
      out.push(chatMessage);
      continue;
    }

    const toolResults = message.parts.filter(
      (part): part is ToolResultPart => part.type === "tool_result"
    );
    for (const result of toolResults) {
      out.push({
        role: "tool",
        tool_call_id: result.toolCallId,
        content: result.content
      });
    }

    const restParts = message.parts.filter((part) => part.type !== "tool_result");
    if (restParts.length > 0) {
      out.push({ role: "user", content: openAiUserContent(restParts) });
    }
  }

  return out;
}

function openAiUserContent(parts: Part[]): OpenAiChatMessage["content"] {
  if (!parts.some((part) => part.type === "image")) {
    return parts
      .filter((part): part is TextPart => part.type === "text")
      .map((part) => part.text)
      .join("\n");
  }

  const segments: Array<{ type: string; text?: string; image_url?: { url: string } }> = [];
  for (const part of parts) {
    if (part.type === "text") segments.push({ type: "text", text: part.text });
    else if (part.type === "image") {
      segments.push({
        type: "image_url",
        image_url: { url: `data:${part.mediaType};base64,${part.data}` }
      });
    }
  }
  return segments;
}

export function estimateTokensFromText(text: string): number {
  if (text.length === 0) return 0;
  const asciiRuns = text.match(/[\x20-\x7e]+/g)?.join("") ?? "";
  const nonAsciiLength = text.length - asciiRuns.length;
  const asciiTokens = Math.ceil(asciiRuns.length / 4);
  const nonAsciiTokens = Math.ceil(nonAsciiLength / 1.6);
  return asciiTokens + nonAsciiTokens;
}

export function estimateTokensFromMessages(messages: ChatMessage[]): number {
  let total = 0;
  for (const message of messages) {
    for (const part of message.parts) {
      switch (part.type) {
        case "text":
          total += estimateTokensFromText(part.text);
          break;
        case "thinking":
          total += estimateTokensFromText(part.thinking);
          break;
        case "tool_call":
          total += estimateTokensFromText(JSON.stringify(part.input ?? {}));
          total += 12;
          break;
        case "tool_result":
          total += estimateTokensFromText(part.content);
          break;
        case "image":
          total += 1100;
          break;
      }
    }
    total += 4;
  }
  return total;
}

export function usageTotals(usage: Usage): number {
  return (
    usage.inputTokens +
    usage.outputTokens +
    usage.cacheReadTokens +
    usage.cacheWriteTokens +
    usage.reasoningTokens
  );
}

export function describeModel(model: ModelInfo): string {
  const flags: string[] = [];
  if (model.supportsTools) flags.push("tools");
  if (model.supportsThinking) flags.push("thinking");
  if (model.supportsImages) flags.push("vision");
  if (model.supportsCacheControl) flags.push("cache");
  return `${model.label} [${flags.join(", ")}] ctx=${(model.contextWindow / 1000).toFixed(0)}k`;
}
