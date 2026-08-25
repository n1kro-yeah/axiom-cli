import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ChatMessage, SessionMeta, Usage } from "../types.js";
import { emptyUsage } from "../types.js";
import { AxiomError } from "../util/errors.js";
import { createLogger } from "../util/log.js";

const log = createLogger("sessions");

interface MetaFile {
  version: 1;
  meta: SessionMeta;
}

const META_SUFFIX = ".meta.json";
const SESSION_SUFFIX = ".jsonl";

export class SessionStore {
  private readonly sessionsDir: string;
  private cache: Map<string, MetaFile> = new Map();

  constructor(sessionsDir: string) {
    this.sessionsDir = sessionsDir;
  }

  async ensureDir(): Promise<void> {
    await mkdir(this.sessionsDir, { recursive: true });
  }

  createId(): string {
    const timestamp = Date.now().toString(36);
    const random = Math.random().toString(36).slice(2, 8);
    return `ses_${timestamp}_${random}`;
  }

  sessionPath(id: string): string {
    return join(this.sessionsDir, `${id}${SESSION_SUFFIX}`);
  }

  metaPath(id: string): string {
    return join(this.sessionsDir, `${id}${META_SUFFIX}`);
  }

  async create(initial: {
    projectRoot: string;
    provider: string;
    model: string;
    title?: string;
  }): Promise<SessionMeta> {
    await this.ensureDir();
    const now = Date.now();
    const meta: SessionMeta = {
      id: this.createId(),
      title: initial.title?.trim() || "New session",
      createdAt: now,
      updatedAt: now,
      projectRoot: initial.projectRoot,
      model: initial.model,
      provider: initial.provider,
      messageCount: 0,
      totalCostUSD: 0,
      totalUsage: emptyUsage()
    };
    await writeFile(this.sessionPath(meta.id), "", "utf8");
    await this.persistMeta({ version: 1, meta });
    log.info(`session created ${meta.id}`);
    return meta;
  }

  private async persistMeta(file: MetaFile): Promise<void> {
    this.cache.set(file.meta.id, file);
    await writeFile(this.metaPath(file.meta.id), JSON.stringify(file, null, 2), "utf8");
  }

  async loadMeta(id: string): Promise<SessionMeta | undefined> {
    const cached = this.cache.get(id);
    if (cached) return cached.meta;
    try {
      const text = await readFile(this.metaPath(id), "utf8");
      const parsed = JSON.parse(text) as MetaFile;
      if (parsed.version !== 1 || !parsed.meta?.id) return undefined;
      this.cache.set(id, parsed);
      return parsed.meta;
    } catch {
      return undefined;
    }
  }

  async updateMeta(
    id: string,
    mutate: (draft: SessionMeta) => void
  ): Promise<SessionMeta | undefined> {
    const current = await this.loadMeta(id);
    if (!current) return undefined;
    const draft: SessionMeta = structuredClone(current);
    mutate(draft);
    draft.updatedAt = Date.now();
    await this.persistMeta({ version: 1, meta: draft });
    return draft;
  }

  async appendMessage(sessionId: string, message: ChatMessage): Promise<void> {
    const line = JSON.stringify({ t: "m", m: message });
    const { appendFileSync } = await import("node:fs");
    try {
      appendFileSync(this.sessionPath(sessionId), `${line}\n`, "utf8");
    } catch (error) {
      throw new AxiomError(`Failed to persist message into ${sessionId}`, { cause: error });
    }
  }

  async loadMessages(sessionId: string): Promise<ChatMessage[]> {
    let text: string;
    try {
      text = await readFile(this.sessionPath(sessionId), "utf8");
    } catch {
      return [];
    }

    const messages: ChatMessage[] = [];
    for (const [index, line] of text.split("\n").entries()) {
      if (line.trim().length === 0) continue;
      try {
        const parsed = JSON.parse(line) as { t?: string; m?: ChatMessage };
        if (parsed.t === "m" && parsed.m && typeof parsed.m.role === "string" && Array.isArray(parsed.m.parts)) {
          messages.push(parsed.m);
        }
      } catch (error) {
        log.warn(`skipping malformed line ${index + 1} in ${sessionId}`, error);
      }
    }
    return messages;
  }

  async recordTurnEnd(
    sessionId: string,
    addedMessages: number,
    usageDelta: Usage,
    costDelta: number
  ): Promise<void> {
    await this.updateMeta(sessionId, (draft) => {
      draft.messageCount += addedMessages;
      draft.totalCostUSD = Number((draft.totalCostUSD + costDelta).toFixed(6));
      draft.totalUsage.inputTokens += usageDelta.inputTokens;
      draft.totalUsage.outputTokens += usageDelta.outputTokens;
      draft.totalUsage.cacheReadTokens += usageDelta.cacheReadTokens;
      draft.totalUsage.cacheWriteTokens += usageDelta.cacheWriteTokens;
      draft.totalUsage.reasoningTokens += usageDelta.reasoningTokens;
    });
  }

  async listSessions(): Promise<SessionMeta[]> {
    await this.ensureDir();
    let entries: string[] = [];
    try {
      entries = await readdir(this.sessionsDir);
    } catch {
      return [];
    }

    const metas: SessionMeta[] = [];
    for (const entry of entries) {
      if (!entry.endsWith(META_SUFFIX)) continue;
      const id = entry.slice(0, -META_SUFFIX.length);
      const meta = await this.loadMeta(id);
      if (meta) metas.push(meta);
    }

    metas.sort((a, b) => b.updatedAt - a.updatedAt);
    return metas;
  }

  async latestForProject(projectRoot: string): Promise<SessionMeta | undefined> {
    const normalizedTarget = normalizePath(projectRoot);
    const all = await this.listSessions();
    return all.find((meta) => normalizePath(meta.projectRoot) === normalizedTarget);
  }

  async deleteSession(id: string): Promise<boolean> {
    const sessionFile = this.sessionPath(id);
    const metaFile = this.metaPath(id);
    let deleted = false;

    if (existsSync(sessionFile)) {
      await unlink(sessionFile).catch(() => undefined);
      deleted = true;
    }
    if (existsSync(metaFile)) {
      await unlink(metaFile).catch(() => undefined);
      deleted = true;
    }
    this.cache.delete(id);

    const checkpointDir = join(this.checkpointsBase(), id);
    if (existsSync(checkpointDir)) {
      await removeRecursive(checkpointDir).catch(() => undefined);
    }

    return deleted;
  }

  checkpointsBase(): string {
    return join(this.sessionsDir, "..", "checkpoints");
  }

  async renameSession(id: string, title: string): Promise<boolean> {
    const cleaned = title.trim().slice(0, 80);
    if (cleaned.length === 0) return false;
    const updated = await this.updateMeta(id, (draft) => {
      draft.title = cleaned;
    });
    return updated !== undefined;
  }

  async setSessionModel(id: string, provider: string, model: string): Promise<void> {
    await this.updateMeta(id, (draft) => {
      draft.provider = provider;
      draft.model = model;
    });
  }

  async exportMarkdown(id: string, outputPath: string): Promise<string> {
    const meta = await this.loadMeta(id);
    const messages = await this.loadMessages(id);
    const lines: string[] = [];

    lines.push(`# Axiom session — ${meta?.title ?? id}`);
    lines.push("");
    lines.push(`- ID: \`${id}\``);
    lines.push(`- Project: \`${meta?.projectRoot ?? "?"}\``);
    lines.push(`- Model: \`${meta?.provider ?? "?"}/${meta?.model ?? "?"}\``);
    if (meta) {
      lines.push(`- Created: ${new Date(meta.createdAt).toISOString()}`);
      lines.push(`- Messages: ${messages.length}, cost: $${meta.totalCostUSD.toFixed(4)}`);
    }
    lines.push("");

    for (const message of messages) {
      const roleLabel = message.role === "user" ? "## User" : "## Assistant";
      lines.push(roleLabel);
      lines.push("");
      for (const part of message.parts) {
        switch (part.type) {
          case "text":
            lines.push(part.text);
            break;
          case "tool_call":
            lines.push(`\`\`\`\n→ ${part.name} ${JSON.stringify(part.input).slice(0, 600)}\n\`\`\``);
            break;
          case "tool_result":
            lines.push(`\`\`\`\n[${part.name}] ${part.isError ? "ERROR" : "ok"}\n${part.content.slice(0, 2000)}\n\`\`\``);
            break;
          default:
            break;
        }
        lines.push("");
      }
    }

    const target = outputPath.endsWith(".md") ? outputPath : `${outputPath}.md`;
    await writeFile(target, lines.join("\n"), "utf8");
    return target;
  }

  async totalDiskUsage(): Promise<number> {
    let total = 0;
    try {
      const entries = await readdir(this.sessionsDir);
      for (const entry of entries) {
        const info = await stat(join(this.sessionsDir, entry)).catch(() => undefined);
        if (info?.isFile()) total += info.size;
      }
    } catch {
    }
    return total;
  }

  async vacuumOldSessions(keepCount: number): Promise<number> {
    const sessions = await this.listSessions();
    if (sessions.length <= keepCount) return 0;
    const toDelete = sessions.slice(keepCount);
    let removed = 0;
    for (const session of toDelete) {
      if (await this.deleteSession(session.id)) removed += 1;
    }
    return removed;
  }
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

async function removeRecursive(dir: string): Promise<void> {
  const { rm } = await import("node:fs/promises");
  await rm(dir, { recursive: true, force: true });
}

export async function rotateTempFiles(directory: string, keep = 5): Promise<void> {
  try {
    const entries = await readdir(directory);
    const tempFiles = entries.filter((entry) => entry.endsWith(".tmp")).sort();
    const excess = tempFiles.length - keep;
    for (let i = 0; i < Math.max(excess, 0); i += 1) {
      const target = tempFiles[i];
      if (target) await unlink(join(directory, target)).catch(() => undefined);
    }
  } catch {
  }
}

export { rename as renameFile };
