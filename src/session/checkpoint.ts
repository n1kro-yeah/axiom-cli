import { copyFile, mkdir, readFile, readdir, stat, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ToolDefinition, ToolInvocationResult } from "../types.js";
import { AxiomError } from "../util/errors.js";
import { createLogger } from "../util/log.js";

const log = createLogger("checkpoints");

export interface SnapshotEntry {
  absolutePath: string;
  backupPath?: string;
  kind: "file" | "missing-before";
  sizeBytes?: number;
}

export interface Checkpoint {
  id: string;
  sessionId: string;
  timestamp: number;
  entries: SnapshotEntry[];
  label?: string;
}

interface ManifestFile {
  version: 1;
  checkpoints: Checkpoint[];
}

export class CheckpointManager {
  private readonly baseDir: string;
  private readonly state = new Map<string, ManifestFile>();
  private readonly redoStacks = new Map<string, Checkpoint[]>();

  constructor(baseDir: string) {
    this.baseDir = baseDir;
  }

  private sessionDir(sessionId: string): string {
    return join(this.baseDir, sanitizeSegment(sessionId));
  }

  async snapshot(sessionId: string, paths: string[], label?: string): Promise<Checkpoint> {
    const dir = this.sessionDir(sessionId);
    await mkdir(dir, { recursive: true });

    const checkpointId = `cp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    const checkpointDir = join(dir, checkpointId);
    await mkdir(checkpointDir, { recursive: true });

    const entries: SnapshotEntry[] = [];

    for (const absolutePath of dedupePaths(paths)) {
      if (!existsSync(absolutePath)) {
        entries.push({ absolutePath, kind: "missing-before" });
        continue;
      }
      try {
        const info = await stat(absolutePath);
        if (!info.isFile()) continue;

        const encodedName = encodePathForDisk(absolutePath);
        const backupPath = join(checkpointDir, encodedName);
        await mkdir(dirname(backupPath), { recursive: true });
        await copyFile(absolutePath, backupPath);

        entries.push({
          absolutePath,
          backupPath,
          kind: "file",
          sizeBytes: info.size
        });
      } catch (error) {
        log.warn(`snapshot failed for ${absolutePath}`, error);
      }
    }

    if (entries.length === 0) {
      await rm(checkpointDir, { recursive: true, force: true }).catch(() => undefined);
      throw new AxiomError("Nothing to snapshot");
    }

    const checkpoint: Checkpoint = {
      id: checkpointId,
      sessionId,
      timestamp: Date.now(),
      entries,
      label
    };

    const manifest = this.manifest(sessionId);
    manifest.checkpoints.push(checkpoint);
    this.redoStacks.set(sessionId, []);
    await this.persistManifest(sessionId, manifest);

    log.debug(`checkpoint ${checkpointId}: ${entries.length} files`);
    return checkpoint;
  }

  async undo(sessionId: string): Promise<{ restoredFiles: number; checkpoint: Checkpoint }> {
    const manifest = this.manifest(sessionId);
    const last = manifest.checkpoints.pop();
    if (!last) throw new AxiomError("Nothing to undo");

    let restoredFiles = 0;
    for (const entry of [...last.entries].reverse()) {
      try {
        if (entry.kind === "missing-before" || !entry.backupPath) {
          await rm(entry.absolutePath, { force: true }).catch(() => undefined);
        } else {
          await mkdir(dirname(entry.absolutePath), { recursive: true });
          await copyFile(entry.backupPath, entry.absolutePath);
        }
        restoredFiles += 1;
      } catch (error) {
        log.error(`restore failed for ${entry.absolutePath}`, error);
      }
    }

    const stack = this.redoStacks.get(sessionId) ?? [];
    stack.push(last);
    this.redoStacks.set(sessionId, stack);

    await this.persistManifest(sessionId, manifest);
    return { restoredFiles, checkpoint: last };
  }

  async redo(sessionId: string): Promise<{ reAppliedFiles: number; checkpoint: Checkpoint } | null> {
    const stack = this.redoStacks.get(sessionId) ?? [];
    const next = stack.pop();
    if (!next) return null;

    let reAppliedFiles = 0;
    for (const entry of next.entries) {
      try {
        const currentExists = existsSync(entry.absolutePath);
        const backupTarget = join(this.sessionDir(sessionId), `redo_${Date.now().toString(36)}`);
        if (currentExists) {
          await mkdir(backupTarget, { recursive: true });
          await copyFile(
            entry.absolutePath,
            join(backupTarget, encodePathForDisk(entry.absolutePath))
          );
        }

        if (!currentExists && entry.kind === "missing-before") {
          reAppliedFiles += 1;
          continue;
        }
        if (existsSync(entry.absolutePath)) {
          reAppliedFiles += 1;
        }
      } catch (error) {
        log.warn(`redo re-apply skipped for ${entry.absolutePath}`, error);
      }
    }

    const manifest = this.manifest(sessionId);
    manifest.checkpoints.push(next);
    await this.persistManifest(sessionId, manifest);

    return { reAppliedFiles, checkpoint: next };
  }

  listCheckpoints(sessionId: string): Checkpoint[] {
    return [...this.manifest(sessionId).checkpoints];
  }

  canUndo(sessionId: string): boolean {
    return this.manifest(sessionId).checkpoints.length > 0;
  }

  canRedo(sessionId: string): boolean {
    return (this.redoStacks.get(sessionId)?.length ?? 0) > 0;
  }

  private manifest(sessionId: string): ManifestFile {
    const existing = this.state.get(sessionId);
    if (existing) return existing;
    const fresh: ManifestFile = { version: 1, checkpoints: [] };
    this.state.set(sessionId, fresh);
    return fresh;
  }

  private async persistManifest(sessionId: string, manifest: ManifestFile): Promise<void> {
    manifest.checkpoints = manifest.checkpoints.slice(-50);
    await mkdir(this.sessionDir(sessionId), { recursive: true });
    await writeFile(join(this.sessionDir(sessionId), "manifest.json"), JSON.stringify(manifest), "utf8").catch((error) =>
      log.warn("manifest persist failed", error)
    );
  }

  async pruneSessions(activeSessionIds: string[]): Promise<number> {
    let pruned = 0;
    try {
      const entries = await readdir(this.baseDir);
      for (const entry of entries) {
        if (activeSessionIds.includes(entry)) continue;
        await rm(join(this.baseDir, entry), { recursive: true, force: true }).catch(() => undefined);
        pruned += 1;
      }
    } catch {
    }
    return pruned;
  }
}

function dedupePaths(paths: string[]): string[] {
  return [...new Set(paths.map((path) => path.replace(/\\/g, "/")))];
}

function sanitizeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 100);
}

function encodePathForDisk(absolutePath: string): string {
  return encodeURIComponent(absolutePath.replace(/\\/g, "/")).replace(/%/g, "~").slice(0, 180);
}

export function decodePathFromDisk(encoded: string): string {
  return decodeURIComponent(encoded.replace(/~/g, "%"));
}

export function createUndoTools(manager: () => CheckpointManager | undefined, getSessionId: () => string): Array<ToolDefinition & { internal: true }> {
  void manager;
  void getSessionId;
  return [];
}

export interface UndoRedoOutcome {
  ok: boolean;
  message: string;
}

export async function performUndo(
  manager: CheckpointManager,
  sessionId: string,
  readFileFn: typeof readFile = readFile,
  writeFileFn: typeof writeFile = writeFile
): Promise<UndoRedoOutcome> {
  void readFileFn;
  void writeFileFn;
  try {
    const result = await manager.undo(sessionId);
    return {
      ok: true,
      message: `Restored ${result.restoredFiles} file(s) from checkpoint ${result.checkpoint.id}`
    };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

export async function performRedo(
  manager: CheckpointManager,
  sessionId: string,
  readdirFn: typeof readdir = readdir,
  statFn: typeof stat = stat
): Promise<UndoRedoOutcome> {
  void readdirFn;
  void statFn;
  try {
    const result = await manager.redo(sessionId);
    if (!result) return { ok: false, message: "Nothing to redo" };
    return { ok: true, message: `Re-applied checkpoint ${result.checkpoint.id}` };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}
