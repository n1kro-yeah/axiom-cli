import type {
  ModelInfo,
  ProviderAdapter,
  StreamEvent,
  StreamRequest,
  Usage
} from "../types.js";
import { emptyUsage } from "../types.js";
import { buildCatalogForProvider, findCatalogModel, fallbackModelInfo } from "./models.js";
import { createLogger } from "../util/log.js";
import { consumeSseStream, fetchWithTimeout, safeJsonParse, AsyncQueue } from "../util/sse.js";
import { toOpenAiMessages } from "./wire.js";
import type { OpenAiChatMessage } from "./wire.js";

const log = createLogger("openai");

export interface OpenAiAdapterOptions {
  providerId: string;
  label: string;
  providerType: string;
  apiKey?: string;
  baseUrl: string;
  extraHeaders?: Record<string, string>;
  timeoutMs?: number;
  supportsStreamOptions?: boolean;
  supportsDeveloperRole?: boolean;
}

interface OpenAiStreamChunk {
  id?: string;
  object?: string;
  model?: string;
  choices?: Array<{
    index?: number;
    delta?: {
      role?: string;
      content?: string | null;
      reasoning_content?: string | null;
      tool_calls?: Array<{
        index?: number;
        id?: string;
        type?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason?: string | null;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
    completion_tokens_details?: { reasoning_tokens?: number };
  };
}

const LOCAL_PROVIDERS = new Set(["ollama", "lmstudio"]);

export class OpenAiCompatibleAdapter implements ProviderAdapter {
  readonly id: string;
  readonly label: string;

  private readonly options: OpenAiAdapterOptions;

  constructor(options: OpenAiAdapterOptions) {
    this.options = options;
    this.id = options.providerId;
    this.label = options.label;
  }

  private get isLocal(): boolean {
    return LOCAL_PROVIDERS.has(this.id) || /localhost|127\.0\.0\.1/.test(this.options.baseUrl);
  }

  listModels(): ModelInfo[] {
    return buildCatalogForProvider(this.id, this.options.providerType);
  }

  hasModel(): boolean {
    return true;
  }

  resolveModel(modelId: string): ModelInfo {
    const known =
      findCatalogModel(this.id, this.options.providerType, modelId) ??
      fallbackModelInfo(this.id, modelId);
    if (this.isLocal) {
      return { ...known, supportsCacheControl: false };
    }
    return known;
  }

  estimateCost(model: ModelInfo, usage: Usage): number {
    const pricing = model.pricing;
    if (!pricing) return 0;
    const input = (usage.inputTokens / 1_000_000) * pricing.inputPerMillion;
    const output = (usage.outputTokens / 1_000_000) * pricing.outputPerMillion;
    const cacheRead = ((pricing.cacheReadPerMillion ?? 0) * usage.cacheReadTokens) / 1_000_000;
    return Number((input + output + cacheRead).toFixed(6));
  }

  async *stream(request: StreamRequest, signal: AbortSignal): AsyncIterable<StreamEvent> {
    const modelInfo = this.resolveModel(request.model);
    const url = `${this.options.baseUrl.replace(/\/$/, "")}/chat/completions`;

    const messages = toOpenAiMessages(
      request.system.map((block) => block.text).join("\n\n"),
      request.messages
    );

    const payload: Record<string, unknown> = {
      model: modelInfo.id,
      messages,
      stream: true
    };

    if (request.tools.length > 0 && modelInfo.supportsTools) {
      payload["tools"] = request.tools.map((tool) => ({
        type: "function",
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters
        }
      }));
      payload["tool_choice"] = "auto";
    }

    if (request.maxTokens > 0) payload["max_tokens"] = Math.min(request.maxTokens, modelInfo.maxOutputTokens);
    if (request.temperature !== undefined) payload["temperature"] = request.temperature;

    if (this.options.supportsStreamOptions !== false && !this.isLocal) {
      payload["stream_options"] = { include_usage: true };
    }

    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "text/event-stream",
      ...(this.options.extraHeaders ?? {})
    };

    if (this.options.apiKey && !this.isLocal) {
      headers["authorization"] = `Bearer ${this.options.apiKey}`;
    } else if (this.options.apiKey) {
      headers["authorization"] = `Bearer ${this.options.apiKey}`;
    }

    yield { type: "start", provider: this.id, model: modelInfo.id };

    let response: Response;
    try {
      response = await fetchWithTimeout(url, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
        signal,
        timeoutMs: this.options.timeoutMs ?? 480000
      });
    } catch (error) {
      yield translateConnectionError(error);
      yield { type: "done" };
      return;
    }

    if (!response.ok || !response.body) {
      yield response.ok
        ? ({ type: "error", message: "Empty response body", retryable: false } as StreamEvent)
        : await describeHttpError(response);
      yield { type: "done" };
      return;
    }

    const openToolCalls = new Map<number, { id: string; name: string; args: string }>();
    const usage = emptyUsage();
    let sawFinishReason = false;

    const queue = new AsyncQueue<OpenAiStreamChunk>();
    const completion = consumeSseStream(response.body, (event) => {
      if (event.data === "[DONE]") {
        queue.end();
        return;
      }
      const parsed = safeJsonParse<OpenAiStreamChunk>(event.data);
      if (parsed) queue.push(parsed);
    }, signal)
      .then(() => queue.end())
      .catch((error) => queue.end(signal.aborted ? undefined : error));

    try {
      for await (const chunk of queue) {
        if (chunk.usage) {
          applyUsage(usage, chunk.usage);
          yield { type: "usage_delta", usage: usageFromChunk(chunk.usage) };
        }

        const choice = chunk.choices?.[0];
        if (!choice) continue;
        const delta = choice.delta;

        if (delta?.reasoning_content) {
          yield { type: "thinking_delta", delta: delta.reasoning_content };
        }

        if (typeof delta?.content === "string" && delta.content.length > 0) {
          yield { type: "text_delta", delta: delta.content };
        }

        if (delta?.tool_calls) {
          for (const call of delta.tool_calls) {
            const index = call.index ?? 0;
            if (!openToolCalls.has(index)) {
              const entry = { id: call.id ?? "", name: call.function?.name ?? "", args: "" };
              openToolCalls.set(index, entry);
              if (entry.name.length > 0) {
                yield { type: "tool_call_start", index, id: entry.id, name: entry.name };
              }
            }
            const existing = openToolCalls.get(index);
            if (!existing) continue;
            if (call.id && existing.id.length === 0) existing.id = call.id;
            if (call.function?.name && existing.name.length === 0) {
              existing.name = call.function.name;
              yield { type: "tool_call_start", index, id: existing.id, name: existing.name };
            }
            if (call.function?.arguments) {
              existing.args += call.function.arguments;
              yield { type: "tool_call_delta", index, argsDelta: call.function.arguments };
            }
          }
        }

        if (choice.finish_reason) {
          sawFinishReason = true;
          for (const [index, entry] of [...openToolCalls.entries()].sort((a, b) => a[0] - b[0])) {
            openToolCalls.delete(index);
            yield { type: "tool_call_end", index, id: entry.id, name: entry.name, args: entry.args };
          }
          yield { type: "stop", reason: mapFinishReason(choice.finish_reason) };
        }
      }

      if (!sawFinishReason) {
        for (const [index, entry] of [...openToolCalls.entries()].sort((a, b) => a[0] - b[0])) {
          openToolCalls.delete(index);
          yield { type: "tool_call_end", index, id: entry.id, name: entry.name, args: entry.args };
        }
        if (usage.outputTokens > 0 || usage.inputTokens > 0) {
          yield { type: "stop", reason: "end_turn" };
        }
      }
    } catch (error) {
      if (signal.aborted) {
        yield { type: "stop", reason: "aborted" };
      } else {
        log.error("stream failure", error);
        yield {
          type: "error",
          message: error instanceof Error ? error.message : String(error),
          retryable: true
        };
      }
    }

    await completion.catch(() => undefined);
    void response.body.cancel().catch(() => undefined);

    yield { type: "done" };
  }
}

function applyUsage(target: Usage, raw: NonNullable<OpenAiStreamChunk["usage"]>): void {
  target.inputTokens += raw.prompt_tokens ?? 0;
  target.outputTokens += raw.completion_tokens ?? 0;
  target.cacheReadTokens += raw.prompt_tokens_details?.cached_tokens ?? 0;
  target.reasoningTokens += raw.completion_tokens_details?.reasoning_tokens ?? 0;
}

function usageFromChunk(raw: NonNullable<OpenAiStreamChunk["usage"]>): Partial<Usage> {
  return {
    inputTokens: raw.prompt_tokens ?? 0,
    outputTokens: raw.completion_tokens ?? 0,
    cacheReadTokens: raw.prompt_tokens_details?.cached_tokens ?? 0,
    reasoningTokens: raw.completion_tokens_details?.reasoning_tokens ?? 0
  };
}

function mapFinishReason(reason: string): "end_turn" | "max_tokens" | "aborted" | "error" | "other" | "tool_use" {
  switch (reason) {
    case "stop":
      return "end_turn";
    case "length":
      return "max_tokens";
    case "tool_calls":
    case "function_call":
      return "tool_use";
    case "content_filter":
      return "other";
    default:
      return "other";
  }
}

async function describeHttpError(response: Response): Promise<StreamEvent> {
  const text = await response.text().catch(() => "");
  const parsed = safeJsonParse<{ error?: { message?: string; code?: string } }>(text);
  const message = parsed?.error?.message ?? truncate(text, 400);

  if (response.status === 401 || response.status === 403) {
    return { type: "error", message: `Authentication failed (${response.status}): ${message}`, retryable: false, status: response.status };
  }
  if (response.status === 404 && /model/i.test(message)) {
    return { type: "error", message: `Model not found: ${message}`, retryable: false, status: 404 };
  }
  if (response.status === 429) {
    return { type: "error", message: `Rate limited: ${message}`, retryable: true, status: 429 };
  }
  if (response.status >= 500) {
    return { type: "error", message: `Provider unavailable: ${message}`, retryable: true, status: response.status };
  }
  return { type: "error", message: `HTTP ${response.status}: ${message}`, retryable: false, status: response.status };
}

function translateConnectionError(error: unknown): StreamEvent {
  if (error instanceof Error && error.name === "AbortError") {
    return { type: "stop", reason: "aborted" };
  }
  return {
    type: "error",
    message: error instanceof Error ? error.message : String(error),
    retryable: true
  };
}

function truncate(value: string, limit: number): string {
  const clean = value.replace(/\s+/g, " ").trim();
  return clean.length <= limit ? clean : `${clean.slice(0, limit)}…`;
}

export function isOpenAiMessageTypeAllowed(message: OpenAiChatMessage): boolean {
  return message.role !== "system" || typeof message.content === "string";
}
