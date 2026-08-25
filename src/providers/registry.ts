import type { ModelInfo, ProviderAdapter, ProviderToolSpec } from "../types.js";
import { AnthropicAdapter } from "./anthropic.js";
import { OpenAiCompatibleAdapter } from "./openai.js";
import { GeminiAdapter } from "./gemini.js";
import { buildCatalogForProvider, fallbackModelInfo } from "./models.js";
import { AuthStore } from "../auth/store.js";
import type { ConfigStore } from "../config/loader.js";
import type { AxiomPaths } from "../config/paths.js";
import { AxiomError } from "../util/errors.js";
import { createLogger } from "../util/log.js";

const log = createLogger("registry");

export const BUILTIN_PROVIDERS: Array<{ id: string; label: string; type: "anthropic" | "openai" | "gemini"; baseUrl: string; needsKey: boolean }> = [
  {
    id: "anthropic",
    label: "Anthropic",
    type: "anthropic",
    baseUrl: "https://api.anthropic.com",
    needsKey: true
  },
  {
    id: "openai",
    label: "OpenAI",
    type: "openai",
    baseUrl: "https://api.openai.com/v1",
    needsKey: true
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    type: "openai",
    baseUrl: "https://openrouter.ai/api/v1",
    needsKey: true
  },
  {
    id: "gemini",
    label: "Google Gemini",
    type: "gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    needsKey: true
  },
  {
    id: "groq",
    label: "Groq",
    type: "openai",
    baseUrl: "https://api.groq.com/openai/v1",
    needsKey: true
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    type: "openai",
    baseUrl: "https://api.deepseek.com/v1",
    needsKey: true
  },
  {
    id: "ollama",
    label: "Ollama (local)",
    type: "openai",
    baseUrl: "http://localhost:11434/v1",
    needsKey: false
  },
  {
    id: "lmstudio",
    label: "LM Studio (local)",
    type: "openai",
    baseUrl: "http://localhost:1234/v1",
    needsKey: false
  }
];

export interface ResolvedModelRef {
  providerId: string;
  modelId: string;
}

export function parseModelReference(reference: string, fallbackProvider = "anthropic"): ResolvedModelRef {
  const slashIndex = reference.indexOf("/");
  if (slashIndex === -1) {
    return { providerId: inferProviderFromModel(reference) ?? fallbackProvider, modelId: reference };
  }
  const head = reference.slice(0, slashIndex);
  if (BUILTIN_PROVIDERS.some((provider) => provider.id === head)) {
    return { providerId: head, modelId: reference.slice(slashIndex + 1) };
  }
  return { providerId: inferProviderFromModel(reference) ?? fallbackProvider, modelId: reference };
}

function inferProviderFromModel(modelId: string): string | undefined {
  if (modelId.startsWith("claude")) return "anthropic";
  if (modelId.startsWith("gemini")) return "gemini";
  if (modelId.startsWith("gpt") || modelId.startsWith("o1") || modelId.startsWith("o3") || modelId.startsWith("o4")) return "openai";
  if (modelId.startsWith("deepseek")) return "deepseek";
  if (modelId.includes("/")) {
    const head = modelId.split("/")[0];
    if (head === "anthropic") return "openrouter";
    if (head === "google") return "openrouter";
    if (head === "moonshotai") return "openrouter";
  }
  return undefined;
}

export class ProviderRegistry {
  private adapters = new Map<string, ProviderAdapter>();
  private readonly auth: AuthStore;
  private readonly configStore: ConfigStore;
  private readonly paths: AxiomPaths;

  constructor(paths: AxiomPaths, auth: AuthStore, configStore: ConfigStore) {
    this.paths = paths;
    this.auth = auth;
    this.configStore = configStore;
  }

  get env(): NodeJS.ProcessEnv {
    return process.env;
  }

  configuredProviderIds(): string[] {
    const global = this.configStore.loadGlobalSync();
    const ids = new Set<string>(BUILTIN_PROVIDERS.map((provider) => provider.id));
    for (const id of Object.keys(global.providers)) ids.add(id);
    for (const id of this.auth.listProvidersSync()) ids.add(id);
    return [...ids];
  }

  providerLabel(providerId: string): string {
    const builtin = BUILTIN_PROVIDERS.find((provider) => provider.id === providerId);
    if (builtin) return builtin.label;
    const custom = this.configStore.loadGlobalSync().providers[providerId];
    return custom ? `${providerId} (${custom.type})` : providerId;
  }

  isConfigured(providerId: string): boolean {
    const global = this.configStore.loadGlobalSync();
    const entry = global.providers[providerId];
    const keyEnv = entry?.keyEnv;
    const resolution = this.auth.resolveApiKey(providerId, keyEnv, this.env);
    if (resolution.source !== "none") return true;
    const builtin = BUILTIN_PROVIDERS.find((provider) => provider.id === providerId);
    return builtin !== undefined && !builtin.needsKey;
  }

  createAdapter(providerId: string): ProviderAdapter {
    const cached = this.adapters.get(providerId);
    if (cached) return cached;

    const global = this.configStore.loadGlobalSync();
    const customEntry = global.providers[providerId];
    const builtin = BUILTIN_PROVIDERS.find((provider) => provider.id === providerId);
    const providerType = customEntry?.type ?? builtin?.type ?? "openai";
    const baseUrl = customEntry?.baseUrl ?? builtin?.baseUrl;
    const keyEnv = customEntry?.keyEnv;

    const resolution = this.auth.resolveApiKey(providerId, keyEnv, this.env);

    let adapter: ProviderAdapter;
    if (providerType === "anthropic") {
      adapter = new AnthropicAdapter({
        apiKey: resolution.apiKey ?? "",
        baseUrl,
        extraHeaders: customEntry?.headers,
        timeoutMs: customEntry?.requestTimeoutMs
      });
    } else if (providerType === "gemini") {
      adapter = new GeminiAdapter({
        apiKey: resolution.apiKey ?? "",
        baseUrl,
        extraHeaders: customEntry?.headers,
        timeoutMs: customEntry?.requestTimeoutMs
      });
    } else {
      adapter = new OpenAiCompatibleAdapter({
        providerId,
        label: this.providerLabel(providerId),
        providerType: "openai",
        apiKey: resolution.apiKey,
        baseUrl: baseUrl ?? "https://api.openai.com/v1",
        extraHeaders: customEntry?.headers,
        timeoutMs: customEntry?.requestTimeoutMs
      });
    }

    this.adapters.set(providerId, adapter);
    log.debug(`adapter created for ${providerId} (${providerType})`);
    return adapter;
  }

  resolveModelInfo(reference: string): { adapter: ProviderAdapter; model: ModelInfo; ref: ResolvedModelRef } {
    const parsed = parseModelReference(reference);
    const adapter = this.createAdapter(parsed.providerId);
    const model = adapter.resolveModel(parsed.modelId) ?? fallbackModelInfo(parsed.providerId, parsed.modelId);
    return { adapter, model, ref: parsed };
  }

  allModelsGrouped(): Array<{ providerId: string; models: ModelInfo[] }> {
    const groups: Array<{ providerId: string; models: ModelInfo[] }> = [];
    for (const providerId of this.configuredProviderIds()) {
      try {
        const adapter = this.createAdapter(providerId);
        groups.push({ providerId, models: adapter.listModels() });
      } catch (error) {
        log.warn(`could not list models for ${providerId}`, error);
      }
    }
    return groups;
  }

  requireCredential(providerId: string): void {
    if (!this.isConfigured(providerId)) {
      throw AxiomError.auth(providerId, `no API key configured. Run /login or set the environment variable.`);
    }
  }

  defaultCatalogForNewUsers(): ModelInfo[] {
    return [
      ...buildCatalogForProvider("anthropic", "anthropic"),
      ...buildCatalogForProvider("openai", "openai"),
      ...buildCatalogForProvider("gemini", "gemini")
    ];
  }
}

export function dedupeToolSpecs(specs: ProviderToolSpec[]): ProviderToolSpec[] {
  const seen = new Set<string>();
  const out: ProviderToolSpec[] = [];
  for (const spec of specs) {
    if (seen.has(spec.name)) continue;
    seen.add(spec.name);
    out.push(spec);
  }
  return out;
}
