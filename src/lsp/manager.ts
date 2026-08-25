import { existsSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createLogger } from "../util/log.js";
import { AxiomError } from "../util/errors.js";
import { LspClient, inferLanguageId, pathToUri } from "./client.js";
import type { LspDiagnostic } from "./client.js";

const log = createLogger("lsp-manager");

export interface LanguageServerSpec {
  languages: string[];
  command: string;
  args: string[];
  probeFiles?: string[];
  rootMarkers?: string[];
  initializationOptions?: Record<string, unknown>;
}

const BUILTIN_SERVERS: LanguageServerSpec[] = [
  {
    languages: ["typescript", "typescriptreact", "javascript", "javascriptreact"],
    command: process.platform === "win32" ? "typescript-language-server.cmd" : "typescript-language-server",
    args: ["--stdio"],
    probeFiles: ["package.json", "tsconfig.json"]
  },
  {
    languages: ["python"],
    command: process.platform === "win32" ? "pyright-langserver.cmd" : "pyright-langserver",
    args: ["--stdio"],
    probeFiles: ["pyproject.toml", "requirements.txt", "setup.py"]
  },
  {
    languages: ["go"],
    command: "gopls",
    args: [],
    probeFiles: ["go.mod", "go.sum"]
  },
  {
    languages: ["rust"],
    command: "rust-analyzer",
    args: [],
    probeFiles: ["Cargo.toml"]
  },
  {
    languages: ["c", "cpp"],
    command: "clangd",
    args: ["--background-index"],
    probeFiles: ["compile_commands.json", "CMakeLists.txt", "Makefile"]
  }
];

export interface DiagnosticsSnapshot {
  uri: string;
  items: LspDiagnostic[];
}

export class LspManager {
  private readonly clients = new Map<string, LspClient>();
  private readonly diagnosticsByServer = new Map<string, Map<string, LspDiagnostic[]>>();
  private readonly specs: LanguageServerSpec[];
  private readonly rootPath: string;
  private disabled: boolean;

  constructor(rootPath: string, customServers: Array<{ name: string; command: string; args: string[]; languages: string[]; enabled?: boolean }> = []) {
    this.rootPath = rootPath;
    this.disabled = false;

    const builtinAdjusted = BUILTIN_SERVERS;

    const customs: LanguageServerSpec[] = customServers
      .filter((entry) => entry.enabled !== false)
      .map((entry) => ({
        languages: entry.languages,
        command: entry.command,
        args: entry.args,
        initializationOptions: undefined
      }));

    this.specs = [...customs, ...builtinAdjusted];
  }

  setDisabled(value: boolean): void {
    this.disabled = value;
  }

  get enabled(): boolean {
    return !this.disabled;
  }

  detectLanguageForFile(filePath: string): string {
    return inferLanguageId(filePath);
  }

  findSpecForLanguage(languageId: string): LanguageServerSpec | undefined {
    return this.specs.find((spec) => spec.languages.includes(languageId));
  }

  async ensureForLanguage(languageId: string): Promise<LspClient | undefined> {
    if (this.disabled) return undefined;
    const existingKey = this.keyForLanguage(languageId);
    if (existingKey) return this.clients.get(existingKey);

    const spec = this.findSpecForLanguage(languageId);
    if (!spec) return undefined;

    if (spec.probeFiles && spec.probeFiles.length > 0 && !spec.probeFiles.some((marker) => existsSync(join(this.rootPath, marker)))) {
      log.debug(`skipping ${spec.command}: no project markers`);
      return undefined;
    }

    const key = spec.command.split(/[\\/]/).pop() ?? spec.command;

    if (!commandExists(spec.command)) {
      log.debug(`LSP binary not found on PATH: ${spec.command}`);
      return undefined;
    }

    const client = new LspClient({
      serverName: key,
      command: spec.command,
      args: spec.args,
      rootUri: pathToUri(this.rootPath),
      initializationOptions: spec.initializationOptions
    }, {
      onDiagnostics: (uri, items) => this.recordDiagnostics(key, uri, items),
      onClose: () => {
        this.clients.delete(key);
        this.diagnosticsByServer.delete(key);
      }
    });

    try {
      await client.start();
      this.clients.set(key, client);
      this.diagnosticsByServer.set(key, new Map());
      log.info(`started ${key} for ${languageId}`);
      return client;
    } catch (error) {
      log.warn(`failed to start ${spec.command}`, error);
      return undefined;
    }
  }

  async notifyOpen(filePath: string, text: string): Promise<void> {
    if (this.disabled) return;
    const languageId = inferLanguageId(filePath);
    const client = await this.ensureForLanguage(languageId);
    if (!client) return;

    const uri = pathToUri(join(this.rootPath, relativeToRoot(this.rootPath, filePath)));
    await client.openDocument(uri, languageId, text);

    const deadline = Date.now() + 2500;
    while (Date.now() < deadline) {
      await sleep(120);
      const snapshot = this.getDiagnosticsFor(uri);
      if (snapshot.length > 0 || Date.now() - deadline > -1200) break;
    }
  }

  getDiagnosticsFor(uriOrPath: string): LspDiagnostic[] {
    const targetVariants = uriVariants(uriOrPath);
    const merged: LspDiagnostic[] = [];

    for (const [, byUri] of this.diagnosticsByServer.entries()) {
      for (const [uri, items] of byUri.entries()) {
        if (targetVariants.some((variant) => uri.endsWith(variant))) {
          merged.push(...items);
        }
      }
    }
    return merged;
  }

  allDiagnostics(): DiagnosticsSnapshot[] {
    const snapshots: DiagnosticsSnapshot[] = [];
    for (const [, byUri] of this.diagnosticsByServer.entries()) {
      for (const [uri, items] of byUri.entries()) {
        if (items.length === 0) continue;
        snapshots.push({ uri, items });
      }
    }
    return snapshots.sort((a, b) => b.items.length - a.items.length);
  }

  async shutdownAll(): Promise<void> {
    for (const [name, client] of [...this.clients.entries()]) {
      try {
        await client.stop();
      } catch (error) {
        log.debug(`stop failed for ${name}`, error);
      }
      this.clients.delete(name);
      this.diagnosticsByServer.delete(name);
    }
  }

  statusLines(): string[] {
    if (this.clients.size === 0) return ["lsp: no servers running"];
    return [...this.clients.values()].map(
      (client) => `lsp: ${client.serverName} (${client.ready ? "running" : "dead"})`
    );
  }

  private keyForLanguage(languageId: string): string | undefined {
    const spec = this.findSpecForLanguage(languageId);
    if (!spec) return undefined;
    const key = spec.command.split(/[\\/]/).pop() ?? spec.command;
    return this.clients.has(key) ? key : undefined;
  }

  private recordDiagnostics(serverKey: string, uri: string, items: LspDiagnostic[]): void {
    let byUri = this.diagnosticsByServer.get(serverKey);
    if (!byUri) {
      byUri = new Map();
      this.diagnosticsByServer.set(serverKey, byUri);
    }
    byUri.set(uri, items);
  }

  static validateSpec(spec: LanguageServerSpec): void {
    if (spec.languages.length === 0) throw new AxiomError("LSP spec requires at least one language");
    if (spec.command.trim().length === 0) throw new AxiomError("LSP spec requires a command");
  }
}

function uriVariants(pathLike: string): string[] {
  const normalized = pathLike.replace(/\\/g, "/");
  const base = normalized.split("/").pop() ?? normalized;
  return [normalized, base];
}

function relativeToRoot(root: string, filePath: string): string {
  const normalizedRoot = root.replace(/\\/g, "/").replace(/\/$/, "");
  const normalizedFile = filePath.replace(/\\/g, "/");
  if (normalizedFile.toLowerCase().startsWith(normalizedRoot.toLowerCase())) {
    return normalizedFile.slice(normalizedRoot.length + 1);
  }
  return filePath;
}

function commandExists(command: string): boolean {
  const check = process.platform === "win32" ? "where" : "which";
  try {
    execFileSync(check, [command], { stdio: "ignore", windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
