import type { ProviderAdapter, ChatMessage, TextPart } from "../types.js";
import { createLogger } from "../util/log.js";
import { TITLE_PROMPT } from "./prompt.js";

const log = createLogger("title");

const MAX_TITLE_WORDS = 8;
const MAX_TITLE_CHARS = 64;

export interface TitleGeneratorOptions {
  minMessagesBeforeCall: number;
  timeoutMs: number;
}

const DEFAULT_OPTIONS: TitleGeneratorOptions = {
  minMessagesBeforeCall: 1,
  timeoutMs: 12000
};

export class TitleGenerator {
  private lastGeneratedFor: string | null = null;
  private cachedTitle: string | null = null;
  private inFlight: Promise<string | null> | null = null;
  private readonly options: TitleGeneratorOptions;

  constructor(options: Partial<TitleGeneratorOptions> = {}) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  async generate(messages: ChatMessage[], adapter: ProviderAdapter, modelId: string): Promise<string | null> {
    const firstUserText = extractFirstUserText(messages);
    if (!firstUserText) return null;

    const fingerprint = fingerprintConversation(messages);
    if (fingerprint === this.lastGeneratedFor && this.cachedTitle) {
      return this.cachedTitle;
    }
    if (this.inFlight) return this.inFlight;

    this.inFlight = this.callModel(firstUserText, adapter, modelId)
      .then((title) => {
        if (title) {
          this.lastGeneratedFor = fingerprint;
          this.cachedTitle = title;
        }
        return title;
      })
      .catch((error) => {
        log.debug("title generation failed", error);
        return heuristicTitle(firstUserText);
      })
      .finally(() => {
        this.inFlight = null;
      });

    return this.inFlight;
  }

  immediateFallback(messages: ChatMessage[]): string {
    const text = extractFirstUserText(messages);
    return text ? heuristicTitle(text) : "New session";
  }

  private async callModel(text: string, adapter: ProviderAdapter, modelId: string): Promise<string | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs);

    try {
      let collected = "";
      for await (const event of adapter.stream(
        {
          model: modelId,
          system: [{ text: TITLE_PROMPT, cache: false }],
          messages: [
            {
              id: "title_req",
              role: "user",
              parts: [{ type: "text", text }],
              timestamp: Date.now()
            }
          ],
          tools: [],
          maxTokens: 60,
          temperature: 0.3
        },
        controller.signal
      )) {
        if (event.type === "text_delta") collected += event.delta;
        else if (event.type === "error") throw new Error(event.message);
        else if (event.type === "done") break;
      }

      const cleaned = cleanTitle(collected);
      return cleaned.length > 0 ? cleaned : null;
    } finally {
      clearTimeout(timer);
    }
  }
}

function extractFirstUserText(messages: ChatMessage[]): string | undefined {
  for (const message of messages) {
    if (message.role !== "user") continue;
    const texts = message.parts
      .filter((part): part is TextPart => part.type === "text")
      .map((part) => part.text.trim())
      .filter((text) => text.length > 0);
    if (texts.length > 0) return texts.join("\n").slice(0, 2000);
  }
  return undefined;
}

function cleanTitle(raw: string): string {
  let title = raw.trim();
  title = title.replace(/^[\"'`\u00ab\u00bb]+|[\"'`\u00ab\u00bb]+$/g, "");
  title = title.replace(/^(заголовок|title|тема)\s*[:\-—]\s*/i, "");
  title = title.split("\n")[0].trim();
  title = title.replace(/[.!?…]+$/, "");

  const words = title.split(/\s+/);
  if (words.length > MAX_TITLE_WORDS) {
    title = words.slice(0, MAX_TITLE_WORDS).join(" ");
  }
  if (title.length > MAX_TITLE_CHARS) {
    title = `${title.slice(0, MAX_TITLE_CHARS - 1).trimEnd()}…`;
  }
  return title;
}

function heuristicTitle(text: string): string {
  const firstLine = text.split("\n")[0].trim();
  let words = firstLine.split(/\s+/);
  if (words[0]?.startsWith("/")) {
    words = words.slice(1);
  }
  let candidate = words.slice(0, MAX_TITLE_WORDS).join(" ");
  if (candidate.length > MAX_TITLE_CHARS) {
    candidate = `${candidate.slice(0, MAX_TITLE_CHARS - 1).trimEnd()}…`;
  }
  return candidate.length > 0 ? candidate : "New session";
}

function fingerprintConversation(messages: ChatMessage[]): string {
  const firstUser = messages.find((message) => message.role === "user");
  if (!firstUser) return "";
  const firstText = firstUser.parts.find((part) => part.type === "text");
  return firstText && firstText.type === "text" ? firstText.text.slice(0, 120) : String(firstUser.id);
}
