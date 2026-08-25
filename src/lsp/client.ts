import { spawn } from "node:child_process";
import { createLogger } from "../util/log.js";
import { encodeLfrpcFrame } from "../mcp/jsonrpc.js";

const log = createLogger("lsp-client");

export interface LspClientEvents {
  onDiagnostics?: (uri: string, diagnostics: LspDiagnostic[]) => void;
  onLog?: (level: "info" | "warn" | "error" | "debug", message: string) => void;
  onClose?: (code: number | null) => void;
}

export interface LspDiagnostic {
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
  severity?: number;
  code?: string | number;
  source?: string;
  message: string;
}

export const SEVERITY_LABELS: Record<number, string> = {
  1: "error",
  2: "warning",
  3: "information",
  4: "hint"
};

export interface LspClientOptions {
  command: string;
  args: string[];
  rootUri: string;
  initializationOptions?: Record<string, unknown>;
  serverName: string;
  startupTimeoutMs?: number;
}

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

let nextMessageId = 1;

export function nextLspId(): number {
  const value = nextMessageId;
  nextMessageId += 1;
  return value;
}

export class LspClient {
  readonly serverName: string;

  private processRef: import("node:child_process").ChildProcess | null = null;
  private buffer = "";
  private readonly pending = new Map<number, PendingCall>();
  private readonly events: LspClientEvents;
  private readonly options: LspClientOptions;
  private initialized = false;
  private openDocuments = new Set<string>();
  private lastError: string | undefined;

  constructor(options: LspClientOptions, events: LspClientEvents = {}) {
    this.options = options;
    this.events = events;
    this.serverName = options.serverName;
  }

  get ready(): boolean {
    return this.initialized && this.processRef !== null && this.processRef.exitCode === null;
  }

  get errorDetail(): string | undefined {
    return this.lastError;
  }

  async start(): Promise<void> {
    if (this.ready) return;
    if (this.processRef && this.processRef.exitCode !== null) {
      throw new Error(`LSP server "${this.serverName}" already exited (code ${this.processRef.exitCode}): ${this.lastError ?? ""}`);
    }

    let child;
    try {
      child = spawn(this.options.command, this.options.args, {
        cwd: fileUriToPath(this.options.rootUri),
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true
      });
    } catch (error) {
      throw new Error(`Failed to start LSP "${this.serverName}": ${describe(error)}`);
    }

    this.processRef = child;

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      this.buffer += chunk;
      this.pumpFrames();
    });

    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      this.lastError = ((this.lastError ?? "") + chunk).slice(-2000);
      if (this.events.onLog) this.events.onLog("debug", `[${this.serverName}] ${chunk.trim().slice(0, 300)}`);
    });

    child.on("close", (code) => {
      this.initialized = false;
      this.processRef = null;
      for (const [, entry] of [...this.pending.entries()]) {
        clearTimeout(entry.timer);
        entry.reject(new Error(`LSP server "${this.serverName}" exited`));
      }
      this.pending.clear();
      this.events.onClose?.(code);
    });

    child.on("error", (error) => {
      this.lastError = describe(error);
    });

    await this.handshake();
    this.initialized = true;
  }

  private async handshake(): Promise<void> {
    const result = await this.call("initialize", {
      processId: process.pid,
      capabilities: {
        textDocument: {
          publishDiagnostics: { relatedInformation: true }
        }
      },
      rootUri: this.options.rootUri,
      initializationOptions: this.options.initializationOptions ?? {},
      workspaceFolders: [{ uri: this.options.rootUri, name: "workspace" }]
    }, this.options.startupTimeoutMs ?? 20000);

    void this.notify("initialized", {});
    log.debug(`${this.serverName} initialized (${summarizeCapabilities(result)})`);
  }

  private pumpFrames(): void {
    for (;;) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) return;

      const header = this.buffer.slice(0, headerEnd);
      const lengthMatch = /content-length\s*:\s*(\d+)/i.exec(header);
      if (!lengthMatch) {
        this.buffer = this.buffer.slice(headerEnd + 4);
        continue;
      }

      const contentLength = Number.parseInt(lengthMatch[1], 10);
      const bodyStart = headerEnd + 4;
      if (this.buffer.length < bodyStart + contentLength) return;

      const body = this.buffer.slice(bodyStart, bodyStart + contentLength);
      this.buffer = this.buffer.slice(bodyStart + contentLength);

      try {
        const message = JSON.parse(body) as Record<string, unknown>;
        this.handleMessage(message);
      } catch (error) {
        log.warn(`malformed LSP frame from ${this.serverName}`, error);
      }
    }
  }

  private handleMessage(message: Record<string, unknown>): void {
    const method = typeof message["method"] === "string" ? message["method"] : undefined;

    if (method === undefined) {
      const id = message["id"];
      const entry = typeof id === "number" ? this.pending.get(id) : undefined;
      if (!entry) return;
      clearTimeout(entry.timer);
      this.pending.delete(id as number);

      if (message["error"] !== undefined && message["error"] !== null) {
        const err = message["error"] as Record<string, unknown>;
        entry.reject(new Error(String(err["message"] ?? "LSP request failed")));
      } else {
        entry.resolve(message["result"]);
      }
      return;
    }

    if (method === "textDocument/publishDiagnostics") {
      const params = message["params"] as { uri?: string; diagnostics?: unknown[] } | undefined;
      const uri = params?.uri ?? "";
      const items = Array.isArray(params?.diagnostics)
        ? params.diagnostics.filter(isDiagnosticLike).map(normalizeDiagnostic)
        : [];
      this.events.onDiagnostics?.(uri, items);
      return;
    }

    if (method?.startsWith("window/")) {
      const level = method === "window/showMessage" ? "info" : "debug";
      this.events.onLog?.(level === "info" ? "info" : "debug", JSON.stringify(message["params"] ?? {}).slice(0, 200));
      return;
    }

    if (typeof message["id"] !== "undefined" && !("result" in message || "error" in message)) {
      void this.reply(message["id"] as number, null);
    }
  }

  call(method: string, params: Record<string, unknown>, timeoutMs = 15000): Promise<unknown> {
    return new Promise<unknown>((resolve, reject) => {
      if (!this.processRef || this.processRef.exitCode !== null) {
        reject(new Error(`LSP "${this.serverName}" is not running`));
        return;
      }

      const id = nextLspId();
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`LSP call ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this.pending.set(id, { resolve, reject, timer });
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method: string, params: Record<string, unknown>): void {
    if (!this.processRef || this.processRef.exitCode !== null) return;
    this.write({ jsonrpc: "2.0", method, params });
  }

  private reply(id: number, result: unknown): void {
    this.write({ jsonrpc: "2.0", id, result });
  }

  private write(payload: Record<string, unknown>): void {
    try {
      this.processRef?.stdin?.write(encodeLfrpcFrame(payload as never));
    } catch (error) {
      log.warn(`write failed to ${this.serverName}`, error);
    }
  }

  async openDocument(uri: string, languageId: string, text: string, version = 1): Promise<void> {
    if (!this.openDocuments.has(uri)) {
      this.openDocuments.add(uri);
      this.notify("textDocument/didOpen", {
        textDocument: { uri, languageId, version, text }
      });
    }
  }

  changeDocument(uri: string, text: string, version: number): void {
    this.notify("textDocument/didChange", {
      textDocument: { uri, version },
      contentChanges: [{ text }]
    });
  }

  closeDocument(uri: string): void {
    if (!this.openDocuments.has(uri)) return;
    this.openDocuments.delete(uri);
    this.notify("textDocument/didClose", { textDocument: { uri } });
  }

  documentLanguageIds(): Map<string, string> {
    return new Map([...this.openDocuments].map((uri) => [uri, inferLanguageId(uri)]));
  }

  async stop(): Promise<void> {
    const child = this.processRef;
    if (!child) return;

    try {
      await this.call("shutdown", {}, 4000);
      this.notify("exit", {});
    } catch {
    }

    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 2500);
      child.once("close", () => {
        clearTimeout(timer);
        resolve();
      });
      child.kill();
    });

    this.processRef = null;
    this.initialized = false;
  }
}

function isDiagnosticLike(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof (value as Record<string, unknown>)["message"] === "string"
  );
}

function normalizeDiagnostic(raw: Record<string, unknown>): LspDiagnostic {
  const range = raw["range"] as LspDiagnostic["range"] | undefined;
  const safeRange = range ?? {
    start: { line: 0, character: 0 },
    end: { line: 0, character: 0 }
  };

  return {
    range: safeRange,
    severity: typeof raw["severity"] === "number" ? raw["severity"] : undefined,
    code: raw["code"] as string | number | undefined,
    source: typeof raw["source"] === "string" ? raw["source"] : undefined,
    message: String(raw["message"])
  };
}

function summarizeCapabilities(result: unknown): string {
  if (result === null || typeof result !== "object") return "no capabilities";
  const caps = (result as { capabilities?: Record<string, unknown> }).capabilities;
  if (!caps) return "no capabilities";
  return Object.keys(caps).slice(0, 6).join(",");
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function pathToUri(filePath: string): string {
  const normalized = filePath.replace(/\\/g, "/");
  const drive = /^([a-zA-Z]):/.exec(normalized);
  const encoded = normalized.replace(/#/g, "%23").replace(/\?/g, "%3F");
  return drive ? `file:///${encoded}` : `file://${encoded}`;
}

export function fileUriToPath(uri: string): string {
  if (!uri.startsWith("file://")) return uri;
  let rest = uri.slice("file://".length);
  if (/^\/[a-zA-Z]:/.test(rest)) rest = rest.slice(1);
  return decodeURIComponent(rest).replace(/\//g, "\\");
}

export function inferLanguageId(filePath: string): string {
  const lower = filePath.toLowerCase();
  if (lower.endsWith(".ts")) return "typescript";
  if (lower.endsWith(".tsx")) return "typescriptreact";
  if (lower.endsWith(".js") || lower.endsWith(".mjs") || lower.endsWith(".cjs")) return "javascript";
  if (lower.endsWith(".jsx")) return "javascriptreact";
  if (lower.endsWith(".py")) return "python";
  if (lower.endsWith(".go")) return "go";
  if (lower.endsWith(".rs")) return "rust";
  if (lower.endsWith(".c") || lower.endsWith(".h")) return "c";
  if (lower.endsWith(".cpp") || lower.endsWith(".hpp") || lower.endsWith(".cc")) return "cpp";
  if (lower.endsWith(".json")) return "json";
  return "plaintext";
}
