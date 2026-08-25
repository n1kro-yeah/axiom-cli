import { appendFile, mkdir, stat, rename, readdir, unlink } from "node:fs/promises";
import { join, dirname } from "node:path";

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_WEIGHT: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40
};

const LEVEL_TAG: Record<LogLevel, string> = {
  debug: "DBG",
  info: "INF",
  warn: "WRN",
  error: "ERR"
};

export interface LogSink {
  write(level: LogLevel, scope: string, message: string, data?: unknown): void;
}

export class MemoryRingSink implements LogSink {
  private readonly entries: string[] = [];
  private readonly capacity: number;

  constructor(capacity = 2000) {
    this.capacity = capacity;
  }

  write(level: LogLevel, scope: string, message: string, data?: unknown): void {
    const rendered = formatEntry(new Date(), level, scope, message, data);
    this.entries.push(rendered);
    if (this.entries.length > this.capacity) {
      this.entries.splice(0, this.entries.length - this.capacity);
    }
  }

  dump(): string[] {
    return [...this.entries];
  }

  recent(count: number): string[] {
    return this.entries.slice(-count);
  }

  clear(): void {
    this.entries.length = 0;
  }
}

export class FileSink implements LogSink {
  private readonly filePath: string;
  private readonly maxBytes: number;
  private readonly keepRotations: number;
  private currentSize = 0;
  private initialized = false;
  private queue: Promise<void> = Promise.resolve();

  constructor(filePath: string, maxBytes = 8 * 1024 * 1024, keepRotations = 3) {
    this.filePath = filePath;
    this.maxBytes = maxBytes;
    this.keepRotations = keepRotations;
  }

  async init(): Promise<void> {
    if (this.initialized) return;
    await mkdir(dirname(this.filePath), { recursive: true });
    try {
      const info = await stat(this.filePath);
      this.currentSize = info.size;
    } catch {
      this.currentSize = 0;
    }
    this.initialized = true;
  }

  write(level: LogLevel, scope: string, message: string, data?: unknown): void {
    const rendered = formatEntry(new Date(), level, scope, message, data);
    this.queue = this.queue.then(() => this.appendWithRotation(rendered)).catch(() => undefined);
  }

  private async appendWithRotation(line: string): Promise<void> {
    const payload = `${line}\n`;
    if (this.currentSize + Buffer.byteLength(payload) > this.maxBytes) {
      await this.rotate();
    }
    await mkdir(dirname(this.filePath), { recursive: true });
    await appendFile(this.filePath, payload, "utf8");
    this.currentSize += Buffer.byteLength(payload);
  }

  private async rotate(): Promise<void> {
    try {
      const siblings = await readdir(dirname(this.filePath)).catch(() => [] as string[]);
      const base = basename(this.filePath);
      const rotations = siblings
        .filter((name) => name.startsWith(`${base}.`))
        .map((name) => {
          const suffix = name.slice(base.length + 1);
          const index = Number.parseInt(suffix, 10);
          return { name, index: Number.isFinite(index) ? index : 0 };
        })
        .sort((a, b) => b.index - a.index);

      for (const rotation of rotations) {
        if (rotation.index >= this.keepRotations) {
          await unlink(join(dirname(this.filePath), rotation.name)).catch(() => undefined);
        }
      }
      for (let index = rotations.length; index >= 1; index -= 1) {
        const source = join(dirname(this.filePath), rotations[index - 1]?.name ?? "");
        const target = join(dirname(this.filePath), `${base}.${index}`);
        if (source) await rename(source, target).catch(() => undefined);
      }
      await rename(this.filePath, join(dirname(this.filePath), `${base}.1`)).catch(() => undefined);
      this.currentSize = 0;
    } catch {
      this.currentSize = 0;
    }
  }
}

class NullSink implements LogSink {
  write(): void {}
}

interface LoggerState {
  level: LogLevel;
  sinks: LogSink[];
}

const globalState: LoggerState = {
  level: process.env.AXIOM_LOG_LEVEL === "debug" ? "debug" : "info",
  sinks: [new MemoryRingSink()]
};

export function configureLogging(options: { level?: LogLevel; sinks?: LogSink[] }): void {
  if (options.level) globalState.level = options.level;
  if (options.sinks) globalState.sinks = options.sinks;
}

export function addLogSink(sink: LogSink): void {
  if (!globalState.sinks.some((existing) => existing === sink)) {
    globalState.sinks.push(sink);
  }
}

export function memoryLog(): MemoryRingSink {
  const found = globalState.sinks.find((sink): sink is MemoryRingSink => sink instanceof MemoryRingSink);
  if (found) return found;
  const created = new MemoryRingSink();
  globalState.sinks.push(created);
  return created;
}

export interface Logger {
  debug(message: string, data?: unknown): void;
  info(message: string, data?: unknown): void;
  warn(message: string, data?: unknown): void;
  error(message: string, data?: unknown): void;
  child(scope: string): Logger;
  readonly scope: string;
}

export function createLogger(scope: string): Logger {
  return {
    scope,
    debug(message, data) {
      emit("debug", scope, message, data);
    },
    info(message, data) {
      emit("info", scope, message, data);
    },
    warn(message, data) {
      emit("warn", scope, message, data);
    },
    error(message, data) {
      emit("error", scope, message, data);
    },
    child(sub) {
      return createLogger(`${scope}:${sub}`);
    }
  };
}

const nullLogger: Logger = (() => {
  const sink = new NullSink();
  configureLogging({ sinks: globalState.sinks });
  return {
    scope: "null",
    debug() {},
    info() {},
    warn() {},
    error() {},
    child() {
      return nullLogger;
    }
  };
})();

export function silentLogger(): Logger {
  return nullLogger;
}

function emit(level: LogLevel, scope: string, message: string, data?: unknown): void {
  if (LEVEL_WEIGHT[level] < LEVEL_WEIGHT[globalState.level]) return;
  for (const sink of globalState.sinks) {
    try {
      sink.write(level, scope, message, data);
    } catch {
    }
  }
}

function formatEntry(timestamp: Date, level: LogLevel, scope: string, message: string, data?: unknown): string {
  const iso = timestamp.toISOString().padEnd(24);
  const tag = LEVEL_TAG[level].padEnd(3);
  const scopeTag = scope.padEnd(18).slice(0, 18);
  if (data === undefined) {
    return `${iso} ${tag} ${scopeTag} ${message}`;
  }
  let serialized: string;
  if (data instanceof Error) {
    serialized = `${data.message}${data.stack ? ` :: ${data.stack.split("\n").slice(0, 4).join(" | ")}` : ""}`;
  } else if (typeof data === "string") {
    serialized = data;
  } else {
    try {
      serialized = JSON.stringify(data);
    } catch {
      serialized = String(data);
    }
  }
  if (serialized.length > 4000) serialized = `${serialized.slice(0, 4000)}…`;
  return `${iso} ${tag} ${scopeTag} ${message}${serialized ? ` ${serialized}` : ""}`;
}

export function basename(filePath: string): string {
  const normalized = filePath.replace(/[\\/]+$/, "");
  const index = Math.max(normalized.lastIndexOf("\\"), normalized.lastIndexOf("/"));
  return index === -1 ? normalized : normalized.slice(index + 1);
}
