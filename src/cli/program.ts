import { existsSync, readFileSync } from "node:fs";
import picocolors from "picocolors";
import { bootstrapRuntime } from "./bootstrap.js";
import type { RuntimeBundle } from "./bootstrap.js";
import { runHeadless } from "./headless.js";
import type { HeadlessOutputFormat } from "./headless.js";
import { CommandRegistry } from "../commands/registry.js";
import { coreCommands } from "../commands/core.js";
import { sessionCommands } from "../commands/session.js";
import { AxiomApp } from "../ui/app.js";
import type { TuiRuntime } from "../ui/app.js";
import { render } from "ink";
import React from "react";
import { performUndo, performRedo } from "../session/checkpoint.js";

export const VERSION = "0.1.0";

export interface MainInput {
  argv: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  interactive?: boolean;
  version?: string;
}

interface ParsedArgs {
  positionals: string[];
  flags: Map<string, string | boolean>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags = new Map<string, string | boolean>();

  let index = 0;
  let noMoreFlags = false;

  while (index < argv.length) {
    const token = argv[index] ?? "";
    if (noMoreFlags || !token.startsWith("-") || token === "-") {
      positionals.push(token);
      index += 1;
      continue;
    }
    if (token === "--") {
      noMoreFlags = true;
      index += 1;
      continue;
    }

    const isLong = token.startsWith("--");
    const rawKey = isLong ? token.slice(2) : token.slice(1);
    const eqIndex = rawKey.indexOf("=");

    if (eqIndex !== -1) {
      flags.set(rawKey.slice(0, eqIndex), rawKey.slice(eqIndex + 1));
      index += 1;
      continue;
    }

    const next = argv[index + 1];
    const takesValue =
      next !== undefined && !next.startsWith("-") &&
      ["p", "m", "model", "cwd", "mode", "output-format", "max-tokens", "resume", "r", "c", "continue", "title", "lang", "key-env", "format", "effort"].includes(rawKey);

    if (takesValue && next !== undefined) {
      flags.set(rawKey, next);
      index += 2;
      continue;
    }

    flags.set(rawKey, true);
    index += 1;
  }

  return { positionals, flags };
}

const USAGE_LINES: Array<[string, string]> = [
  ["axiom", "start the interactive TUI in the current project"],
  ["axiom -p \"prompt\"", "run one prompt headlessly (text output)"],
  ["axiom -p \"prompt\" --output-format json", "headless with JSON envelope"],
  ["axiom -p \"prompt\" --output-format stream-json", "headless with event stream"],
  ["axiom -c", "continue the most recent session of this project"],
  ["axiom -r <id>", "resume a session by id"],
  ["axiom --model provider/model", "override model for this run"],
  ["axiom sessions", "list saved sessions"],
  ["axiom trust [--revoke]", "(un-)trust this project's config and skills"],
  ["axiom config", "print effective configuration and paths"],
  ["axiom undo | redo", "file checkpoint operations for latest session"],
  ["axiom version", "print version"]
];

function printUsage(): void {
  const out: string[] = [];
  out.push(picocolors.bold(`axiom ${VERSION}`) + picocolors.gray(" — agentic coding assistant for your terminal"));
  out.push("");
  out.push(picocolors.bold("Usage"));
  for (const [command, description] of USAGE_LINES) {
    out.push(`  ${picocolors.cyan(command.padEnd(42))}${description}`);
  }
  out.push("");
  out.push(picocolors.gray("Inside the TUI: /help shows commands, Shift+Tab cycles modes, @ references files."));
  process.stdout.write(`${out.join("\n")}\n`);
}

async function resolveSessionStart(bundle: RuntimeBundle, parsed: ParsedArgs): Promise<void> {
  const wantsContinue = parsed.flags.has("continue") || parsed.flags.has("c");
  const resumeId = typeof parsed.flags.get("resume") === "string" ? String(parsed.flags.get("resume")) : typeof parsed.flags.get("r") === "string" ? String(parsed.flags.get("r")) : undefined;

  if (resumeId) {
    const meta = await bundle.sessions.loadMeta(resumeId);
    if (!meta) throw new Error(`session "${resumeId}" not found`);
    const messages = await bundle.sessions.loadMessages(resumeId);
    bundle.agent.restoreMessages(messages);
    bundle.agent.setModel(`${meta.provider}/${meta.model}`);
    return;
  }

  if (wantsContinue) {
    const latest = await bundle.sessions.latestForProject(bundle.paths.projectRoot);
    if (!latest) throw new Error("no previous session for this project");
    const messages = await bundle.sessions.loadMessages(latest.id);
    bundle.agent.restoreMessages(messages);
    bundle.agent.setModel(`${latest.provider}/${latest.model}`);
  }
}

async function commandSessions(bundle: RuntimeBundle): Promise<number> {
  const all = await bundle.sessions.listSessions();
  if (all.length === 0) {
    process.stdout.write("No saved sessions yet.\n");
    return 0;
  }

  const header = `${"ID".padEnd(24)}${"UPDATED".padEnd(18)}${"MSGS".padEnd(6)}${"COST".padEnd(9)}TITLE`;
  process.stdout.write(`${header}\n${"-".repeat(header.length)}\n`);
  for (const meta of all.slice(0, 40)) {
    const when = new Date(meta.updatedAt).toISOString().slice(0, 16).replace("T", " ");
    process.stdout.write(
      `${meta.id.padEnd(24)}${when.padEnd(18)}${String(meta.messageCount).padEnd(6)}$${meta.totalCostUSD.toFixed(3).padEnd(8)} ${meta.title}\n`
    );
  }
  return 0;
}

async function commandTrust(bundle: RuntimeBundle, revoke: boolean): Promise<number> {
  await bundle.config.trustProject(revoke);
  process.stdout.write(revoke ? "Project trust revoked.\n" : "Project trusted — project config, skills and hooks are now active.\n");
  return 0;
}

async function commandConfig(bundle: RuntimeBundle): Promise<number> {
  const global = bundle.config.loadGlobalSync();
  const lines = [
    `paths.configFile     ${bundle.paths.configFile}`,
    `paths.authFile       ${bundle.paths.authFile}`,
    `paths.sessionsDir    ${bundle.paths.sessionsDir}`,
    `paths.checkpointsDir ${bundle.paths.checkpointsDir}`,
    `paths.skillsDir      ${bundle.paths.skillsDir} (+ .axiom/skills per project)`,
    `paths.logFile        ${bundle.paths.logFile}`,
    "",
    `model            ${global.model}`,
    `mode             ${global.mode}`,
    `effort           ${global.effort}`,
    `thinking         ${global.thinking ? "on" : "off"} (${global.thinkingBudgetTokens} budget tokens)`,
    `maxTokens        ${global.maxTokens}`,
    `autoCompact      at ${Math.round(global.autoCompactThreshold * 100)}% context`,
    `language         ${global.language}`,
    `accent           ${global.theme.accent}`,
    `permissions      ${global.permissions.length} rule(s)`,
    `providers        ${Object.keys(global.providers).join(", ") || "(builtin only)"}`,
    `mcp servers      ${Object.keys(global.mcp).join(", ") || "(none)"}`,
    `hooks            ${global.hooks.length} registered`
  ];
  process.stdout.write(`${lines.join("\n")}\n`);
  return 0;
}

async function commandCheckpoint(bundle: RuntimeBundle, kind: "undo" | "redo"): Promise<number> {
  const latest = await bundle.sessions.latestForProject(bundle.paths.projectRoot);
  if (!latest) {
    process.stdout.write("No session found.\n");
    return 1;
  }
  const outcome =
    kind === "undo"
      ? await performUndo(bundle.checkpoints, latest.id)
      : await performRedo(bundle.checkpoints, latest.id);
  process.stdout.write(`${outcome.message}\n`);
  return outcome.ok ? 0 : 1;
}

async function runTui(bundle: RuntimeBundle, parsed: ParsedArgs): Promise<number> {
  await resolveSessionStart(bundle, parsed);
  await bundle.mcp.connectAll().catch(() => undefined);

  const registry = new CommandRegistry();
  registry.registerAll(coreCommands);
  registry.registerAll(sessionCommands);

  let exited = false;

  const tuiRuntime: TuiRuntime = {
    agent: bundle.agent,
    config: bundle.config,
    auth: bundle.auth,
    sessions: bundle.sessions,
    checkpoints: bundle.checkpoints,
    registry: bundle.registry,
    tools: bundle.tools,
    hooks: bundle.hooks,
    commands: registry,
    paths: bundle.paths,
    translator: bundle.translator,
    permissionEngine: bundle.permissions,
    sessionId: bundle.agent.id,
    onExit: () => {
      if (exited) return;
      exited = true;
      void shutdown(bundle).finally(() => process.exit(0));
    }
  };

  const titleFlag = parsed.flags.get("title");
  if (typeof titleFlag === "string" && titleFlag.trim().length > 0) {
    void bundle.sessions.renameSession(bundle.sessionId, titleFlag);
  }

  const instance = render(React.createElement(AxiomApp, { runtime: tuiRuntime }), {
    exitOnCtrlC: false,
    patchConsole: true
  });

  await instance.waitUntilExit();
  if (!exited) {
    await shutdown(bundle);
  }

  return 0;
}

async function shutdown(bundle: RuntimeBundle): Promise<void> {
  try {
    await bundle.sessions.updateMeta(bundle.sessionId, (draft) => {
      draft.messageCount = bundle.agent.messages.length;
      draft.totalCostUSD = bundle.agent.cost;
      draft.totalUsage = bundle.agent.usage;
    });
    await bundle.hooks.runSessionEnd({ sessionId: bundle.sessionId });
    await bundle.mcp.shutdown();
    await bundle.lsp?.shutdownAll();
  } catch {
  }
}

async function readStdinIfPiped(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  await new Promise<void>((resolve) => {
    process.stdin.on("data", (chunk: Buffer) => chunks.push(chunk));
    process.stdin.on("end", () => resolve());
    setTimeout(() => resolve(), 250).unref?.();
  });
  return Buffer.concat(chunks).toString("utf8").trim();
}

export async function main(input: MainInput): Promise<number> {
  const env = input.env ?? process.env;
  if (env["AXIOM_VERSION_ONLY"] === "1") {
    process.stdout.write(`axiom ${input.version ?? VERSION}\n`);
    return 0;
  }

  const parsed = parseArgs(input.argv);
  const positionalCommand = parsed.positionals[0];

  if (parsed.flags.has("version") && !positionalCommand) {
    process.stdout.write(`axiom ${input.version ?? VERSION}\n`);
    return 0;
  }

  if (parsed.flags.has("help") && !positionalCommand) {
    printUsage();
    return 0;
  }

  const cwdFlag = typeof parsed.flags.get("cwd") === "string" ? String(parsed.flags.get("cwd")) : input.cwd;
  if (!existsSync(cwdFlag)) {
    process.stderr.write(`Working directory does not exist: ${cwdFlag}\n`);
    return 2;
  }

  if (positionalCommand === "version") {
    process.stdout.write(`axiom ${input.version ?? VERSION}\n`);
    return 0;
  }

  const modeFlag = typeof parsed.flags.get("mode") === "string" ? String(parsed.flags.get("mode")) : undefined;
  const modelFlag = typeof parsed.flags.get("model") === "string" ? String(parsed.flags.get("model")) : undefined;
  const maxTokensFlag = typeof parsed.flags.get("max-tokens") === "number"
    ? Number(parsed.flags.get("max-tokens"))
    : typeof parsed.flags.get("max-tokens") === "string"
      ? Number(parsed.flags.get("max-tokens"))
      : undefined;

  if (positionalCommand && ["sessions", "trust", "config", "undo", "redo"].includes(positionalCommand)) {
    const bundle = await bootstrapRuntime({
      cwd: cwdFlag,
      env,
      modelOverride: modelFlag,
      modeOverride: modeFlag as never,
      disableHooks: true
    });

    switch (positionalCommand) {
      case "sessions":
        return commandSessions(bundle);
      case "trust":
        return commandTrust(bundle, parsed.flags.has("revoke"));
      case "config":
        return commandConfig(bundle);
      case "undo":
        return commandCheckpoint(bundle, "undo");
      case "redo":
        return commandCheckpoint(bundle, "redo");
    }
  }

  let promptText: string | undefined;
  if (parsed.flags.has("p")) {
    promptText = typeof parsed.flags.get("p") === "string" ? String(parsed.flags.get("p")) : parsed.positionals.join(" ");
  } else if (parsed.flags.has("print")) {
    promptText = typeof parsed.flags.get("print") === "string" ? String(parsed.flags.get("print")) : undefined;
  } else if (parsed.flags.has("run")) {
    promptText = typeof parsed.flags.get("run") === "string" ? String(parsed.flags.get("run")) : undefined;
  }

  const pipedStdin = await readStdinIfPiped();
  if (promptText !== undefined && pipedStdin.length > 0) {
    promptText = `${promptText}\n\n[piped stdin]\n${pipedStdin}`;
  }

  if (promptText === undefined && !positionalCommand) {
    promptText = pipedStdin.length > 0 ? pipedStdin : undefined;
  }

  const formatFlag = String(parsed.flags.get("output-format") ?? parsed.flags.get("format") ?? "text");
  const quiet = parsed.flags.has("quiet") || parsed.flags.has("q");

  const bundle = await bootstrapRuntime({
    cwd: cwdFlag,
    env,
    modelOverride: modelFlag,
    modeOverride: modeFlag as never,
    maxTokensOverride: maxTokensFlag,
    thinkingOverride: parsed.flags.has("no-thinking") ? false : undefined,
    sessionId: typeof parsed.flags.get("resume") === "string" ? String(parsed.flags.get("resume")) : typeof parsed.flags.get("r") === "string" ? String(parsed.flags.get("r")) : undefined
  });

  for (const warning of bundle.warnings) {
    process.stderr.write(`${picocolors.yellow("⚠")} ${warning}\n`);
  }

  if (promptText !== undefined) {
    if (promptText.trim().length === 0) {
      process.stderr.write("Empty prompt provided.\n");
      return 2;
    }
    const format: HeadlessOutputFormat =
      formatFlag === "json" || formatFlag === "stream-json" ? (formatFlag as HeadlessOutputFormat) : "text";
    const outcome = await runHeadless(bundle, { prompt: promptText, format, quiet });
    await shutdown(bundle);
    return outcome.exitCode;
  }

  return runTui(bundle, parsed);
}

export function loadPackageVersion(packageJsonPath: string): string {
  try {
    const raw = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { version?: string };
    return raw.version ?? VERSION;
  } catch {
    return VERSION;
  }
}
