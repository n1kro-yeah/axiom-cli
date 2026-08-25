import type { CommandContext, SlashCommand, CommandResult } from "./registry.js";
import { error, notice, warn } from "./registry.js";
import { maskSecret } from "../auth/store.js";
import { ACCENT_NAMES } from "../ui/theme.js";
import type { AccentName } from "../ui/theme.js";
import { formatCost, formatTokenCount } from "../agent/tokens.js";
import type { LanguageCode } from "../i18n/index.js";

export const coreCommands: SlashCommand[] = [
  {
    name: "help",
    description: "Show keyboard shortcuts and command list",
    execute: async (_args, ctx): Promise<CommandResult> => {
      ctx.ui.openHelp();
      return { kind: "handled" };
    }
  },
  {
    name: "model",
    description: "Switch model",
    argumentHint: "[provider/model]",
    execute: async (args, ctx): Promise<CommandResult> => {
      const target = args.join(" ").trim();
      if (target.length === 0) {
        ctx.ui.openModelPicker();
        return { kind: "handled" };
      }
      try {
        const resolved = ctx.registry.resolveModelInfo(target);
        ctx.agent.setModel(target);
        await ctx.sessions.setSessionModel(ctx.sessionId(), resolved.ref.providerId, resolved.model.id);
        return notice(ctx.t.t(ctx.t.dict.commands.modelChanged, { model: target }));
      } catch {
        return error(ctx.t.t(ctx.t.dict.errors.unknownModel, { model: target }));
      }
    }
  },
  {
    name: "provider",
    description: "Show providers / add new",
    argumentHint: "[add]",
    execute: async (args, ctx): Promise<CommandResult> => {
      if (args[0] === "add" || args[0] === "new") {
        ctx.ui.openProviderAdd();
        return { kind: "handled" };
      }

      const lines: string[] = [];
      for (const providerId of ctx.registry.configuredProviderIds()) {
        const configured = ctx.registry.isConfigured(providerId);
        lines.push(`${configured ? "✓" : "·"} ${providerId.padEnd(12)} ${ctx.registry.providerLabel(providerId)}`);
      }
      lines.push("");
      lines.push("/provider add — add a custom endpoint interactively");
      return notice(lines.join("\n"));
    }
  },
  {
    name: "login",
    description: "Add provider interactively or from env",
    argumentHint: "[provider] [--key-env NAME]",
    execute: async (args, ctx): Promise<CommandResult> => {
      const [provider, ...rest] = args;

      if (!provider) {
        ctx.ui.openProviderAdd();
        return { kind: "handled" };
      }

      const keyEnvIndex = rest.indexOf("--key-env");
      const keyEnv = keyEnvIndex !== -1 ? rest[keyEnvIndex + 1] : undefined;

      const resolution = ctx.auth.resolveApiKey(provider, keyEnv ?? undefined);
      if (resolution.source === "none") {
        return error(
          `No API key found for "${provider}". Run /login without arguments to add it interactively, or set ${`AXIOM_${provider.toUpperCase()}_API_KEY`}.`
        );
      }

      if (resolution.apiKey) {
        await ctx.auth.setProvider(provider, { apiKey: resolution.apiKey });
      }
      return notice(ctx.t.t(ctx.t.dict.commands.loginSuccess, { provider }));
    }
  },
  {
    name: "logout",
    description: "Remove stored credentials",
    argumentHint: "[provider]",
    execute: async (args, ctx): Promise<CommandResult> => {
      const provider = args[0];
      if (!provider) {
        const stored = await ctx.auth.listProviders();
        return notice(`Stored credentials: ${stored.length > 0 ? stored.join(", ") : "(none)"}`);
      }
      const removed = await ctx.auth.removeProvider(provider);
      if (!removed) return error(ctx.t.t(ctx.t.dict.commands.logoutNoProvider, { provider }));
      return notice(ctx.t.t(ctx.t.dict.commands.logoutSuccess, { provider }));
    }
  },
  {
    name: "keys",
    hidden: true,
    description: "List masked keys",
    execute: async (_args, ctx): Promise<CommandResult> => {
      const providers = await ctx.auth.listProviders();
      if (providers.length === 0) return notice("no stored keys");
      const lines: string[] = [];
      for (const provider of providers) {
        const creds = await ctx.auth.getProvider(provider);
        lines.push(`${provider}: ${creds?.apiKey ? maskSecret(creds.apiKey) : "(oauth/other)"}`);
      }
      return notice(lines.join("\n"));
    }
  },
  {
    name: "effort",
    description: "Reasoning depth low|medium|high",
    argumentHint: "<level>",
    execute: async (args, ctx): Promise<CommandResult> => {
      const level = args[0]?.toLowerCase();
      if (level !== "low" && level !== "medium" && level !== "high") {
        return error("usage: /effort <low|medium|high>");
      }
      ctx.config.mutateGlobal((draft) => {
        draft.effort = level;
      });
      return notice(ctx.t.t(ctx.t.dict.commands.effortSet, { value: level }));
    }
  },
  {
    name: "thinking",
    description: "Toggle extended thinking",
    execute: async (_args, ctx): Promise<CommandResult> => {
      const current = ctx.config.loadGlobalSync().thinking;
      const next = !current;
      ctx.config.mutateGlobal((draft) => {
        draft.thinking = next;
      });
      return notice(next ? ctx.t.dict.commands.thinkingOn : ctx.t.dict.commands.thinkingOff);
    }
  },
  {
    name: "mode",
    description: "Permission mode normal|accept|plan|bypass",
    argumentHint: "<mode>",
    execute: async (args, ctx): Promise<CommandResult> => {
      const mode = args[0]?.toLowerCase() as "normal" | "accept" | "plan" | "bypass" | undefined;
      if (!mode || !["normal", "accept", "plan", "bypass"].includes(mode)) {
        return error("usage: /mode <normal|accept|plan|bypass>");
      }
      ctx.ui.setMode(mode);
      return notice(`/mode → ${mode}`);
    }
  },
  {
    name: "bypass",
    description: "Toggle approval-free operation",
    execute: async (_args, ctx): Promise<CommandResult> => {
      const nextMode = ctx.agent.mode === "bypass" ? "normal" : "bypass";
      ctx.ui.setMode(nextMode);
      return notice(
        nextMode === "bypass"
          ? ctx.t.dict.commands.bypassOn
          : ctx.t.dict.commands.bypassOff
      );
    }
  },
  {
    name: "usage",
    description: "Session token/cost report",
    execute: async (_args, ctx): Promise<CommandResult> => {
      const usage = ctx.agent.usage;
      return notice(
        ctx.t.t(ctx.t.dict.commands.usageReport, {
          input: formatTokenCount(usage.inputTokens),
          output: formatTokenCount(usage.outputTokens),
          cacheRead: formatTokenCount(usage.cacheReadTokens),
          cost: ctx.agent.cost.toFixed(4)
        })
      );
    }
  },
  {
    name: "theme",
    description: "Change accent color",
    argumentHint: "[color]",
    execute: async (args, ctx): Promise<CommandResult> => {
      const requested = args[0]?.toLowerCase();
      if (!requested) {
        ctx.ui.openThemePicker();
        return { kind: "handled" };
      }
      if (!ACCENT_NAMES.includes(requested as AccentName)) {
        return error(`available accents: ${ACCENT_NAMES.join(", ")}`);
      }
      ctx.config.mutateGlobal((draft) => {
        draft.theme.accent = requested as AccentName;
      });
      return notice(ctx.t.t(ctx.t.dict.commands.themeSet, { value: requested }));
    }
  },
  {
    name: "lang",
    description: "Interface language en|ru",
    argumentHint: "<lang>",
    execute: async (args, ctx): Promise<CommandResult> => {
      const requested = args[0]?.toLowerCase();
      if (requested !== "en" && requested !== "ru") {
        ctx.ui.openLangPicker();
        return { kind: "handled" };
      }
      ctx.config.mutateGlobal((draft) => {
        draft.language = requested;
      });
      void requested satisfies LanguageCode | undefined;
      return notice(ctx.t.t(ctx.t.dict.commands.langSet, { value: requested }));
    }
  },
  {
    name: "cost",
    hidden: true,
    description: "Total session cost",
    execute: async (_args, ctx): Promise<CommandResult> => {
      return notice(formatCost(ctx.agent.cost));
    }
  },
  {
    name: "exit",
    description: "Quit Axiom",
    aliases: ["quit", "q"],
    execute: async (_args, ctx): Promise<CommandResult> => {
      ctx.ui.requestExit();
      return { kind: "handled" };
    }
  }
];

export function describeModes(): string {
  return "normal — approve edits & commands · accept — auto-approve edits · plan — read-only planning · bypass — no approvals";
}

export function resolveLanguageOrWarn(value: string | undefined): LanguageCode {
  return value === "ru" ? "ru" : "en";
}

export function commandNotFound(name: string): CommandResult {
  return warn(`unknown command "/${name}"`);
}
