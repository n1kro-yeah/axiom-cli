import type { Agent } from "../agent/loop.js";
import type { AuthStore } from "../auth/store.js";
import { AuthStore as AuthStoreImpl } from "../auth/store.js";
import type { ConfigStore, EffectiveConfig } from "../config/loader.js";
import { ConfigStore as ConfigStoreImpl } from "../config/loader.js";
import { computePaths } from "../config/paths.js";
import type { AxiomPaths } from "../config/paths.js";
import type { ProviderRegistry } from "../providers/registry.js";
import { ProviderRegistry as ProviderRegistryImpl } from "../providers/registry.js";
import type { ToolRegistry } from "../tools/registry.js";
import { ToolRegistry as ToolRegistryImpl } from "../tools/registry.js";
import type { PermissionEngine } from "../permissions/engine.js";
import { PermissionEngine as PermissionEngineImpl } from "../permissions/engine.js";
import type { HooksRunner } from "../hooks/runner.js";
import { HooksRunner as HooksRunnerImpl } from "../hooks/runner.js";
import type { SessionStore } from "../session/store.js";
import { SessionStore as SessionStoreImpl } from "../session/store.js";
import type { CheckpointManager } from "../session/checkpoint.js";
import { CheckpointManager as CheckpointManagerImpl } from "../session/checkpoint.js";
import type { McpManager } from "../mcp/manager.js";
import { McpManager as McpManagerImpl } from "../mcp/manager.js";
import type { LspManager } from "../lsp/manager.js";
import { LspManager as LspManagerImpl } from "../lsp/manager.js";
import type { SkillEntry } from "../types.js";
import { loadSkills } from "../skills/loader.js";
import { loadRules } from "../rules/loader.js";
import { createDiagnosticsTool } from "../tools/lsp-diagnostics.js";
import { resolveLanguage, createTranslator } from "../i18n/index.js";
import type { Translator } from "../i18n/index.js";
import { configureLogging, FileSink, addLogSink, createLogger } from "../util/log.js";

const log = createLogger("bootstrap");

export interface BootstrapOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  modelOverride?: string;
  modeOverride?: "normal" | "accept" | "plan" | "bypass";
  maxTokensOverride?: number;
  thinkingOverride?: boolean;
  languageOverride?: "en" | "ru";
  disableHooks?: boolean;
  sessionId?: string;
  sessionTitle?: string;
}

export interface RuntimeBundle {
  paths: AxiomPaths;
  config: ConfigStore;
  auth: AuthStore;
  registry: ProviderRegistry;
  tools: ToolRegistry;
  permissions: PermissionEngine;
  hooks: HooksRunner;
  sessions: SessionStore;
  checkpoints: CheckpointManager;
  mcp: McpManager;
  lsp: LspManager | undefined;
  agent: Agent;
  translator: Translator;
  sessionId: string;
  effective: EffectiveConfig;
  skills: SkillEntry[];
  rulesText: string;
  warnings: string[];
}

export async function bootstrapRuntime(options: BootstrapOptions): Promise<RuntimeBundle> {
  const env = options.env ?? process.env;
  const paths = computePaths(options.cwd, env);

  configureLogging({
    level: env["AXIOM_LOG_LEVEL"] === "debug" ? "debug" : "info",
    sinks: []
  });
  const fileSink = new FileSink(paths.logFile);
  await fileSink.init().catch(() => undefined);
  addLogSink(fileSink);

  log.info(`bootstrapping in ${paths.projectRoot}`);

  const config = new ConfigStoreImpl(paths);
  const globalConfig = config.loadGlobalSync();

  const projectState = await config.loadProject();
  const effective = config.resolveEffective({
    modeOverride: options.modeOverride,
    modelOverride: options.modelOverride
  });
  effective.projectTrusted = projectState.trusted;

  for (const warning of [...effective.warnings, ...projectState.warnings]) {
    log.warn(warning);
  }

  const auth = new AuthStoreImpl(paths.authFile);
  await auth.load();

  const registry = new ProviderRegistryImpl(paths, auth, config);

  const permissions = new PermissionEngineImpl({
    rules: effective.permissions,
    mode: options.modeOverride ?? globalConfig.mode
  });

  const hooks = new HooksRunnerImpl(
    paths.projectRoot,
    ((projectState.trusted ? projectState.config?.hooks : undefined) ?? []).concat(globalConfig.hooks).map((hook) => ({
      event: hook.event,
      command: hook.command,
      timeoutMs: hook.timeoutMs,
      matcher: hook.matcher,
      enabled: hook.enabled
    })),
    { disabled: options.disableHooks === true }
  );

  const sessions = new SessionStoreImpl(paths.sessionsDir);
  const checkpoints = new CheckpointManagerImpl(paths.checkpointsDir);

  const mcp = new McpManagerImpl();
  const mcpEntries = Object.entries(globalConfig.mcp);
  const trustedMcpEntries = projectState.trusted && projectState.config?.mcp
    ? Object.entries(projectState.config.mcp)
    : [];

  for (const [name, server] of [...mcpEntries, ...trustedMcpEntries]) {
    if (!server.enabled) continue;
    mcp.register({
      name,
      type: server.type,
      command: server.command,
      args: server.args,
      env: expandEnvMap(server.env ?? {}, env),
      url: server.url,
      headers: expandEnvMap(server.headers ?? {}, env),
      timeoutMs: server.timeoutMs
    });
  }

  const lspCustom = [
    ...Object.entries(globalConfig.lsp ?? {}),
    ...(projectState.trusted ? Object.entries(projectState.config?.lsp ?? {}) : [])
  ].map(([name, entry]) => ({
    name,
    command: entry.command,
    args: entry.args ?? [],
    languages: entry.languages,
    enabled: entry.enabled !== false
  }));

  let lsp: LspManagerImpl | undefined;
  if (globalConfig.diagnostics.autoRun || lspCustom.length > 0 || true) {
    lsp = new LspManagerImpl(paths.projectRoot, lspCustom);
  }

  const tools = new ToolRegistryImpl();
  tools.addSource(mcp.buildExternalSource());
  if (lsp) {
    const backend = {
      ensureForLanguage: (languageId: string) => lsp!.ensureForLanguage(languageId),
      notifyOpen: (filePath: string, text: string) => lsp!.notifyOpen(filePath, text),
      getDiagnosticsFor: (uriOrPath: string) => lsp!.getDiagnosticsFor(uriOrPath),
      allDiagnostics: () => lsp!.allDiagnostics(),
      statusLines: () => lsp!.statusLines()
    };
    tools.registerTool(createDiagnosticsTool(() => backend));
  }

  const skills = await loadSkills(paths.skillsDir, paths.projectSkillsDir);
  const rulesResult = await loadRules(paths, projectState.trusted);

  const language = options.languageOverride ?? (resolveLanguage(globalConfig.language) as "en" | "ru");
  const translator = createTranslator(language);

  const sessionId = options.sessionId ?? (await sessions.create({
    projectRoot: paths.projectRoot,
    provider: parseProvider(effective.model),
    model: parseModelId(effective.model),
    title: options.sessionTitle
  })).id;

  const { Agent: AgentImpl } = await import("../agent/loop.js");

  const agent = new AgentImpl({
    sessionId,
    cwd: paths.projectRoot,
    mode: options.modeOverride ?? globalConfig.mode,
    language,
    modelReference: effective.model,
    maxTokens: options.maxTokensOverride ?? effective.maxTokens,
    thinkingEnabled: options.thinkingOverride ?? effective.thinking,
    thinkingBudgetTokens: globalConfig.thinkingBudgetTokens,
    temperature: globalConfig.temperature,
    effort: effective.effort,
    autoCompactThreshold: globalConfig.autoCompactThreshold,
    rulesText: rulesResult.combined,
    skills,
    subagentProfiles: [
      { name: "general", description: "General-purpose subagent with full tool access" },
      { name: "explore", description: "Read-only codebase exploration", readOnlyOnly: true },
      { name: "reviewer", description: "Read-only review of changes and quality", readOnlyOnly: true }
    ],
    mcpServerNames: mcp.names(),
    hooks,
    permissionBroker: permissions,
    registry,
    toolResolver: (name) => tools.resolve(name),
    toolSpecs: () => tools.specsForModel({ supportsTools: true, mode: agentMode() }),
    checkpointSink: (id, changedPaths) => {
      try {
        void checkpoints.snapshot(id, changedPaths, "auto");
      } catch {
      }
    }
  });

  function agentMode(): "normal" | "accept" | "plan" | "bypass" {
    return options.modeOverride ?? globalConfig.mode;
  }

  return {
    paths,
    config,
    auth,
    registry,
    tools,
    permissions,
    hooks,
    sessions,
    checkpoints,
    mcp,
    lsp,
    agent,
    translator,
    sessionId,
    effective,
    skills,
    rulesText: rulesResult.combined,
    warnings: [...effective.warnings, ...projectState.warnings]
  };
}

function parseProvider(reference: string): string {
  const slashIndex = reference.indexOf("/");
  return slashIndex === -1 ? reference.slice(0, 24) : reference.slice(0, slashIndex);
}

function parseModelId(reference: string): string {
  const slashIndex = reference.indexOf("/");
  return slashIndex === -1 ? reference : reference.slice(slashIndex + 1);
}

function expandEnvMap(source: Record<string, string>, env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    out[key] = value.replace(/\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name: string) => env[name] ?? "");
  }
  return out;
}
