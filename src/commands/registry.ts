import type { Agent } from "../agent/loop.js";
import type { AuthStore } from "../auth/store.js";
import type { ConfigStore } from "../config/loader.js";
import type { SessionStore } from "../session/store.js";
import type { CheckpointManager } from "../session/checkpoint.js";
import type { ProviderRegistry } from "../providers/registry.js";
import type { AxiomPaths } from "../config/paths.js";
import type { SkillEntry, PermissionMode } from "../types.js";
import type { Translator } from "../i18n/index.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { HooksRunner } from "../hooks/runner.js";

export interface UiBridge {
  openModelPicker(): void;
  openSessions(): void;
  openThemePicker(): void;
  openLangPicker(): void;
  openHelp(): void;
  notice(level: "info" | "warn" | "error", text: string): void;
  requestExit(): void;
  setMode(mode: PermissionMode): void;
  refreshFileIndex(): void;
}

export interface CommandContext {
  agent: Agent;
  config: ConfigStore;
  auth: AuthStore;
  sessions: SessionStore;
  checkpoints: CheckpointManager;
  registry: ProviderRegistry;
  tools: ToolRegistry;
  hooks: HooksRunner;
  paths: AxiomPaths;
  t: Translator;
  skills: () => SkillEntry[];
  sessionId: () => string;
  ui: UiBridge;
}

export type CommandResult =
  | { kind: "none" }
  | { kind: "notice"; level: "info" | "warn" | "error"; text: string }
  | { kind: "handled" };

export interface SlashCommand {
  name: string;
  description: string;
  argumentHint?: string;
  aliases?: string[];
  hidden?: boolean;
  execute(args: string[], ctx: CommandContext): Promise<CommandResult>;
}

export function notice(text: string): CommandResult {
  return { kind: "notice", level: "info", text };
}

export function warn(text: string): CommandResult {
  return { kind: "notice", level: "warn", text };
}

export function error(text: string): CommandResult {
  return { kind: "notice", level: "error", text };
}

export class CommandRegistry {
  private readonly commands = new Map<string, SlashCommand>();

  register(command: SlashCommand): void {
    this.commands.set(command.name, command);
    for (const alias of command.aliases ?? []) {
      if (!this.commands.has(alias)) this.commands.set(alias, command);
    }
  }

  registerAll(commands: SlashCommand[]): void {
    for (const command of commands) this.register(command);
  }

  get(name: string): SlashCommand | undefined {
    return this.commands.get(name.replace(/^\//, "").toLowerCase());
  }

  all(): SlashCommand[] {
    return [...this.commands.values()]
      .filter((command) => !command.hidden)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  hints(): Array<{ name: string; description: string }> {
    return this.all().map((command) => ({
      name: command.name,
      description: command.argumentHint ? `${command.description} (${command.argumentHint})` : command.description
    }));
  }

  async dispatch(rawInput: string, ctx: CommandContext): Promise<CommandResult> {
    const trimmed = rawInput.trim();
    if (!trimmed.startsWith("/")) return { kind: "none" };

    const [namePart, ...argParts] = trimmed.slice(1).split(/\s+/);
    const name = (namePart ?? "").toLowerCase();
    const command = this.get(name);

    if (!command) {
      return error(ctx.t.t(ctx.t.dict.commands.unknown, { name }));
    }

    try {
      return await command.execute(argParts, ctx);
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      return error(`${command.name}: ${message}`);
    }
  }
}

export function parseKeyValueArgs(args: string[]): Record<string, string | boolean> {
  const parsed: Record<string, string | boolean> = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = args[index + 1];
    if (next !== undefined && !next.startsWith("--")) {
      parsed[key] = next;
      index += 1;
    } else {
      parsed[key] = true;
    }
  }
  return parsed;
}

export function splitPipeArgs(rest: string[]): { before: string[]; pipe: string[] } {
  const pipeIndex = rest.indexOf("--");
  if (pipeIndex === -1) return { before: rest, pipe: [] };
  return {
    before: rest.slice(0, pipeIndex),
    pipe: rest.slice(pipeIndex + 1)
  };
}
