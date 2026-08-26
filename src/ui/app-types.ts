import type { Agent } from "../agent/loop.js";
import type { AuthStore } from "../auth/store.js";
import type { ConfigStore } from "../config/loader.js";
import type { SessionStore } from "../session/store.js";
import type { CheckpointManager } from "../session/checkpoint.js";
import type { ProviderRegistry } from "../providers/registry.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { HooksRunner } from "../hooks/runner.js";
import type { PermissionEngine } from "../permissions/engine.js";
import type { AxiomPaths } from "../config/paths.js";
import type { Translator } from "../i18n/index.js";
import type { CommandRegistry } from "../commands/registry.js";
import type { McpManager } from "../mcp/manager.js";
import type { LspManager } from "../lsp/manager.js";

export interface TuiRuntime {
  agent: Agent;
  config: ConfigStore;
  auth: AuthStore;
  sessions: SessionStore;
  checkpoints: CheckpointManager;
  registry: ProviderRegistry;
  tools: ToolRegistry;
  hooks: HooksRunner;
  commands: CommandRegistry;
  paths: AxiomPaths;
  translator: Translator;
  permissionEngine: PermissionEngine;
  sessionId: string;
  mcp?: McpManager;
  lsp?: LspManager;
  onExit: () => void;
}
