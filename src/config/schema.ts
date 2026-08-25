import { z } from "zod";
import type { PermissionRule } from "../types.js";

export const permissionModeSchema = z.enum(["normal", "accept", "plan", "bypass"]);

export const providerTypeSchema = z.enum(["anthropic", "openai", "gemini"]);

export interface ProviderConfigSchemaShape {
  type: z.infer<typeof providerTypeSchema>;
  baseUrl?: string;
  keyEnv?: string;
  apiKey?: string;
  defaultModel?: string;
  headers?: Record<string, string>;
  requestTimeoutMs?: number;
}

export const providerConfigSchema = z.object({
  type: providerTypeSchema,
  baseUrl: z.string().url().optional(),
  keyEnv: z.string().min(1).optional(),
  apiKey: z.string().min(1).optional(),
  defaultModel: z.string().min(1).optional(),
  headers: z.record(z.string()).optional(),
  requestTimeoutMs: z.number().int().positive().max(600000).optional()
});

export const mcpServerConfigSchema = z.object({
  type: z.enum(["stdio", "http"]),
  command: z.string().min(1).optional(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string()).optional(),
  url: z.string().url().optional(),
  headers: z.record(z.string()).optional(),
  timeoutMs: z.number().int().positive().max(600000).optional(),
  enabled: z.boolean().default(true)
});

export const permissionRuleSchema = z.object({
  tool: z.string().min(1),
  pattern: z.string().optional(),
  decision: z.enum(["allow", "deny", "ask"])
});

export const hookEventSchema = z.enum([
  "session_start",
  "session_end",
  "pre_tool_use",
  "post_tool_use",
  "stop",
  "pre_compact",
  "post_compact",
  "notification"
]);

export const hookConfigSchema = z.object({
  event: hookEventSchema,
  command: z.string().min(1),
  timeoutMs: z.number().int().positive().max(300000).default(30000),
  matcher: z.string().optional(),
  enabled: z.boolean().default(true)
});

export const lspServerConfigSchema = z.object({
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  languages: z.array(z.string()).min(1),
  rootMarkers: z.array(z.string()).optional(),
  initializationOptions: z.record(z.unknown()).optional(),
  enabled: z.boolean().default(true)
});

export const themeConfigSchema = z.object({
  name: z.string().default("axiom-dark"),
  accent: z
    .enum(["cyan", "magenta", "green", "yellow", "blue", "red", "violet"])
    .default("violet")
});

export const languageSchema = z.enum(["en", "ru"]);

export const budgetConfigSchema = z.object({
  maxCostPerMessageUSD: z.number().nonnegative().optional(),
  maxTokensPerMessage: z.number().int().positive().optional(),
  maxToolCallsPerMessage: z.number().int().positive().default(80),
  maxSubagentsPerSession: z.number().int().positive().default(24)
});

export const diagnosticsConfigSchema = z.object({
  autoRun: z.boolean().default(false),
  commands: z.array(z.string()).max(8).default([])
});

const baseGlobalConfigShape = {
  version: z.literal(1).default(1),
  model: z.string().min(1).default("anthropic/claude-sonnet-4-5"),
  fallbackModels: z.array(z.string()).default([]),
  effort: z.enum(["low", "medium", "high"]).default("medium"),
  thinking: z.boolean().default(true),
  thinkingBudgetTokens: z.number().int().positive().default(8000),
  maxTokens: z.number().int().positive().default(16384),
  temperature: z.number().min(0).max(2).optional(),
  mode: permissionModeSchema.default("normal"),
  theme: themeConfigSchema.default({}),
  language: languageSchema.default("en"),
  permissions: z.array(permissionRuleSchema).default([]),
  providers: z.record(providerConfigSchema).default({}),
  mcp: z.record(mcpServerConfigSchema).default({}),
  hooks: z.array(hookConfigSchema).default([]),
  lsp: z.record(lspServerConfigSchema).optional(),
  budget: budgetConfigSchema.default({}),
  diagnostics: diagnosticsConfigSchema.default({}),
  autoCompactThreshold: z.number().min(0.3).max(0.98).default(0.8),
  showThinking: z.boolean().default(true),
  checkForUpdates: z.boolean().default(true),
  trustedProjects: z.array(z.string()).default([])
};

export const globalConfigSchema = z.object(baseGlobalConfigShape).strict();

export const projectConfigSchema = z
  .object({
    version: z.literal(1).default(1),
    model: z.string().min(1).optional(),
    effort: z.enum(["low", "medium", "high"]).optional(),
    thinking: z.boolean().optional(),
    maxTokens: z.number().int().positive().optional(),
    permissions: z.array(permissionRuleSchema).optional(),
    mcp: z.record(mcpServerConfigSchema).optional(),
    hooks: z.array(hookConfigSchema).optional(),
    lsp: z.record(lspServerConfigSchema).optional(),
    diagnostics: diagnosticsConfigSchema.optional(),
    rulesFiles: z.array(z.string()).optional(),
    trusted: z.boolean().optional()
  })
  .strict();

export type GlobalConfig = z.infer<typeof globalConfigSchema>;
export type ProjectConfig = z.infer<typeof projectConfigSchema>;
export type McpServerConfigFile = z.infer<typeof mcpServerConfigSchema>;
export type HookConfig = z.infer<typeof hookConfigSchema>;
export type LspServerConfig = z.infer<typeof lspServerConfigSchema>;

export function parseGlobalConfig(raw: unknown): { config: GlobalConfig; warnings: string[] } {
  const result = globalConfigSchema.safeParse(raw);
  if (result.success) return { config: result.data, warnings: [] };

  const partialResult = globalConfigSchema.partial().safeParse(raw ?? {});
  if (partialResult.success) {
    const merged = globalConfigSchema.parse({});
    const warnings: string[] = [
      `Config validation issues: ${result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ").slice(0, 400)}`
    ];
    for (const [key, value] of Object.entries(partialResult.data)) {
      if (value !== undefined) {
        (merged as Record<string, unknown>)[key] = value;
      }
    }
    return { config: merged, warnings };
  }

  return { config: globalConfigSchema.parse({}), warnings: ["Config unreadable, defaults applied"] };
}

export function parseProjectConfig(raw: unknown): { config: ProjectConfig | null; warnings: string[] } {
  if (raw === undefined || raw === null) return { config: null, warnings: [] };
  const result = projectConfigSchema.safeParse(raw);
  if (result.success) return { config: result.data, warnings: [] };
  return {
    config: null,
    warnings: [
      `Project config invalid and ignored: ${result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ").slice(0, 300)}`
    ]
  };
}

export function defaultGlobalConfig(): GlobalConfig {
  return globalConfigSchema.parse({});
}

export function mergePermissionRules(
  base: PermissionRule[],
  override: PermissionRule[]
): PermissionRule[] {
  const map = new Map<string, PermissionRule>();
  for (const rule of base) map.set(ruleKey(rule), rule);
  for (const rule of override) map.set(ruleKey(rule), rule);
  return [...map.values()];
}

function ruleKey(rule: PermissionRule): string {
  return `${rule.tool}:${rule.pattern ?? "*"}`;
}
