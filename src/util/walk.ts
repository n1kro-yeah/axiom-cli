import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { globToRegExp } from "./fuzzy.js";

const DEFAULT_IGNORES = [
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  "__pycache__",
  ".venv",
  "venv",
  "dist",
  "build",
  "out",
  "target",
  ".next",
  ".nuxt",
  ".cache",
  ".parcel-cache",
  "coverage",
  ".idea",
  ".vs",
  "*.pyc",
  "*.class",
  "*.jar",
  "*.dll",
  "*.exe",
  "*.so",
  "*.dylib",
  "*.bin",
  "*.lock",
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "Cargo.lock",
  "poetry.lock"
];

interface IgnoreRule {
  regex: RegExp;
  dirOnly: boolean;
  negated: boolean;
  anchored: boolean;
  raw: string;
}

export class IgnoreStack {
  private readonly rules: IgnoreRule[] = [];
  private readonly rootDir: string;

  constructor(rootDir: string) {
    this.rootDir = rootDir.replace(/\\/g, "/");
  }

  addPatterns(rawLines: string[], baseDir?: string): void {
    const normalizedBase = (baseDir ?? this.rootDir).replace(/\\/g, "/");
    for (const rawLine of rawLines) {
      const rule = parseIgnoreLine(rawLine, normalizedBase);
      if (rule) this.rules.push(rule);
    }
  }

  addDefaults(): void {
    this.addPatterns(DEFAULT_IGNORES);
  }

  isIgnored(relativePath: string, isDirectory: boolean): boolean {
    const normalized = relativePath.replace(/\\/g, "/");
    let ignored = false;
    for (const rule of this.rules) {
      if (rule.dirOnly && !isDirectory) continue;
      const testPath = normalized.endsWith("/") ? normalized : normalized;
      if (rule.regex.test(testPath)) {
        ignored = !rule.negated;
      }
    }
    return ignored;
  }

  get size(): number {
    return this.rules.length;
  }
}

function parseIgnoreLine(rawLine: string, baseDir: string): IgnoreRule | null {
  let line = rawLine;
  if (line.endsWith("\r")) line = line.slice(0, -1);
  line = line.trim();
  if (line.length === 0) return null;
  if (line.startsWith("#")) return null;

  let negated = false;
  if (line.startsWith("!")) {
    negated = true;
    line = line.slice(1);
  }

  let dirOnly = false;
  if (line.endsWith("/")) {
    dirOnly = true;
    line = line.slice(0, -1);
  }

  let anchored = false;
  if (line.startsWith("/")) {
    anchored = true;
    line = line.slice(1);
  } else if (line.includes("/")) {
    anchored = true;
  }

  if (line.length === 0) return null;

  let source = "";
  let index = 0;
  while (index < line.length) {
    const char = line[index];
    if (char === "*") {
      if (line[index + 1] === "*") {
        if (line[index + 2] === "/") {
          source += "(?:.*/)?";
          index += 3;
          continue;
        }
        source += ".*";
        index += 2;
        continue;
      }
      source += "[^/]*";
      index += 1;
      continue;
    }
    if (char === "?") {
      source += "[^/]";
      index += 1;
      continue;
    }
    if (char === "[") {
      const closing = line.indexOf("]", index);
      if (closing !== -1) {
        const body = line.slice(index + 1, closing).replace(/^!/, "^");
        source += `[${body}]`;
        index = closing + 1;
        continue;
      }
    }
    if ("\\^$.|+(){}[]".includes(char)) {
      source += `\\${char}`;
      index += 1;
      continue;
    }
    source += char;
    index += 1;
  }

  const escapedBase = baseDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const fullSource = anchored
    ? `^${escapedBase}/${source}(?:/.*)?$`
    : `^(?:.*/)?${source}(?:/.*)?$`;

  try {
    return { regex: new RegExp(fullSource), dirOnly, negated, anchored, raw: rawLine };
  } catch {
    return null;
  }
}

export interface WalkOptions {
  respectGitIgnore?: boolean;
  includeHidden?: boolean;
  maxDepth?: number;
  maxEntries?: number;
  extraIgnores?: string[];
  followSymlinks?: boolean;
}

export interface WalkResult {
  files: string[];
  directories: string[];
  truncated: boolean;
  visitedCount: number;
}

export async function walkFiles(rootDir: string, options: WalkOptions = {}): Promise<WalkResult> {
  const respectGitIgnore = options.respectGitIgnore ?? true;
  const maxDepth = options.maxDepth ?? 24;
  const maxEntries = options.maxEntries ?? 20000;

  const stack = new IgnoreStack(rootDir);
  stack.addDefaults();
  if (options.extraIgnores?.length) stack.addPatterns(options.extraIgnores);

  const files: string[] = [];
  const directories: string[] = [];
  let truncated = false;
  let visitedCount = 0;

  const absoluteRoot = resolve(rootDir);

  async function loadIgnoreFile(dir: string): Promise<void> {
    const candidates = [join(dir, ".gitignore"), join(dir, ".axiomignore")];
    for (const candidate of candidates) {
      try {
        const content = await readFile(candidate, "utf8");
        stack.addPatterns(content.split("\n"), dir);
      } catch {
      }
    }
  }

  await loadIgnoreFile(absoluteRoot);

  async function visit(dir: string, depth: number): Promise<void> {
    if (depth > maxDepth) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      if (files.length + directories.length >= maxEntries) {
        truncated = true;
        return;
      }
      if (entry.name.startsWith(".") && entry.name !== "." && entry.name !== ".." && !options.includeHidden) {
        if (entry.isDirectory() && DEFAULT_IGNORES.includes(entry.name)) continue;
        if (entry.isFile()) continue;
        if (entry.isDirectory()) continue;
      }

      const absoluteEntry = join(dir, entry.name);
      const relativeEntry = relative(absoluteRoot, absoluteEntry);
      const isDirectory = entry.isDirectory();

      if (respectGitIgnore && stack.isIgnored(relativeEntry, isDirectory)) continue;

      visitedCount += 1;

      if (entry.isSymbolicLink() && !options.followSymlinks) continue;

      if (isDirectory) {
        directories.push(relativeEntry.split("\\").join("/"));
        await loadIgnoreFile(absoluteEntry);
        await visit(absoluteEntry, depth + 1);
      } else if (entry.isFile()) {
        files.push(relativeEntry.split("\\").join("/"));
      }
    }
  }

  await visit(absoluteRoot, 0);

  return {
    files,
    directories,
    truncated,
    visitedCount
  };
}

const BINARY_SNIFF_BYTES = 8000;

export async function looksBinary(filePath: string): Promise<boolean> {
  try {
    const info = await stat(filePath);
    if (info.size === 0) return false;
    const handle = await import("node:fs/promises").then((fs) => fs.open(filePath, "r"));
    try {
      const length = Math.min(info.size, BINARY_SNIFF_BYTES);
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, 0);
      let suspicious = 0;
      for (let i = 0; i < length; i += 1) {
        const byte = buffer[i];
        if (byte === 0) return true;
        if (byte < 7 || (byte > 13 && byte < 32)) suspicious += 1;
      }
      return suspicious / Math.max(length, 1) > 0.15;
    } finally {
      await handle.close();
    }
  } catch {
    return false;
  }
}

const EXTENSION_LANGUAGES: Record<string, string[]> = {
  ".ts": ["typescript", "vtsls", "tsserver"],
  ".tsx": ["typescript"],
  ".js": ["javascript", "typescript", "vtsls"],
  ".jsx": ["javascript", "typescript"],
  ".mjs": ["javascript"],
  ".cjs": ["javascript"],
  ".mts": ["typescript"],
  ".cts": ["typescript"],
  ".py": ["python", "pyright", "jedi"],
  ".rs": ["rust", "rust-analyzer"],
  ".go": ["go", "gopls"],
  ".rb": ["ruby", "solargraph"],
  ".java": ["java", "jdtls"],
  ".kt": ["kotlin"],
  ".cs": ["csharp", "omnisharp"],
  ".c": ["c", "clangd"],
  ".h": ["c", "clangd"],
  ".cpp": ["cpp", "clangd"],
  ".hpp": ["cpp", "clangd"],
  ".cc": ["cpp", "clangd"],
  ".php": ["php", "intelephense"],
  ".lua": ["lua", "lua-language-server"],
  ".zig": ["zig", "zls"],
  ".swift": ["swift", "sourcekit-lsp"],
  ".json": ["json", "vscode-json-languageserver"],
  ".yaml": ["yaml"],
  ".yml": ["yaml"],
  ".md": ["markdown"]
};

export function detectLanguagesFromExtension(filePath: string): string[] {
  const dotIndex = filePath.lastIndexOf(".");
  if (dotIndex === -1) return [];
  const extension = filePath.slice(dotIndex).toLowerCase();
  return EXTENSION_LANGUAGES[extension] ?? [];
}

export function countFilesUnder(files: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const file of files) {
    const top = file.includes("/") ? file.slice(0, file.indexOf("/")) : ".";
    counts.set(top, (counts.get(top) ?? 0) + 1);
  }
  return counts;
}

export { globToRegExp };
