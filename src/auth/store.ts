import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { AxiomError } from "../util/errors.js";
import { createLogger } from "../util/log.js";

const log = createLogger("auth");

export interface ProviderCredentials {
  apiKey?: string;
  refreshToken?: string;
  accessToken?: string;
  expiresAt?: number;
  extra?: Record<string, string>;
}

export interface AuthFileShape {
  version: 1;
  providers: Record<string, ProviderCredentials>;
}

export interface AuthResolution {
  source: "authfile" | "env" | "none";
  apiKey?: string;
}

const ENV_KEYS_BY_PROVIDER: Record<string, string[]> = {
  anthropic: ["ANTHROPIC_API_KEY", "AXIOM_ANTHROPIC_API_KEY"],
  openai: ["OPENAI_API_KEY", "AXIOM_OPENAI_API_KEY"],
  gemini: ["GEMINI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "AXIOM_GEMINI_API_KEY"],
  openrouter: ["OPENROUTER_API_KEY", "AXIOM_OPENROUTER_API_KEY"],
  groq: ["GROQ_API_KEY"],
  deepseek: ["DEEPSEEK_API_KEY"],
  ollama: [],
  lmstudio: []
};

export class AuthStore {
  private readonly filePath: string;
  private cache: AuthFileShape | null = null;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  async load(): Promise<AuthFileShape> {
    if (this.cache) return this.cache;
    try {
      const text = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(text) as Partial<AuthFileShape>;
      this.cache = {
        version: 1,
        providers: parsed.providers ?? {}
      };
    } catch {
      this.cache = { version: 1, providers: {} };
    }
    return this.cache;
  }

  async save(data: AuthFileShape): Promise<void> {
    this.cache = data;
    await mkdir(dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.tmp`;
    await writeFile(tempPath, JSON.stringify(data, null, 2), "utf8");
    try {
      await chmod(tempPath, 0o600);
    } catch {
    }
    await rename(tempPath, this.filePath);
  }

  async setProvider(provider: string, credentials: ProviderCredentials): Promise<void> {
    const data = await this.load();
    data.providers[provider] = credentials;
    await this.save(data);
    log.info(`credentials stored for provider ${provider}`);
  }

  async removeProvider(provider: string): Promise<boolean> {
    const data = await this.load();
    if (!(provider in data.providers)) return false;
    delete data.providers[provider];
    await this.save(data);
    return true;
  }

  async listProviders(): Promise<string[]> {
    const data = await this.load();
    return Object.keys(data.providers);
  }

  listProvidersSync(): string[] {
    if (!this.cache) {
      try {
        const text = readFileSync(this.filePath, "utf8");
        const parsed = JSON.parse(text) as Partial<AuthFileShape>;
        this.cache = { version: 1, providers: parsed.providers ?? {} };
      } catch {
        this.cache = { version: 1, providers: {} };
      }
    }
    return Object.keys(this.cache.providers);
  }

  async getProvider(provider: string): Promise<ProviderCredentials | undefined> {
    const data = await this.load();
    return data.providers[provider];
  }

  resolveApiKey(provider: string, keyEnvOverride?: string, env: NodeJS.ProcessEnv = process.env): AuthResolution {
    const syncData = this.cache ?? { version: 1, providers: {} };
    const stored = syncData.providers[provider];
    if (stored?.apiKey && stored.apiKey.length > 0) {
      return { source: "authfile", apiKey: stored.apiKey };
    }

    const candidates: string[] = [];
    if (keyEnvOverride) candidates.push(keyEnvOverride);
    candidates.push(...(ENV_KEYS_BY_PROVIDER[provider] ?? []));
    candidates.push(`AXIOM_${provider.toUpperCase()}_API_KEY`);

    for (const envKey of candidates) {
      const value = env[envKey];
      if (value && value.trim().length > 0) {
        return { source: "env", apiKey: value.trim() };
      }
    }

    return { source: "none" };
  }

  async resolveApiKeyAsync(provider: string, keyEnvOverride?: string, env: NodeJS.ProcessEnv = process.env): Promise<AuthResolution> {
    await this.load();
    return this.resolveApiKey(provider, keyEnvOverride, env);
  }

  expandEnvReferences(value: string, env: NodeJS.ProcessEnv = process.env): string {
    return value.replace(/\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name: string) => {
      return env[name] ?? "";
    });
  }

  hasAnyCredentialForProvider(provider: string, env: NodeJS.ProcessEnv = process.env): boolean {
    return this.resolveApiKey(provider, undefined, env).source !== "none";
  }
}

export function maskSecret(secret: string, visibleTail = 4): string {
  if (secret.length <= visibleTail) return "*".repeat(secret.length);
  const tail = secret.slice(-visibleTail);
  return `${"*".repeat(Math.min(secret.length - visibleTail, 18))}${tail}`;
}
