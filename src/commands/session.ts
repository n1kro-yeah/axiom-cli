import { existsSync } from "node:fs";
import { join } from "node:path";
import { readFile, writeFile, mkdir, readdir, unlink } from "node:fs/promises";
import type { CommandContext, SlashCommand, CommandResult } from "./registry.js";
import { error, notice, warn, parseKeyValueArgs } from "./registry.js";
import { performUndo, performRedo } from "../session/checkpoint.js";

export const sessionCommands: SlashCommand[] = [
  {
    name: "clear",
    description: "Start a fresh conversation in this session view",
    execute: async (_args, ctx): Promise<CommandResult> => {
      ctx.agent.messages = [];
      ctx.agent.todos = [];
      return notice(ctx.t.dict.commands.cleared);
    }
  },
  {
    name: "new",
    hidden: true,
    description: "Alias of /clear",
    execute: async (args, ctx) => sessionCommands[0].execute(args, ctx)
  },
  {
    name: "sessions",
    description: "Browse saved sessions",
    argumentHint: "[list]",
    execute: async (args, ctx): Promise<CommandResult> => {
      if (args[0] === "list") {
        const all = await ctx.sessions.listSessions();
        if (all.length === 0) return notice(ctx.t.dict.cli.sessionsEmpty);
        const lines = all.slice(0, 20).map((meta) => {
          const when = new Date(meta.updatedAt).toISOString().slice(0, 16).replace("T", " ");
          return `${meta.id}  ${when}  ${String(meta.messageCount).padStart(3)}msg  ${meta.title}`;
        });
        return notice(lines.join("\n"));
      }
      ctx.ui.openSessions();
      return { kind: "handled" };
    }
  },
  {
    name: "resume",
    description: "Resume a session by id",
    argumentHint: "<id>",
    execute: async (args, ctx): Promise<CommandResult> => {
      const id = args[0];
      if (!id) {
        ctx.ui.openSessions();
        return { kind: "handled" };
      }
      const meta = await ctx.sessions.loadMeta(id);
      if (!meta) return error(`session "${id}" not found`);
      const messages = await ctx.sessions.loadMessages(id);
      ctx.agent.restoreMessages(messages);
      ctx.agent.setModel(`${meta.provider}/${meta.model}`);
      await ctx.sessions.setSessionModel(ctx.sessionId(), meta.provider, meta.model);
      return notice(ctx.t.t(ctx.t.dict.commands.resumed, { title: meta.title }));
    }
  },
  {
    name: "compact",
    description: "Summarize older context now",
    argumentHint: "[instructions]",
    execute: async (args, ctx): Promise<CommandResult> => {
      const instructions = args.join(" ").trim() || undefined;
      try {
        const summary = await ctx.agent.manualCompact(instructions);
        const preview = summary?.split("\n").slice(0, 6).join("\n") ?? "(empty)";
        return notice(`${ctx.t.dict.commands.compacting.replace("…", "")}\n${preview}…`);
      } catch (caught) {
        return error(`compact failed: ${caught instanceof Error ? caught.message : String(caught)}`);
      }
    }
  },
  {
    name: "undo",
    description: "Revert last file checkpoint",
    execute: async (_args, ctx): Promise<CommandResult> => {
      if (!ctx.checkpoints.canUndo(ctx.sessionId())) {
        return notice(ctx.t.dict.commands.undoEmpty);
      }
      const outcome = await performUndo(ctx.checkpoints, ctx.sessionId());
      ctx.ui.refreshFileIndex();
      return outcome.ok
        ? notice(ctx.t.t(ctx.t.dict.commands.undoDone, { files: extractCount(outcome.message) }))
        : error(outcome.message);
    }
  },
  {
    name: "redo",
    description: "Re-apply reverted checkpoint",
    execute: async (_args, ctx): Promise<CommandResult> => {
      if (!ctx.checkpoints.canRedo(ctx.sessionId())) {
        return notice(ctx.t.dict.commands.redoEmpty);
      }
      const outcome = await performRedo(ctx.checkpoints, ctx.sessionId());
      ctx.ui.refreshFileIndex();
      return outcome.ok ? notice(ctx.t.dict.commands.redoDone) : error(outcome.message);
    }
  },
  {
    name: "export",
    description: "Export conversation to Markdown",
    argumentHint: "[path]",
    execute: async (args, ctx): Promise<CommandResult> => {
      const target = args.join("-").trim();
      const dir = join(ctx.paths.projectAxiomDir, "exports");
      await mkdir(dir, { recursive: true });
      const fileName = target.length > 0 ? sanitize(target) : `${ctx.sessionId()}.md`;
      const path = join(dir, fileName.endsWith(".md") ? fileName : `${fileName}.md`);
      const written = await ctx.sessions.exportMarkdown(ctx.sessionId(), path);
      return notice(ctx.t.t(ctx.t.dict.commands.exported, { path: written }));
    }
  },
  {
    name: "attach",
    description: "Attach file to next message",
    argumentHint: "<path|clipboard|list|clear>",
    execute: async (_args, _ctx): Promise<CommandResult> => {
      void _args;
      void _ctx;
      return notice("Use @path in the input or Ctrl+V for clipboard images; chips appear under the prompt.");
    }
  },
  {
    name: "prompt",
    description: "Saved prompts",
    argumentHint: "save <name> | list | rm <name>",
    execute: async (args, ctx): Promise<CommandResult> => {
      await mkdir(ctx.paths.promptsDir, { recursive: true });
      const sub = args[0];

      if (sub === "save") {
        const name = slugify(args[1] ?? "");
        if (!name) return error("usage: /prompt save <name>");
        const lastUser = [...ctx.agent.messages].reverse().find((message) => message.role === "user");
        const text = lastUser?.parts.find((part) => part.type === "text");
        if (!text || text.type !== "text" || text.text.trim().length === 0) {
          return warn("no user message found to save");
        }
        await writeFile(join(ctx.paths.promptsDir, `${name}.md`), text.text, "utf8");
        return notice(`prompt saved as "${name}"`);
      }

      if (sub === "rm") {
        const name = slugify(args[1] ?? "");
        if (!name) return error("usage: /prompt rm <name>");
        const file = join(ctx.paths.promptsDir, `${name}.md`);
        if (!existsSync(file)) return error(ctx.t.dict.cli.promptNotFound);
        await unlink(file);
        return notice(ctx.t.dict.cli.promptRemoved);
      }

      let entries: string[] = [];
      try {
        entries = await readdir(ctx.paths.promptsDir);
      } catch {
        entries = [];
      }
      const prompts = entries.filter((entry) => entry.endsWith(".md"));
      if (prompts.length === 0) return notice(ctx.t.dict.cli.noPrompts);
      return notice(prompts.map((entry) => `- ${entry.replace(/\.md$/, "")}`).join("\n"));
    }
  },
  {
    name: "skills",
    description: "List discovered skills",
    execute: async (_args, ctx): Promise<CommandResult> => {
      const skills = ctx.skills();
      if (skills.length === 0) return notice("no skills discovered (~/.axiom/skills or .axiom/skills)");
      const lines = skills.map(
        (skill) =>
          `${skill.scope === "project" ? "[P] " : "[G] "} ${skill.name}: ${skill.description.split("\n")[0].slice(0, 90)}`
      );
      return notice(lines.join("\n"));
    }
  },
  {
    name: "checker",
    description: "Diagnose runtime setup",
    execute: async (_args, ctx): Promise<CommandResult> => {
      const lines: string[] = [];
      lines.push(`runtime: node ${process.version} on ${process.platform}`);
      lines.push(`config: ${existsSync(ctx.paths.configFile) ? ctx.paths.configFile : "(defaults)"}`);

      const providers = ctx.registry.configuredProviderIds();
      const configured = providers.filter((provider) => ctx.registry.isConfigured(provider));
      lines.push(`providers: ${configured.length}/${providers.length} configured (${configured.join(", ") || "none"})`);

      const model = ctx.agent.modelReference;
      try {
        ctx.registry.resolveModelInfo(model);
        lines.push(`model: + ${model}`);
      } catch {
        lines.push(`model: x ${model} unresolvable`);
      }

      const sessionMeta = await ctx.sessions.loadMeta(ctx.sessionId());
      lines.push(`session: ${ctx.sessionId()} (${String(sessionMeta?.messageCount ?? 0)} messages persisted)`);

      const skills = ctx.skills();
      lines.push(`skills: ${skills.length} found`);
      lines.push(`hooks registered: ${ctx.hooks.count}`);

      const mcpNames = Object.keys(ctx.config.loadGlobalSync().mcp);
      lines.push(`mcp servers configured: ${mcpNames.length > 0 ? mcpNames.join(", ") : "(none)"}`);

      const usage = ctx.agent.usage;
      lines.push(
        `usage so far: ${usage.inputTokens}+${usage.outputTokens} tokens, $${ctx.agent.cost.toFixed(4)}`
      );

      return notice(lines.join("\n"));
    }
  },
  {
    name: "mcp",
    description: "Manage MCP servers",
    argumentHint: "list|add|enable|disable|delete",
    execute: async (args, ctx): Promise<CommandResult> => {
      const global = ctx.config.loadGlobalSync();
      const [sub, name, ...rest] = args;

      if (!sub || sub === "list") {
        const entries = Object.entries(global.mcp);
        if (entries.length === 0) return notice("no MCP servers configured");
        return notice(
          entries.map(([key, config]) => `${config.enabled ? "[x] " : "[ ] "} ${key} (${config.type})`).join("\n")
        );
      }

      if (!name) return error(`usage: /mcp ${sub} <name> ...`);

      if (sub === "add") {
        const parsed = parseKeyValueArgs(rest);
        const url = rest.find((part) => part.startsWith("http://") || part.startsWith("https://"));
        if (url) {
          ctx.config.mutateGlobal((draft) => {
            draft.mcp[name] = { type: "http", url, enabled: true };
          });
          return notice(`MCP server "${name}" added (${url}). Reconnect via /checker.`);
        }
        const command = rest.filter((part) => !part.startsWith("--"))[0];
        if (!command) return error("provide a URL or `-- <command> [args...]`");
        const pipeIndex = rest.indexOf("--");
        const commandArgs = pipeIndex !== -1 ? rest.slice(pipeIndex + 1) : [];
        ctx.config.mutateGlobal((draft) => {
          draft.mcp[name] = { type: "stdio", command, args: commandArgs, enabled: true };
        });
        return notice(`MCP stdio server "${name}" added (${command} ${commandArgs.join(" ")}).`);
      }

      if (!global.mcp[name]) return error(`MCP server "${name}" not configured`);

      if (sub === "enable" || sub === "disable") {
        const enabled = sub === "enable";
        ctx.config.mutateGlobal((draft) => {
          const server = draft.mcp[name];
          if (server) server.enabled = enabled;
        });
        return notice(enabled ? `/mcp ${name} enabled` : ctx.t.t(ctx.t.dict.commands.mcpDisabled, { name }));
      }

      if (sub === "delete" || sub === "remove") {
        ctx.config.mutateGlobal((draft) => {
          delete draft.mcp[name];
        });
        return notice(ctx.t.t(ctx.t.dict.commands.mcpDeleted, { name }));
      }

      return error("usage: /mcp list|add <name> <url|-- cmd>|enable|disable|delete <name>");
    }
  },
  {
    name: "rules",
    hidden: true,
    description: "Show loaded project rules",
    execute: async (_args, ctx): Promise<CommandResult> => {
      const candidates = ["AGENTS.md", "CLAUDE.md", "axiom.md"].map((file) => join(ctx.paths.projectRoot, file));
      const found: string[] = [];
      for (const candidate of candidates) {
        if (existsSync(candidate)) {
          const content = await readFile(candidate, "utf8").catch(() => "");
          found.push(`${candidate} (${content.split("\n").length} lines)`);
        }
      }
      return notice(found.length > 0 ? found.join("\n") : "no rules files in project root");
    }
  }
];

function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
}

function sanitize(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 80);
}

function extractCount(message: string): number {
  const match = /Restored (\d+)/.exec(message);
  return Number(match?.[1] ?? 0);
}
