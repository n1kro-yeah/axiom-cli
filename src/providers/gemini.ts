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
import type { ChatMessage, Part } from "../types.js";

const log = createLogger("gemini");

const DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";

export interface GeminiAdapterOptions {
  apiKey: string;
  baseUrl?: string;
  extraHeaders?: Record<string, string>;
  timeoutMs?: number;
}

interface GeminiPart {
  text?: string;
  thought?: boolean;
  inlineData?: { mimeType: string; data: string };
  functionCall?: { name: string; args?: Record<string, unknown> };
  functionResponse?: { name: string; response: Record<string, unknown> };
}

interface GeminiContent {
  role?: "user" | "model";
  parts: GeminiPart[];
}

interface GeminiChunk {
  candidates?: Array<{
    content?: { parts?: GeminiPart[]; role?: string };
    finishReason?: string;
    index?: number;
  }>;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
    thoughtsTokenCount?: number;
    cachedContentTokenCount?: number;
  };
  error?: { code?: number; message?: string; status?: string };
}

export class GeminiAdapter implements ProviderAdapter {
  readonly id = "gemini";
  readonly label = "Google Gemini";

  private readonly options: GeminiAdapterOptions;

  constructor(options: GeminiAdapterOptions) {
    this.options = options;
  }

  listModels(): ModelInfo[] {
    return buildCatalogForProvider(this.id, "gemini");
  }

  hasModel(): boolean {
    return true;
  }

  resolveModel(modelId: string): ModelInfo {
    return findCatalogModel(this.id, "gemini", modelId) ?? fallbackModelInfo(this.id, modelId);
  }

  estimateCost(model: ModelInfo, usage: Usage): number {
    const pricing = model.pricing;
    if (!pricing) return 0;
    const input = (usage.inputTokens / 1_000_000) * pricing.inputPerMillion;
    const output = (usage.outputTokens / 1_000_000) * pricing.outputPerMillion;
    return Number((input + output).toFixed(6));
  }

  async *stream(request: StreamRequest, signal: AbortSignal): AsyncIterable<StreamEvent> {
    const modelInfo = this.resolveModel(request.model);
    const url = `${(this.options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "")}/models/${encodeURIComponent(
      modelInfo.id
    )}:streamGenerateContent?alt=sse`;

    const contents = toGeminiContents(request.messages);

    const payload: Record<string, unknown> = {
      contents,
      generationConfig: {
        maxOutputTokens: Math.min(request.maxTokens, modelInfo.maxOutputTokens),
        ...(request.temperature !== undefined ? { temperature: request.temperature } : {})
      }
    };

    const systemText = request.system.map((block) => block.text).join("\n\n");
    if (systemText.trim().length > 0) {
      payload["systemInstruction"] = { parts: [{ text: systemText }] };
    }

    if (request.tools.length > 0 && modelInfo.supportsTools) {
      payload["tools"] = [
        {
          functionDeclarations: request.tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            parameters: sanitizeSchemaForGemini(tool.parameters)
          }))
        }
      ];
    }

    if (request.thinkingBudgetTokens && modelInfo.supportsThinking && modelInfo.id.startsWith("gemini-2.5")) {
      payload["generationConfig"] = {
        ...(payload["generationConfig"] as Record<string, unknown>),
        thinkingConfig: { thinkingBudget: Math.min(request.thinkingBudgetTokens, 24576) }
      };
    }

    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "text/event-stream",
      "x-goog-api-key": this.options.apiKey,
      ...(this.options.extraHeaders ?? {})
    };

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

    const usage = emptyUsage();
    let sawFunctionCalls = false;

    const queue = new AsyncQueue<GeminiChunk>();
    const completion = consumeSseStream(response.body, (event) => {
      const parsed = safeJsonParse<GeminiChunk>(event.data);
      if (parsed) queue.push(parsed);
    }, signal)
      .then(() => queue.end())
      .catch((error) => queue.end(signal.aborted ? undefined : error));

    try {
      for await (const chunk of queue) {
        if (chunk.error) {
          yield {
            type: "error",
            message: chunk.error.message ?? "Gemini stream error",
            retryable: chunk.error.code !== undefined && chunk.error.code >= 500,
            status: chunk.error.code
          };
          break;
        }

        const candidate = chunk.candidates?.[0];
        const parts = candidate?.content?.parts ?? [];

        for (const part of parts) {
          if (part.functionCall) {
            sawFunctionCalls = true;
            const name = part.functionCall.name ?? "";
            const args = JSON.stringify(part.functionCall.args ?? {});
            yield { type: "tool_call_start", index: 0, id: `gc_${name}_${Date.now().toString(36)}`, name };
            yield { type: "tool_call_delta", index: 0, argsDelta: args };
            yield { type: "tool_call_end", index: 0, id: `gc_${name}_${Date.now().toString(36)}`, name, args };
            continue;
          }
          if (typeof part.text === "string" && part.text.length > 0) {
            if (part.thought === true) {
              yield { type: "thinking_delta", delta: part.text };
            } else {
              yield { type: "text_delta", delta: part.text };
            }
          }
        }

        if (chunk.usageMetadata) {
          const meta = chunk.usageMetadata;
          usage.inputTokens += meta.promptTokenCount ?? 0;
          usage.outputTokens += meta.candidatesTokenCount ?? 0;
          usage.reasoningTokens += meta.thoughtsTokenCount ?? 0;
          usage.cacheReadTokens += meta.cachedContentTokenCount ?? 0;
          yield {
            type: "usage_delta",
            usage: {
              inputTokens: meta.promptTokenCount ?? 0,
              outputTokens: meta.candidatesTokenCount ?? 0,
              reasoningTokens: meta.thoughtsTokenCount ?? 0,
              cacheReadTokens: meta.cachedContentTokenCount ?? 0
            }
          };
        }

        if (candidate?.finishReason) {
          yield { type: "stop", reason: mapFinishReason(candidate.finishReason, sawFunctionCalls) };
        }
      }

      if (!signal.aborted && usage.inputTokens > 0) {
        yield { type: "stop", reason: sawFunctionCalls ? "tool_use" : "end_turn" };
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

function toGeminiContents(messages: ChatMessage[]): GeminiContent[] {
  const contents: GeminiContent[] = [];

  for (const message of messages) {
    if (message.role === "assistant") {
      const parts: GeminiPart[] = [];
      for (const part of message.parts) {
        if (part.type === "text" && part.text.trim().length > 0) {
          parts.push({ text: part.text });
        } else if (part.type === "thinking" && part.thinking.trim().length > 0) {
          parts.push({ text: part.thinking, thought: true });
        } else if (part.type === "tool_call") {
          parts.push({
            functionCall: {
              name: part.name,
              args: normalizeArgs(part.input)
            }
          });
        }
      }
      if (parts.length > 0) contents.push({ role: "model", parts });
      continue;
    }

    const parts: GeminiPart[] = [];
    for (const part of message.parts as Part[]) {
      if (part.type === "text") {
        parts.push({ text: part.text });
      } else if (part.type === "image") {
        parts.push({ inlineData: { mimeType: part.mediaType, data: part.data } });
      } else if (part.type === "tool_result") {
        parts.push({
          functionResponse: {
            name: part.name || "tool",
            response: part.isError
              ? { error: part.content }
              : { output: part.content }
          }
        });
      }
    }
    if (parts.length > 0) contents.push({ role: "user", parts });
  }

  return mergeConsecutiveSameRoles(contents);
}

function normalizeArgs(input: unknown): Record<string, unknown> {
  if (input === null || input === undefined) return {};
  if (typeof input === "object" && !Array.isArray(input)) return input as Record<string, unknown>;
  return { value: input };
}

function mergeConsecutiveSameRoles(contents: GeminiContent[]): GeminiContent[] {
  const merged: GeminiContent[] = [];
  for (const content of contents) {
    const tail = merged[merged.length - 1];
    if (tail && tail.role === content.role) {
      tail.parts.push(...content.parts);
      continue;
    }
    merged.push(content);
  }
  return merged;
}

function sanitizeSchemaForGemini(schema: unknown): Record<string, unknown> {
  if (typeof schema !== "object" || schema === null) return { type: "OBJECT", properties: {} };
  const source = schema as Record<string, unknown>;
  const out: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(source)) {
    switch (key) {
      case "type": {
        const upper = typeof value === "string" ? value.toUpperCase() : "STRING";
        out["type"] = upper;
        break;
      }
      case "properties": {
        if (typeof value === "object" && value !== null) {
          const converted: Record<string, unknown> = {};
          for (const [propName, propValue] of Object.entries(value as Record<string, unknown>)) {
            converted[propName] = sanitizeSchemaForGemini(propValue);
          }
          out["properties"] = converted;
        }
        break;
      }
      case "items":
        out["items"] = sanitizeSchemaForGemini(value);
        break;
      case "required":
      case "description":
      case "enum":
      case "format":
        out[key] = value;
        break;
      default:
        break;
    }
  }

  if (out["type"] === "ARRAY" && !out["items"]) {
    out["items"] = { type: "STRING" };
  }
  return out;
}

function mapFinishReason(reason: string, hasToolCalls: boolean): "end_turn" | "max_tokens" | "aborted" | "error" | "other" | "tool_use" {
  switch (reason) {
    case "STOP":
      return hasToolCalls ? "tool_use" : "end_turn";
    case "MAX_TOKENS":
      return "max_tokens";
    case "SAFETY":
    case "RECITATION":
      return "other";
    default:
      return "other";
  }
}

async function describeHttpError(response: Response): Promise<StreamEvent> {
  const text = await response.text().catch(() => "");
  const parsed = safeJsonParse<{ error?: { message?: string; status?: string } }>(text);
  const message = parsed?.error?.message ?? truncate(text, 400);

  if (response.status === 400 && /API key/i.test(message)) {
    return { type: "error", message: `Authentication failed: ${message}`, retryable: false, status: 401 };
  }
  if (response.status === 403) {
    return { type: "error", message: `Access denied: ${message}`, retryable: false, status: 403 };
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
