import { spawn } from "node:child_process";
import type { JsonRpcMessage } from "./jsonrpc.js";
import { decodeJsonLines, serializeMessage, RpcError } from "./jsonrpc.js";
import { createLogger } from "../util/log.js";

const log = createLogger("mcp-stdio");

export interface TransportEvents {
  onMessage: (message: JsonRpcMessage) => void;
  onClose: (code: number | null, reason: string) => void;
  onError: (error: string) => void;
}

export interface StdioTransportOptions {
  command: string;
  args: string[];
  env?: Record<string, string>;
  cwd?: string;
  startupTimeoutMs: number;
}

export class StdioTransport {
  private childProcess: import("node:child_process").ChildProcess | null = null;
  private readBuffer = "";
  private stderrTail: string[] = [];
  private closed = false;
  private readonly events: TransportEvents;
  private readonly options: StdioTransportOptions;

  constructor(options: StdioTransportOptions, events: TransportEvents) {
    this.options = options;
    this.events = events;
  }

  get running(): boolean {
    return this.childProcess !== null && !this.closed && this.childProcess.exitCode === null;
  }

  get lastStderr(): string {
    return this.stderrTail.slice(-6).join("").trim();
  }

  async start(): Promise<void> {
    const isWindows = process.platform === "win32";
    const shellCommand = resolveShellCommand(this.options);

    let child;
    try {
      child = spawn(isWindows ? process.env["ComSpec"] ?? "cmd.exe" : "/bin/sh", isWindows ? ["/d", "/s", "/c", `"${shellCommand}"`] : ["-c", shellCommand], {
        cwd: this.options.cwd ?? process.cwd(),
        env: { ...process.env, ...this.options.env },
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new RpcError(-32000, `Failed to spawn MCP server "${this.options.command}": ${message}`);
    }

    this.childProcess = child;

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      this.readBuffer += chunk;
      const decoded = decodeJsonLines(this.readBuffer);
      this.readBuffer = decoded.rest;
      for (const message of decoded.messages) {
        try {
          this.events.onMessage(message);
        } catch (error) {
          log.error("onMessage handler threw", error);
        }
      }
    });

    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      this.stderrTail.push(chunk);
      if (this.stderrTail.length > 12) this.stderrTail.shift();
    });

    child.on("error", (error) => {
      if (!this.closed) this.events.onError(error.message);
    });

    child.on("close", (code) => {
      this.childProcess = null;
      if (!this.closed) {
        this.events.onClose(code, this.lastStderr);
      }
    });

    await waitForAlive(child, this.options.startupTimeoutMs);
  }

  send(message: JsonRpcMessage): void {
    if (!this.running || !this.childProcess?.stdin?.writable) {
      throw new RpcError(-32000, "MCP stdio transport is not running");
    }

    const payload = `${serializeMessage(message)}\n`;
    try {
      this.childProcess.stdin.write(payload);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new RpcError(-32000, `Write to MCP server failed: ${detail}`);
    }
  }

  async stop(graceMs = 2500): Promise<void> {
    const child = this.childProcess;
    if (!child) return;

    this.closed = false;

    try {
      child.stdin?.end();
    } catch {
    }

    const exited = new Promise<void>((resolve) => {
      if (child.exitCode !== null || !child.pid) {
        resolve();
        return;
      }
      child.once("close", () => resolve());
    });

    const timeout = new Promise<void>((resolve) => setTimeout(resolve, graceMs));
    await Promise.race([exited, timeout]);

    if (child.exitCode === null && child.pid) {
      killTree(child.pid);
    }

    this.childProcess = null;
    this.closed = true;
  }
}

function waitForAlive(child: import("node:child_process").ChildProcess, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    if (child.exitCode !== null) {
      reject(new RpcError(-32000, `MCP server exited immediately with code ${child.exitCode}`));
      return;
    }

    const timer = setTimeout(() => {
      cleanup();
      if (child.exitCode !== null) {
        reject(new RpcError(-32000, `MCP server died during startup`));
      } else {
        resolve();
      }
    }, Math.max(timeoutMs, 1000));

    const onExit = (code: number | null): void => {
      cleanup();
      reject(new RpcError(-32000, `MCP server exited during startup (code ${code})`));
    };
    const onError = (): void => {
      cleanup();
      reject(new RpcError(-32000, "MCP server spawn error"));
    };

    function cleanup(): void {
      clearTimeout(timer);
      child.removeListener("exit", onExit);
      child.removeListener("error", onError);
    }

    child.once("exit", onExit);
    child.once("error", onError);
  });
}

function killTree(pid: number): void {
  try {
    if (process.platform === "win32") {
      spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    } else {
      process.kill(-pid, "SIGKILL");
    }
  } catch {
  }
}

function resolveShellCommand(options: StdioTransportOptions): string {
  const parts = [quoteIfNeeded(options.command), ...options.args.map(quoteIfNeeded)];
  return parts.join(" ");
}

function quoteIfNeeded(value: string): string {
  if (/^[\w./\\:@=+-]+$/.test(value)) return value;
  return `"${value.replace(/"/g, '\\"')}"`;
}
