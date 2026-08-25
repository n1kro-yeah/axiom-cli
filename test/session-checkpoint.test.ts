import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CheckpointManager } from "../src/session/checkpoint.js";
import { SessionStore } from "../src/session/store.js";
import { createMessageId } from "../src/types.js";

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "axiom-test-"));
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

describe("SessionStore", () => {
  it("creates a session with meta and empty jsonl", async () => {
    const store = new SessionStore(join(workDir, "sessions"));
    const meta = await store.create({ projectRoot: workDir, provider: "anthropic", model: "claude" });

    expect(meta.id.startsWith("ses_")).toBe(true);
    expect(meta.title).toBe("New session");
    expect(existsSync(store.sessionPath(meta.id))).toBe(true);
    expect(await store.loadMeta(meta.id)).toBeDefined();
  });

  it("appends and reloads messages preserving order", async () => {
    const store = new SessionStore(join(workDir, "sessions"));
    const meta = await store.create({ projectRoot: workDir, provider: "p", model: "m" });

    for (const role of ["user", "assistant", "user", "assistant"] as const) {
      await store.appendMessage(meta.id, {
        id: createMessageId(),
        role,
        parts: [{ type: "text", text: `hello ${role}` }],
        timestamp: Date.now()
      });
    }

    const messages = await store.loadMessages(meta.id);
    expect(messages).toHaveLength(4);
    expect(messages[0].role).toBe("user");
    expect(messages[3].parts[0].type === "text" && messages[3].parts[0].text).toContain("assistant");
  });

  it("skips corrupted lines instead of failing the whole file", async () => {
    const store = new SessionStore(join(workDir, "sessions"));
    const meta = await store.create({ projectRoot: workDir, provider: "p", model: "m" });

    const good = JSON.stringify({ t: "m", m: { id: "x1", role: "user", parts: [], timestamp: 1 } });
    const { appendFileSync } = await import("node:fs");
    appendFileSync(store.sessionPath(meta.id), `${good}\n{ broken json\n${good}\n`, "utf8");

    const messages = await store.loadMessages(meta.id);
    expect(messages).toHaveLength(2);
  });

  it("lists sessions newest first and renames titles", async () => {
    const store = new SessionStore(join(workDir, "sessions"));
    const first = await store.create({ projectRoot: workDir, provider: "p", model: "m" });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await store.create({ projectRoot: workDir, provider: "p", model: "m" });

    const listed = await store.listSessions();
    expect(listed[0].id).toBe(second.id);

    expect(await store.renameSession(first.id, "renamed title")).toBe(true);
    expect((await store.loadMeta(first.id))?.title).toBe("renamed title");
  });

  it("finds latest session per project root across platforms", async () => {
    const store = new SessionStore(join(workDir, "sessions"));
    await store.create({ projectRoot: "C:\\other\\proj", provider: "p", model: "m" });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const mine = await store.create({ projectRoot: workDir, provider: "p", model: "m" });

    const latest = await store.latestForProject(workDir.replace(/\\/g, "/"));
    expect(latest?.id).toBe(mine.id);
  });

  it("exports markdown containing roles and tool traces", async () => {
    const store = new SessionStore(join(workDir, "sessions"));
    const meta = await store.create({ projectRoot: workDir, provider: "anthropic", model: "claude" });

    await store.appendMessage(meta.id, {
      id: createMessageId(),
      role: "user",
      parts: [{ type: "text", text: "**do** something" }],
      timestamp: Date.now()
    });
    await store.appendMessage(meta.id, {
      id: createMessageId(),
      role: "assistant",
      parts: [
        { type: "tool_call", id: "c1", name: "bash", input: { command: "ls" }, rawArgs: "{}" },
        { type: "tool_result", toolCallId: "c1", name: "bash", content: "file.txt", isError: false }
      ],
      timestamp: Date.now(),
      stopReason: "end_turn"
    });

    const outPath = join(workDir, "export.md");
    const written = await store.exportMarkdown(meta.id, outPath);
    const content = await readFile(written, "utf8");

    expect(content).toContain("## User");
    expect(content).toContain("## Assistant");
    expect(content).toContain("→ bash");
  });

  it("deletes sessions including sidecar files", async () => {
    const store = new SessionStore(join(workDir, "sessions"));
    const meta = await store.create({ projectRoot: workDir, provider: "p", model: "m" });
    expect(await store.deleteSession(meta.id)).toBe(true);
    expect(existsSync(store.sessionPath(meta.id))).toBe(false);
    expect(await store.loadMeta(meta.id)).toBeUndefined();
  });
});

describe("CheckpointManager", () => {
  it("snapshots files before edits and restores them on undo", async () => {
    const manager = new CheckpointManager(join(workDir, "checkpoints"));
    const target = join(workDir, "code.txt");

    await writeFile(target, "version-1", "utf8");
    await manager.snapshot("sesA", [target]);

    await writeFile(target, "version-2-broken", "utf8");
    expect(await readFile(target, "utf8")).toBe("version-2-broken");

    const undo = await manager.undo("sesA");
    expect(undo.restoredFiles).toBe(1);
    expect(await readFile(target, "utf8")).toBe("version-1");
  });

  it("removes files that did not exist before the checkpoint", async () => {
    const manager = new CheckpointManager(join(workDir, "checkpoints"));
    const created = join(workDir, "created-later.txt");

    await manager.snapshot("sesB", [created]);
    await writeFile(created, "temporary", "utf8");

    await manager.undo("sesB");
    expect(existsSync(created)).toBe(false);
  });

  it("supports redo after undo", async () => {
    const manager = new CheckpointManager(join(workDir, "checkpoints"));
    const target = join(workDir, "redo.txt");

    await writeFile(target, "original", "utf8");
    await manager.snapshot("sesC", [target]);
    await writeFile(target, "changed", "utf8");

    expect(manager.canRedo("sesC")).toBe(false);
    await manager.undo("sesC");
    expect(manager.canRedo("sesC")).toBe(true);

    const redo = await manager.redo("sesC");
    expect(redo).not.toBeNull();
    expect(redo!.checkpoint.id.length).toBeGreaterThan(4);
  });

  it("throws a clear error when there is nothing to undo", async () => {
    const manager = new CheckpointManager(join(workDir, "checkpoints"));
    await expect(manager.undo("ses-empty")).rejects.toThrow(/Nothing to undo/);
  });

  it("prunes checkpoints of inactive sessions", async () => {
    const base = join(workDir, "checkpoints");
    const manager = new CheckpointManager(base);
    const dir = join(base, "ses-old");
    await mkdir(dir, { recursive: true });
    await manager.pruneSessions(["ses-new"]);
    expect(existsSync(dir)).toBe(false);
  });
});
