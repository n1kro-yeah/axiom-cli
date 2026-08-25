import type { ChatMessage, ModelInfo, ProviderAdapter, Usage } from "../types.js";
import { createMessageId, emptyUsage } from "../types.js";
import { createLogger } from "../util/log.js";
import { estimateTokensFromMessages } from "../providers/wire.js";
import { COMPACTION_PROMPT_EN, COMPACTION_PROMPT_RU } from "./prompt.js";

const log = createLogger("compact");

export interface CompactionResult {
  summary: ChatMessage;
  keptMessages: ChatMessage[];
  removedCount: number;
  tokensSaved: number;
  usage: Usage;
}

export interface CompactionOptions {
  language?: "en" | "ru";
  keepRecentUserTurns?: number;
  maxSummaryTokens?: number;
  customInstructions?: string;
}

export function shouldCompact(
  estimatedContextTokens: number,
  model: ModelInfo,
  thresholdPercent: number
): boolean {
  if (model.contextWindow <= 0) return false;
  const ratio = estimatedContextTokens / model.contextWindow;
  return ratio >= thresholdPercent;
}

export function estimateContextSize(messages: ChatMessage[], systemText: string): number {
  return estimateTokensFromMessages(messages) + Math.ceil(systemText.length / 4);
}

export async function compactConversation(
  messages: ChatMessage[],
  adapter: ProviderAdapter,
  modelId: string,
  options: CompactionOptions = {}
): Promise<CompactionResult> {
  if (messages.length === 0) throw new Error("Nothing to compact");

  const keepRecent = options.keepRecentUserTurns ?? 4;
  const boundary = findCompactionBoundary(messages, keepRecent);
  const toSummarize = messages.slice(0, boundary);
  const toKeep = messages.slice(boundary);

  if (toSummarize.length === 0) {
    throw new Error("Not enough history to compact");
  }

  const promptLanguage = options.language === "ru" ? COMPACTION_PROMPT_RU : COMPACTION_PROMPT_EN;
  const instructions = options.customInstructions
    ? `\n\nAdditional user instructions for the summary:\n${options.customInstructions}`
    : "";

  const requestMessages: ChatMessage[] = [
    ...toSummarize,
    {
      id: createMessageId(),
      role: "user",
      parts: [{ type: "text", text: `${promptLanguage}${instructions}` }],
      timestamp: Date.now()
    }
  ];

  const usage = emptyUsage();
  let summaryText = "";
  let failure: Error | undefined;

  for await (const event of adapter.stream(
    {
      model: modelId,
      system: [{ text: "You are a precise summarization engine. Output only the requested summary.", cache: false }],
      messages: stripToolCallsForSummary(requestMessages),
      tools: [],
      maxTokens: options.maxSummaryTokens ?? 2400,
      temperature: 0.2
    },
    new AbortController().signal
  )) {
    if (event.type === "text_delta") summaryText += event.delta;
    else if (event.type === "usage_delta" && event.usage.outputTokens) usage.outputTokens += event.usage.outputTokens;
    else if (event.type === "usage_delta" && event.usage.inputTokens) usage.inputTokens += event.usage.inputTokens;
    else if (event.type === "error") failure = new Error(event.message);
    else if (event.type === "done") break;
  }

  if (failure) throw failure;

  const cleaned = summaryText.trim();
  if (cleaned.length < 20) {
    throw new Error(`Compaction produced an implausibly short summary (${cleaned.length} chars)`);
  }

  const tokensBefore = estimateTokensFromMessages(toSummarize);
  const summary: ChatMessage = {
    id: createMessageId(),
    role: "user",
    parts: [{ type: "text", text: `[CONTEXT SUMMARY — earlier conversation was compacted]\n\n${cleaned}` }],
    timestamp: Date.now(),
    summary: true
  };

  log.info(
    `compacted ${toSummarize.length} messages into ${cleaned.length} chars; saved ~${tokensBefore - Math.ceil(cleaned.length / 4)} tokens`
  );

  return {
    summary,
    keptMessages: [summary, ...toKeep],
    removedCount: toSummarize.length,
    tokensSaved: Math.max(tokensBefore - Math.ceil(cleaned.length / 4), 0),
    usage
  };
}

function findCompactionBoundary(messages: ChatMessage[], keepRecentUserTurns: number): number {
  let userTurnsSeen = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || message.role !== "user") continue;
    userTurnsSeen += 1;
    if (userTurnsSeen > keepRecentUserTurns) {
      return Math.max(index, 1);
    }
  }
  return 1;
}

function stripToolCallsForSummary(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((message) => {
    const hasHeavyParts = message.parts.some((part) => part.type === "tool_call" || part.type === "tool_result");
    if (!hasHeavyParts) return message;

    const parts = message.parts.map((part) => {
      if (part.type === "tool_result") {
        const truncated = part.content.length > 800 ? `${part.content.slice(0, 800)}…[truncated]` : part.content;
        return { ...part, content: truncated };
      }
      return part;
    });

    return { ...message, parts };
  });
}
