import { spawn } from "node:child_process";
import type { ToolDefinition, ToolInvocationResult, ToolContext } from "../types.js";
import { AxiomError } from "../util/errors.js";
import { createLogger } from "../util/log.js";
import { truncateToolOutput } from "./common.js";

const log = createLogger("bash");

const DEFAULT_TIMEOUT_MS = 120000;
const MAX_TIMEOUT_MS = 600000;
const MAX_OUTPUT_CHARS = 28000;
const PROGRESS_THROTTLE_MS = 120;

interface BashInput {
  command?: string;
  timeout_ms?: number;
  description?: string;
}

export interface ShellSpec {
  executable: string;
  baseArgs: string[];
  quotingStyle: "windows" | "posix";
}

export function selectShell(platform: string, env: NodeJS.ProcessEnv): ShellSpec {
  if (platform === "win32") {
    const comspec = env["ComSpec"] ?? "cmd.exe";
    const preferPowerShell = env["AXIOM_SHELL"] === "powershell" || env["AXIOM_PWSH"] === "1";
    if (preferPowerShell) {
      return { executable: "powershell.exe", baseArgs: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command"], quotingStyle: "windows" };
    }
    return { executable: comspec, baseArgs: ["/d", "/s", "/c"], quotingStyle: "windows" };
  }
  if (platform === "darwin") {
    return { executable: "/bin/zsh", baseArgs: ["-l", "-c"], quotingStyle: "posix" };
  }
  return { executable: "/bin/bash", baseArgs: ["-c"], quotingStyle: "posix" };
}

export function buildSpawnArgs(spec: ShellSpec, command: string): { file: string; args: string[] } {
  if (process.platform === "win32" && spec.executable.toLowerCase().includes("cmd")) {
    return { file: spec.executable, args: ["/d", "/s", "/c", `"${command}"`] };
  }
  return { file: spec.executable, args: [...spec.baseArgs, command] };
}

export function killProcessTree(pid: number, platform: string): void {
  try {
    if (platform === "win32") {
      spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    } else {
      process.kill(-pid, "SIGKILL");
    }
  } catch (error) {
    log.debug(`kill tree failed for pid ${pid}`, error);
  }
}

export interface RunCommandOutcome {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  combined: string;
  timedOut: boolean;
  aborted: boolean;
  durationMs: number;
}

export async function runShellCommand(
  command: string,
  options: {
    cwd: string;
    timeoutMs: number;
    abortSignal?: AbortSignal;
    onOutput?: (chunk: string) => void;
    envExtra?: Record<string, string>;
    maxBufferChars?: number;
  }
): Promise<RunCommandOutcome> {
  const spec = selectShell(process.platform, process.env);
  const { file, args } = buildSpawnArgs(spec, command);
  const startedAt = Date.now();

  return new Promise<RunCommandOutcome>((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let aborted = false;
    let settled = false;

    let lastProgressAt = 0;

    const child = spawn(file, args, {
      cwd: options.cwd,
      env: { ...process.env, ...(options.envExtra ?? {}) },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      detached: process.platform !== "win32"
    });

    const maxBuffer = options.maxBufferChars ?? MAX_OUTPUT_CHARS * 2;

    const appendChunk = (target: "stdout" | "stderr", chunk: string): void => {
      if (target === "stdout") {
        if (stdout.length < maxBuffer) stdout += chunk;
      } else {
        if (stderr.length < maxBuffer) stderr += chunk;
      }

      const now = Date.now();
      if (options.onOutput && now - lastProgressAt >= PROGRESS_THROTTLE_MS) {
        lastProgressAt = now;
        options.onOutput(chunk.replace(/\r\n/g, "\n").split("\n").filter(Boolean).slice(0, 4).join("\n"));
      }
    };

    child.stdout?.on("data", (data: Buffer) => {
      appendChunk("stdout", data.toString("utf8"));
    });

    child.stderr?.on("data", (data: Buffer) => {
      appendChunk("stderr", data.toString("utf8"));
    });

    const timer = setTimeout(() => {
      timedOut = true;
      killProcessTree(child.pid ?? -1, process.platform);
    }, options.timeoutMs);

    const onAbort = () => {
      aborted = true;
      killProcessTree(child.pid ?? -1, process.platform);
    };

    options.abortSignal?.addEventListener("abort", onAbort, { once: true });

    const finish = (exitCode: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.abortSignal?.removeEventListener("abort", onAbort);

      const combinedParts: string[] = [];
      if (stdout.trim().length > 0) combinedParts.push(stdout.trimEnd());
      if (stderr.trim().length > 0) combinedParts.push(`[stderr]\n${stderr.trimEnd()}`);

      resolve({
        exitCode,
        signal,
        stdout,
        stderr,
        combined: combinedParts.join("\n"),
        timedOut,
        aborted,
        durationMs: Date.now() - startedAt
      });
    };

    child.on("error", (error) => {
      stderr += `\n[spawn error] ${error.message}`;
      finish(-1, null);
    });

    child.on("close", (code, signal) => {
      finish(code, signal);
    });
  });
}

export const bashTool: ToolDefinition = {
  name: "bash",
  label: "Bash",
  description:
    "Execute a shell command in the project root and return its output. On Windows runs via cmd.exe (or powershell when AXIOM_SHELL=powershell); on macOS zsh; otherwise bash. Avoid interactive commands. Use for builds, tests, git, installs.",
  parameters: {
    type: "object",
    properties: {
      command: {
        type: "string",
        description: "The shell command to execute"
      },
      timeout_ms: {
        type: "number",
        description: "Timeout in milliseconds (default 120000, max 600000)"
      },
      description: {
        type: "string",
        description: "Short human-readable purpose of the command"
      }
    },
    required: ["command"]
  },
  readOnly: false,

  needsPermission(input): ReturnType<ToolDefinition["needsPermission"]> {
    const command = String(input["command"] ?? "");
    return {
      required: true,
      risk: classifyRisk(command),
      pattern: `bash:${command.split(/\s+/).slice(0, 2).join(" ")}`,
      title: "Run shell command",
      summary: [command]
    };
  },

  async execute(
    input: Record<string, unknown>,
    context: ToolContext
  ): Promise<ToolInvocationResult> {
    const typed = input as BashInput;
    const command = typed.command?.trim();
    if (!command) throw new AxiomError("bash requires a command");
    if (command.length > 8000) throw new AxiomError("command exceeds 8000 characters");

    const requestedTimeout = typed.timeout_ms ?? DEFAULT_TIMEOUT_MS;
    const timeoutMs = Math.min(Math.max(requestedTimeout, 1000), MAX_TIMEOUT_MS);

    context.reportProgress(context.sessionId, `$ ${truncateForProgress(command, 160)}`);

    const outcome = await runShellCommand(command, {
      cwd: context.cwd,
      timeoutMs,
      abortSignal: context.abortSignal,
      onOutput: (chunk) => {
        context.reportProgress(context.sessionId, chunk.slice(0, 200));
      }
    });

    if (outcome.aborted) {
      return { content: "Command aborted by user", isError: true, metadata: { aborted: true } };
    }

    if (outcome.timedOut) {
      return {
        content: truncateToolOutput(
          `Command timed out after ${timeoutMs}ms.\nPartial output:\n${outcome.combined || "(no output)"}`
        ),
        isError: true,
        metadata: { timedOut: true, durationMs: outcome.durationMs }
      };
    }

    const header =
      outcome.exitCode === 0
        ? `Exit code 0 (${(outcome.durationMs / 1000).toFixed(1)}s)`
        : `Exit code ${outcome.exitCode ?? "signal:" + outcome.signal} (${(outcome.durationMs / 1000).toFixed(1)}s)`;

    const body = outcome.combined.length > 0 ? outcome.combined : "(no output)";
    const failed = outcome.exitCode !== 0;

    return {
      content: truncateToolOutput(`${header}\n${body}`),
      isError: failed,
      metadata: {
        exitCode: outcome.exitCode,
        durationMs: outcome.durationMs,
        outputChars: body.length
      }
    };
  }
};

function truncateForProgress(command: string, limit: number): string {
  const single = command.replace(/\s+/g, " ");
  return single.length <= limit ? single : `${single.slice(0, limit - 1)}…`;
}

const DESTRUCTIVE_PATTERNS: RegExp[] = [
  /\brm\s+(-[a-z]*[rf][a-z]*\s+)/i,
  /\brmdir\b/i,
  /\bdel\s+\/[sq]/i,
  /\brd\s+\/s/i,
  /\bformat\b/i,
  /\bgit\s+push\s+(--force|-f)/i,
  /\bgit\s+reset\s+--hard/i,
  /\bgit\s+clean\s+-[fd]/i,
  /\bdrop\s+(table|database)\b/i,
  /\btruncate\s+table\b/i,
  /\bmkfs\b/i,
  /\bdd\s+if=/i,
  /\bshutdown\b/i,
  /\breboot\b/i,
  /\bsudo\b/i
];

const INSTALL_PATTERNS: RegExp[] = [
  /\bnpm\s+(install|i|ci)\b/i,
  /\bpnpm\s+(install|add)\b/i,
  /\byarn\s+(install|add)\b/i,
  /\bbun\s+install\b/i,
  /\bpip\s+install\b/i,
  /\bcargo\s+(install|add)\b/i,
  /\bgo\s+(install|get)\b/i,
  /\bapt(-get)?\s+install\b/i,
  /\bbrew\s+install\b/i
];

const NETWORK_PATTERNS: RegExp[] = [
  /\bcurl\b/i,
  /\bwget\b/i,
  /\bssh\b/i,
  /\bscp\b/i,
  /\bnc\b/,
  /\btelnet\b/i
];

export function classifyRisk(command: string): "low" | "medium" | "high" {
  for (const pattern of DESTRUCTIVE_PATTERNS) {
    if (pattern.test(command)) return "high";
  }
  for (const pattern of INSTALL_PATTERNS) {
    if (pattern.test(command)) return "medium";
  }
  for (const pattern of NETWORK_PATTERNS) {
    if (pattern.test(command)) return "medium";
  }
  if (/^(\.\/|\w+\\)?[\w.-]+\.(exe|bat|cmd|ps1)\b/i.test(command.trim())) return "medium";
  return "low";
}
