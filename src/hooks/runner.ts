import { spawn } from "node:child_process";
import type { LifecycleHooksRunner } from "../types.js";
import { createLogger } from "../util/log.js";
import { killProcessTree } from "../tools/bash.js";

const log = createLogger("hooks");

export interface HookDefinition {
  event: string;
  command: string;
  timeoutMs: number;
  matcher?: string;
  enabled: boolean;
}

export interface HookExecutionResult {
  blocked: boolean;
  message?: string;
  stdout: string;
  exitCode: number | null;
  timedOut: boolean;
  error?: string;
}

export class HooksRunner implements LifecycleHooksRunner {
  private hooks: HookDefinition[] = [];
  private readonly cwd: string;
  private readonly disabled: boolean;

  constructor(cwd: string, hooks: HookDefinition[] = [], options: { disabled?: boolean } = {}) {
    this.cwd = cwd;
    this.hooks = hooks.filter((hook) => hook.enabled !== false);
    this.disabled = options.disabled === true || hooks.length === 0;
  }

  setHooks(hooks: HookDefinition[]): void {
    this.hooks = hooks.filter((hook) => hook.enabled !== false);
  }

  get count(): number {
    return this.hooks.length;
  }

  private matching(event: string, toolName?: string): HookDefinition[] {
    if (this.disabled) return [];
    return this.hooks.filter((hook) => {
      if (hook.event !== event) return false;
      if (!hook.matcher || !toolName) return true;
      return toolName.includes(hook.matcher) || hook.matcher === "*";
    });
  }

  async runSessionStart(context: Record<string, unknown>): Promise<void> {
    await this.fire("session_start", context);
  }

  async runSessionEnd(context: Record<string, unknown>): Promise<void> {
    await this.fire("session_end", context);
  }

  async runPreToolUse(input: { tool: string; toolInput: unknown }): Promise<{ blocked: boolean; message?: string }> {
    const results = await this.fire("pre_tool_use", input, input.tool);
    const blocking = results.find((result) => result.blocked);
    if (blocking) {
      log.info(`pre_tool_use hook blocked ${input.tool}: ${blocking.message ?? ""}`);
      return { blocked: true, message: blocking.message };
    }
    return { blocked: false };
  }

  async runPostToolUse(input: { tool: string; toolInput: unknown; result: string; isError: boolean }): Promise<void> {
    await this.fire("post_tool_use", input, input.tool);
  }

  async runPreCompact(): Promise<void> {
    await this.fire("pre_compact", {});
  }

  async runPostCompact(): Promise<void> {
    await this.fire("post_compact", {});
  }

  async runStop(reason: string): Promise<void> {
    await this.fire("stop", { reason });
  }

  private async fire(
    event: string,
    payload: Record<string, unknown>,
    toolName?: string
  ): Promise<HookExecutionResult[]> {
    const targets = this.matching(event, toolName);
    if (targets.length === 0) return [];

    const results: HookExecutionResult[] = [];
    for (const hook of targets) {
      results.push(await executeHookCommand(hook, event, payload, this.cwd));
    }
    return results;
  }
}

export function executeHookCommand(
  hook: HookDefinition,
  event: string,
  payload: Record<string, unknown>,
  cwd: string
): Promise<HookExecutionResult> {
  return new Promise<HookExecutionResult>((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;

    const timeoutMs = Math.max(1000, Math.min(hook.timeoutMs || 30000, 300000));

    const isWindows = process.platform === "win32";
    const executable = isWindows ? process.env["ComSpec"] ?? "cmd.exe" : "/bin/sh";
    const args = isWindows ? ["/d", "/s", "/c", `"${hook.command}"`] : ["-c", hook.command];

    let child;
    try {
      child = spawn(executable, args, {
        cwd,
        env: {
          ...process.env,
          AXIOM_EVENT: event,
          AXIOM_HOOK_COMMAND: hook.command,
          AXIOM_TOOL_NAME: typeof payload["tool"] === "string" ? String(payload["tool"]) : ""
        },
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        detached: !isWindows
      });
    } catch (error) {
      resolve({
        blocked: false,
        stdout: "",
        exitCode: -1,
        timedOut: false,
        error: `spawn failed: ${error instanceof Error ? error.message : String(error)}`
      });
      return;
    }

    child.stdin?.write(JSON.stringify({ event, ...payload }));
    child.stdin?.end();

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    const timer = setTimeout(() => {
      timedOut = true;
      killProcessTree(child.pid ?? -1, process.platform);
    }, timeoutMs);

    const finish = (exitCode: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);

      const parsed = parseHookOutput(stdout);
      const failureExit = exitCode !== null && exitCode !== 0 && exitCode !== 2;

      resolve({
        blocked:
          parsed?.decision === "block" ||
          parsed?.decision === "deny" ||
          exitCode === 2,
        message: parsed?.reason ?? (stderr.trim().length > 0 ? stderr.trim().slice(0, 400) : undefined),
        stdout,
        exitCode,
        timedOut,
        error: failureExit ? `hook exited with code ${exitCode}` : undefined
      });
    };

    child.on("error", () => finish(-1));
    child.on("close", (code) => finish(code));
  });
}

interface HookOutputShape {
  decision?: string;
  reason?: string;
}

function parseHookOutput(stdout: string): HookOutputShape | undefined {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) return undefined;
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    return {
      decision: typeof parsed["decision"] === "string" ? parsed["decision"] : undefined,
      reason: typeof parsed["reason"] === "string" ? parsed["reason"] : undefined
    };
  } catch {
    if (/^block\b/i.test(trimmed)) return { decision: "block" };
    return undefined;
  }
}
