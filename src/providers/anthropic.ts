import type {
  ModelInfo,
  ProviderAdapter,
  ProviderToolSpec,
  StreamEvent,
  StreamRequest,
  Usage
} from "../types.js";
import { emptyUsage } from "../types.js";
import { buildCatalogForProvider, findCatalogModel, fallbackModelInfo } from "./models.js";
import { AxiomError } from "../util/errors.js";
import { createLogger } from "../util/log.js";
import { consumeSseStream, fetchWithTimeout, safeJsonParse, AsyncQueue } from "../util/sse.js";
import {
  buildAnthropicSystem,
  toAnthropicMessages
} from "./wire.js";
import type { AnthropicContentBlock, AnthropicMessage } from "./wire.js";

const log = createLogger("anthropic");

const DEFAULT_BASE_URL = "https://api.anthropic.com";
const API_VERSION = "2023-06-01";

export interface AnthropicAdapterOptions {
  apiKey: string;
  baseUrl?: string;
  extraHeaders?: Record<string, string>;
  timeoutMs?: number;
}

interface AnthropicStreamChunk {
  type?: string;
  index?: number;
  message?: {
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    };
  };
  content_block?: AnthropicContentBlock;
  delta?: {
    type?: string;
    text?: string;
    thinking?: string;
    signature?: string;
    partial_json?: string;
    stop_reason?: string;
  };
  usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
  error?: { type?: string; message?: string };
}

export class AnthropicAdapter implements ProviderAdapter {
  readonly id = "anthropic";
  readonly label = "Anthropic";

  private readonly options: AnthropicAdapterOptions;

  constructor(options: AnthropicAdapterOptions) {
    this.options = options;
  }

  listModels(): ModelInfo[] {
    return buildCatalogForProvider(this.id, "anthropic");
  }

  hasModel(modelId: string): boolean {
    return this.resolveModel(modelId) !== undefined || true;
  }

  resolveModel(modelId: string): ModelInfo {
    const known =
      findCatalogModel(this.id, "anthropic", modelId) ??
      fallbackModelInfo(this.id, modelId);
    if (modelId.startsWith("claude")) {
      return {
        ...known,
        supportsTools: true,
        supportsImages: true,
        supportsThinking: !modelId.includes("3-5-haiku"),
        supportsCacheControl: true
      };
    }
    return known;
  }

  estimateCost(model: ModelInfo, usage: Usage): number {
    const pricing = model.pricing;
    if (!pricing) return 0;
    const input = (usage.inputTokens / 1_000_000) * pricing.inputPerMillion;
    const output = (usage.outputTokens / 1_000_000) * pricing.outputPerMillion;
    const cacheRead =
      ((pricing.cacheReadPerMillion ?? pricing.inputPerMillion * 0.1) / 1) *
      (usage.cacheReadTokens / 1_000_000);
    const cacheWrite =
      ((pricing.cacheWritePerMillion ?? pricing.inputPerMillion * 1.25) / 1) *
      (usage.cacheWriteTokens / 1_000_000);
    return Number((input + output + cacheRead + cacheWrite).toFixed(6));
  }

  async *stream(request: StreamRequest, signal: AbortSignal): AsyncIterable<StreamEvent> {
    const modelInfo = this.resolveModel(request.model);
    const url = `${(this.options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "")}/v1/messages`;

    const body: Record<string, unknown> = {
      model: modelInfo.id,
      max_tokens: Math.min(request.maxTokens, modelInfo.maxOutputTokens),
      stream: true,
      messages: toAnthropicMessages(request.messages)
    };

    const systemBlocks = buildAnthropicSystem(
      request.system,
      modelInfo.supportsCacheControl && request.system.some((block) => block.cache)
    );
    if (systemBlocks.length > 0) body["system"] = systemBlocks;

    if (request.tools.length > 0 && modelInfo.supportsTools) {
      body["tools"] = request.tools.map((tool: ProviderToolSpec) => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.parameters
      }));
    }

    if (request.thinkingBudgetTokens && request.thinkingBudgetTokens > 0 && modelInfo.supportsThinking) {
      body["thinking"] = {
        type: "enabled",
        budget_tokens: Math.min(
          request.thinkingBudgetTokens,
          Math.max((body["max_tokens"] as number) - 1024, 1024)
        )
      };
    } else if (request.temperature !== undefined) {
      body["temperature"] = request.temperature;
    }

    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "text/event-stream",
      "x-api-key": this.options.apiKey,
      "anthropic-version": API_VERSION,
      ...(this.options.extraHeaders ?? {})
    };

    yield { type: "start", provider: this.id, model: modelInfo.id };

    let response: Response;
    try {
      response = await fetchWithTimeout(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
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
        ? { type: "error", message: "Empty response body", retryable: false }
        : await describeHttpError(response);
      yield { type: "done" };
      return;
    }

    const openToolCalls = new Map<number, { id: string; name: string; args: string }>();
    const usage = emptyUsage();

    const queue = new AsyncQueue<AnthropicStreamChunk>();
    const completion = consumeSseStream(response.body, (event) => {
      const parsed = safeJsonParse<AnthropicStreamChunk>(event.data);
      if (parsed) queue.push(parsed);
    }, signal)
      .then(() => queue.end())
      .catch((error) => queue.end(signal.aborted ? undefined : error));

    try {
      for await (const chunk of queue) {
        for (const mapped of mapEnvelope(chunk, openToolCalls, usage)) {
          yield mapped;
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

function* mapEnvelope(
  chunk: AnthropicStreamChunk,
  openToolCalls: Map<number, { id: string; name: string; args: string }>,
  usage: Usage
): Generator<StreamEvent> {
  switch (chunk.type) {
    case "message_start": {
      const initial = chunk.message?.usage;
      if (initial) {
        usage.inputTokens += initial.input_tokens ?? 0;
        usage.cacheReadTokens += initial.cache_read_input_tokens ?? 0;
        usage.cacheWriteTokens += initial.cache_creation_input_tokens ?? 0;
        yield {
          type: "usage_delta",
          usage: {
            inputTokens: initial.input_tokens ?? 0,
            cacheReadTokens: initial.cache_read_input_tokens ?? 0,
            cacheWriteTokens: initial.cache_creation_input_tokens ?? 0
          }
        };
      }
      break;
    }

    case "content_block_start": {
      const block = chunk.content_block;
      if (block?.type === "tool_use") {
        const index = chunk.index ?? 0;
        openToolCalls.set(index, { id: block.id ?? "", name: block.name ?? "", args: "" });
        yield { type: "tool_call_start", index, id: block.id ?? "", name: block.name ?? "" };
      }
      break;
    }

    case "content_block_delta": {
      const delta = chunk.delta;
      if (!delta) break;
      if (delta.type === "text_delta" && typeof delta.text === "string") {
        yield { type: "text_delta", delta: delta.text };
      } else if (delta.type === "thinking_delta" && typeof delta.thinking === "string") {
        yield { type: "thinking_delta", delta: delta.thinking };
      } else if (delta.type === "signature_delta" && typeof delta.signature === "string") {
        yield { type: "thinking_delta", delta: "", signature: delta.signature };
      } else if (delta.type === "input_json_delta" && typeof delta.partial_json === "string") {
        const index = chunk.index ?? 0;
        const open = openToolCalls.get(index);
        if (open) open.args += delta.partial_json;
        yield { type: "tool_call_delta", index, argsDelta: delta.partial_json };
      }
      break;
    }

    case "content_block_stop": {
      const index = chunk.index ?? 0;
      const open = openToolCalls.get(index);
      if (open) {
        openToolCalls.delete(index);
        yield { type: "tool_call_end", index, id: open.id, name: open.name, args: open.args };
      }
      break;
    }

    case "message_delta": {
      if (chunk.usage) {
        usage.outputTokens += chunk.usage.output_tokens ?? 0;
        yield { type: "usage_delta", usage: { outputTokens: chunk.usage.output_tokens ?? 0 } };
      }
      if (chunk.delta?.stop_reason) {
        yield { type: "stop", reason: mapStopReason(chunk.delta.stop_reason) };
      }
      break;
    }

    case "error": {
      const message = chunk.error?.message ?? "Unknown provider error";
      const type = chunk.error?.type ?? "";
      yield {
        type: "error",
        message,
        retryable: type === "overloaded_error" || type === "rate_limit_error",
        status: type === "overloaded_error" ? 529 : undefined
      };
      break;
    }

    default:
      break;
  }
}

function mapStopReason(reason: string): "end_turn" | "max_tokens" | "aborted" | "error" | "other" | "tool_use" {
  switch (reason) {
    case "end_turn":
      return "end_turn";
    case "tool_use":
      return "tool_use";
    case "max_tokens":
      return "max_tokens";
    case "stop_sequence":
      return "end_turn";
    default:
      return "other";
  }
}

async function describeHttpError(response: Response): Promise<StreamEvent> {
  const text = await response.text().catch(() => "");
  const parsed = safeJsonParse<{ error?: { type?: string; message?: string } }>(text);
  const message = parsed?.error?.message ?? truncate(text, 400);

  if (response.status === 401 || response.status === 403) {
    return { type: "error", message: `Authentication failed (${response.status}): ${message}`, retryable: false, status: response.status };
  }
  if (response.status === 429) {
    return { type: "error", message: `Rate limited: ${message}`, retryable: true, status: 429 };
  }
  if (response.status === 529 || response.status >= 500) {
    return { type: "error", message: `Provider unavailable: ${message}`, retryable: true, status: response.status };
  }
  if (response.status === 400 && message.toLowerCase().includes("prompt is too long")) {
    return { type: "error", message: `Context window exceeded: ${message}`, retryable: false, status: 400 };
  }
  return { type: "error", message: `HTTP ${response.status}: ${message}`, retryable: false, status: response.status };
}

function translateConnectionError(error: unknown): StreamEvent {
  if (error instanceof AxiomError && error.code === "aborted") {
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

export function anthropicToolSpecToWire(tool: ProviderToolSpec): unknown {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: tool.parameters
  };
}
