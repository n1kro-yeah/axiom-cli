import type { ModelInfo } from "../types.js";

interface CatalogEntry {
  id: string;
  label: string;
  contextWindow: number;
  maxOutputTokens: number;
  supportsTools?: boolean;
  supportsImages?: boolean;
  supportsThinking?: boolean;
  supportsCacheControl?: boolean;
  inputPerMillion?: number;
  outputPerMillion?: number;
  cacheReadPerMillion?: number;
  cacheWritePerMillion?: number;
  recommended?: boolean;
}

const ANTHROPIC_MODELS: CatalogEntry[] = [
  {
    id: "claude-opus-4-1",
    label: "Claude Opus 4.1",
    contextWindow: 200000,
    maxOutputTokens: 32000,
    supportsTools: true,
    supportsImages: true,
    supportsThinking: true,
    supportsCacheControl: true,
    inputPerMillion: 15,
    outputPerMillion: 75,
    cacheReadPerMillion: 1.5,
    cacheWritePerMillion: 18.75,
    recommended: false
  },
  {
    id: "claude-opus-4-5",
    label: "Claude Opus 4.5",
    contextWindow: 200000,
    maxOutputTokens: 64000,
    supportsTools: true,
    supportsImages: true,
    supportsThinking: true,
    supportsCacheControl: true,
    inputPerMillion: 5,
    outputPerMillion: 25,
    cacheReadPerMillion: 0.5,
    cacheWritePerMillion: 6.25,
    recommended: true
  },
  {
    id: "claude-sonnet-4-5",
    label: "Claude Sonnet 4.5",
    contextWindow: 200000,
    maxOutputTokens: 64000,
    supportsTools: true,
    supportsImages: true,
    supportsThinking: true,
    supportsCacheControl: true,
    inputPerMillion: 3,
    outputPerMillion: 15,
    cacheReadPerMillion: 0.3,
    cacheWritePerMillion: 3.75,
    recommended: true
  },
  {
    id: "claude-haiku-4-5",
    label: "Claude Haiku 4.5",
    contextWindow: 200000,
    maxOutputTokens: 32000,
    supportsTools: true,
    supportsImages: true,
    supportsThinking: true,
    supportsCacheControl: true,
    inputPerMillion: 1,
    outputPerMillion: 5,
    cacheReadPerMillion: 0.1,
    cacheWritePerMillion: 1.25,
    recommended: false
  },
  {
    id: "claude-3-5-haiku-latest",
    label: "Claude Haiku 3.5",
    contextWindow: 200000,
    maxOutputTokens: 8192,
    supportsTools: true,
    supportsImages: true,
    supportsThinking: false,
    supportsCacheControl: false,
    inputPerMillion: 0.8,
    outputPerMillion: 4,
    cacheReadPerMillion: 0.08,
    cacheWritePerMillion: 1,
    recommended: false
  }
];

const OPENAI_MODELS: CatalogEntry[] = [
  {
    id: "gpt-5-codex",
    label: "GPT-5 Codex",
    contextWindow: 400000,
    maxOutputTokens: 128000,
    supportsTools: true,
    supportsImages: true,
    supportsThinking: true,
    inputPerMillion: 1.25,
    outputPerMillion: 10,
    recommended: true
  },
  {
    id: "gpt-5",
    label: "GPT-5",
    contextWindow: 400000,
    maxOutputTokens: 128000,
    supportsTools: true,
    supportsImages: true,
    supportsThinking: true,
    inputPerMillion: 1.25,
    outputPerMillion: 10,
    recommended: true
  },
  {
    id: "gpt-5-mini",
    label: "GPT-5 Mini",
    contextWindow: 400000,
    maxOutputTokens: 128000,
    supportsTools: true,
    supportsImages: true,
    supportsThinking: true,
    inputPerMillion: 0.25,
    outputPerMillion: 2,
    recommended: false
  },
  {
    id: "gpt-4.1",
    label: "GPT-4.1",
    contextWindow: 1047576,
    maxOutputTokens: 32768,
    supportsTools: true,
    supportsImages: true,
    supportsThinking: false,
    inputPerMillion: 2,
    outputPerMillion: 8,
    recommended: false
  },
  {
    id: "o4-mini",
    label: "o4 Mini",
    contextWindow: 200000,
    maxOutputTokens: 100000,
    supportsTools: true,
    supportsImages: true,
    supportsThinking: true,
    inputPerMillion: 1.1,
    outputPerMillion: 4.4,
    recommended: false
  }
];

const GEMINI_MODELS: CatalogEntry[] = [
  {
    id: "gemini-2.5-pro",
    label: "Gemini 2.5 Pro",
    contextWindow: 1048576,
    maxOutputTokens: 65536,
    supportsTools: true,
    supportsImages: true,
    supportsThinking: true,
    inputPerMillion: 1.25,
    outputPerMillion: 10,
    recommended: true
  },
  {
    id: "gemini-2.5-flash",
    label: "Gemini 2.5 Flash",
    contextWindow: 1048576,
    maxOutputTokens: 65536,
    supportsTools: true,
    supportsImages: true,
    supportsThinking: true,
    inputPerMillion: 0.3,
    outputPerMillion: 2.5,
    recommended: true
  },
  {
    id: "gemini-2.5-flash-lite",
    label: "Gemini 2.5 Flash Lite",
    contextWindow: 1048576,
    maxOutputTokens: 65536,
    supportsTools: true,
    supportsImages: true,
    supportsThinking: false,
    inputPerMillion: 0.1,
    outputPerMillion: 0.4,
    recommended: false
  },
  {
    id: "gemini-2.0-flash",
    label: "Gemini 2.0 Flash",
    contextWindow: 1048576,
    maxOutputTokens: 8192,
    supportsTools: true,
    supportsImages: true,
    supportsThinking: false,
    inputPerMillion: 0.1,
    outputPerMillion: 0.4,
    recommended: false
  }
];

const OPENROUTER_MODELS: CatalogEntry[] = [
  {
    id: "anthropic/claude-sonnet-4.5",
    label: "OR Claude Sonnet 4.5",
    contextWindow: 200000,
    maxOutputTokens: 64000,
    supportsTools: true,
    supportsImages: true,
    supportsThinking: true,
    inputPerMillion: 3,
    outputPerMillion: 15,
    recommended: true
  },
  {
    id: "openai/gpt-5",
    label: "OR GPT-5",
    contextWindow: 400000,
    maxOutputTokens: 128000,
    supportsTools: true,
    supportsImages: true,
    supportsThinking: true,
    inputPerMillion: 1.25,
    outputPerMillion: 10,
    recommended: false
  },
  {
    id: "google/gemini-2.5-pro",
    label: "OR Gemini 2.5 Pro",
    contextWindow: 1048576,
    maxOutputTokens: 65536,
    supportsTools: true,
    supportsImages: true,
    supportsThinking: true,
    inputPerMillion: 1.25,
    outputPerMillion: 10,
    recommended: false
  },
  {
    id: "deepseek/deepseek-chat-v3.1",
    label: "OR DeepSeek V3.1",
    contextWindow: 163840,
    maxOutputTokens: 65536,
    supportsTools: true,
    supportsImages: false,
    supportsThinking: true,
    inputPerMillion: 0.28,
    outputPerMillion: 0.88,
    recommended: false
  },
  {
    id: "moonshotai/kimi-k2",
    label: "OR Kimi K2",
    contextWindow: 262144,
    maxOutputTokens: 65536,
    supportsTools: true,
    supportsImages: false,
    supportsThinking: false,
    inputPerMillion: 0.6,
    outputPerMillion: 2.5,
    recommended: false
  }
];

const GROQ_MODELS: CatalogEntry[] = [
  {
    id: "llama-3.3-70b-versatile",
    label: "Groq Llama 3.3 70B",
    contextWindow: 131072,
    maxOutputTokens: 32768,
    supportsTools: true,
    supportsImages: false,
    supportsThinking: false,
    inputPerMillion: 0.59,
    outputPerMillion: 0.79,
    recommended: true
  },
  {
    id: "openai/gpt-oss-120b",
    label: "Groq GPT-OSS 120B",
    contextWindow: 131072,
    maxOutputTokens: 32768,
    supportsTools: true,
    supportsImages: false,
    supportsThinking: true,
    inputPerMillion: 0.15,
    outputPerMillion: 0.75,
    recommended: false
  }
];

const DEEPSEEK_MODELS: CatalogEntry[] = [
  {
    id: "deepseek-chat",
    label: "DeepSeek V3 Chat",
    contextWindow: 131072,
    maxOutputTokens: 32768,
    supportsTools: true,
    supportsImages: false,
    supportsThinking: false,
    inputPerMillion: 0.27,
    outputPerMillion: 1.1,
    recommended: true
  },
  {
    id: "deepseek-reasoner",
    label: "DeepSeek R1 Reasoner",
    contextWindow: 131072,
    maxOutputTokens: 65536,
    supportsTools: false,
    supportsImages: false,
    supportsThinking: true,
    inputPerMillion: 0.55,
    outputPerMillion: 2.19,
    recommended: false
  }
];

const OLLAMA_MODELS: CatalogEntry[] = [
  {
    id: "qwen3-coder",
    label: "Ollama Qwen3 Coder",
    contextWindow: 262144,
    maxOutputTokens: 32768,
    supportsTools: true,
    supportsImages: false,
    supportsThinking: true,
    recommended: true
  },
  {
    id: "llama3.3",
    label: "Ollama Llama 3.3",
    contextWindow: 131072,
    maxOutputTokens: 8192,
    supportsTools: true,
    supportsImages: false,
    supportsThinking: false,
    recommended: false
  },
  {
    id: "devstral",
    label: "Ollama Devstral",
    contextWindow: 131072,
    maxOutputTokens: 8192,
    supportsTools: true,
    supportsImages: false,
    supportsThinking: false,
    recommended: false
  }
];

const LMSTUDIO_MODELS: CatalogEntry[] = [
  {
    id: "openai/gpt-oss-20b",
    label: "LM Studio GPT-OSS 20B",
    contextWindow: 131072,
    maxOutputTokens: 32768,
    supportsTools: true,
    supportsImages: false,
    supportsThinking: true,
    recommended: true
  }
];

export function buildCatalogForProvider(providerId: string, providerType: string): ModelInfo[] {
  const entries = selectCatalog(providerId, providerType);
  return entries.map((entry) => ({
    id: entry.id,
    label: entry.label,
    provider: providerId,
    contextWindow: entry.contextWindow,
    maxOutputTokens: entry.maxOutputTokens,
    supportsTools: entry.supportsTools ?? true,
    supportsImages: entry.supportsImages ?? false,
    supportsThinking: entry.supportsThinking ?? false,
    supportsCacheControl: entry.supportsCacheControl ?? false,
    pricing:
      entry.inputPerMillion !== undefined && entry.outputPerMillion !== undefined
        ? {
            inputPerMillion: entry.inputPerMillion,
            outputPerMillion: entry.outputPerMillion,
            cacheReadPerMillion: entry.cacheReadPerMillion,
            cacheWritePerMillion: entry.cacheWritePerMillion
          }
        : undefined,
    recommended: entry.recommended
  }));
}

function selectCatalog(providerId: string, providerType: string): CatalogEntry[] {
  if (providerType === "anthropic") return ANTHROPIC_MODELS;
  if (providerType === "gemini") return GEMINI_MODELS;

  switch (providerId) {
    case "openrouter":
      return OPENROUTER_MODELS;
    case "groq":
      return GROQ_MODELS;
    case "deepseek":
      return DEEPSEEK_MODELS;
    case "ollama":
      return OLLAMA_MODELS;
    case "lmstudio":
      return LMSTUDIO_MODELS;
    default:
      return OPENAI_MODELS;
  }
}

export function findCatalogModel(providerId: string, providerType: string, modelId: string): ModelInfo | undefined {
  const catalog = buildCatalogForProvider(providerId, providerType);
  const exact = catalog.find((entry) => entry.id === modelId);
  if (exact) return exact;
  const suffixMatch = catalog.find((entry) => modelId.endsWith(entry.id) || entry.id.endsWith(modelId));
  if (suffixMatch) return suffixMatch;
  return undefined;
}

export function fallbackModelInfo(providerId: string, modelId: string): ModelInfo {
  return {
    id: modelId,
    label: modelId,
    provider: providerId,
    contextWindow: 128000,
    maxOutputTokens: 16384,
    supportsTools: true,
    supportsImages: false,
    supportsThinking: false,
    supportsCacheControl: false
  };
}
