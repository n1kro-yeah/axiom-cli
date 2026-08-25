import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";
import type {
  ChatMessage,
  ModelInfo,
  PermissionMode,
  SkillEntry,
  StreamRequest,
  TodoItem,
  ProviderToolSpec
} from "../types.js";
import { buildSystemBlocks } from "./prompt.js";

export interface ContextBuildInput {
  messages: ChatMessage[];
  cwd: string;
  mode: PermissionMode;
  agentName: string;
  skills: SkillEntry[];
  subagentProfiles: Array<{ name: string; description: string }>;
  rulesText: string;
  language: "en" | "ru";
  todos: TodoItem[];
  mcpServerNames: string[];
  tools: ProviderToolSpec[];
  model: ModelInfo;
  maxTokens: number;
  thinkingBudgetTokens?: number;
  temperature?: number;
  extraAddendum?: string;
  systemPrefix?: string;
}

export interface BuiltContext {
  request: StreamRequest;
  systemText: string;
}

export function buildContext(input: ContextBuildInput): BuiltContext {
  const blocks = buildSystemBlocks({
    cwd: input.cwd,
    platform: `${process.platform}`,
    isGitRepo: detectGitRepo(input.cwd).isRepo,
    gitBranch: detectGitRepo(input.cwd).branch,
    mode: input.mode,
    agentName: input.agentName,
    skills: input.skills,
    subagents: input.subagentProfiles.map((profile) => ({
      name: profile.name,
      description: profile.description
    })),
    rulesText: input.rulesText,
    language: input.language,
    todoItems: input.todos.map((todo) => ({ id: todo.id, content: todo.content, status: todo.status })),
    mcpServerNames: input.mcpServerNames,
    extraAddendum: input.extraAddendum
  });

  const prefixedBlocks = input.systemPrefix
    ? [{ text: input.systemPrefix, cache: false }, ...blocks]
    : blocks;

  const systemText = prefixedBlocks.map((block) => block.text).join("\n\n");

  const request: StreamRequest = {
    model: input.model.id,
    system: prefixedBlocks,
    messages: sanitizeMessagesForProvider(input.messages, input.model),
    tools: input.tools.filter(() => input.model.supportsTools),
    maxTokens: Math.min(input.maxTokens, input.model.maxOutputTokens),
    temperature: input.temperature,
    thinkingBudgetTokens:
      input.thinkingBudgetTokens && input.thinkingBudgetTokens > 0 && input.model.supportsThinking
        ? input.thinkingBudgetTokens
        : undefined
  };

  return { request, systemText };
}

export interface GitInfo {
  isRepo: boolean;
  branch?: string;
  rootDir?: string;
}

export function detectGitRepo(cwd: string): GitInfo {
  let dir = cwd;
  for (let depth = 0; depth < 8; depth += 1) {
    const gitDir = join(dir, ".git");
    if (existsSync(gitDir)) {
      let branch: string | undefined;
      try {
        const head = readFileSync(join(gitDir, "HEAD"), "utf8").trim();
        const match = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
        branch = match?.[1];
      } catch {
        try {
          const head = readFileSync(gitDir, "utf8");
          const match = /gitdir:\s*(.+)$/.exec(head);
          if (match) {
            const worktreeHead = readFileSync(match[1].trim() + "/HEAD", "utf8").trim();
            branch = /^ref:\s*refs\/heads\/(.+)$/.exec(worktreeHead)?.[1];
          }
        } catch {
        }
      }
      return { isRepo: true, branch, rootDir: dir };
    }
    const parent = join(dir, "..");
    if (parent === dir || depth > 6) break;
    dir = parent;
  }
  return { isRepo: false };
}

function sanitizeMessagesForProvider(messages: ChatMessage[], model: ModelInfo): ChatMessage[] {
  const sanitized = messages.map((message) => ({
    ...message,
    parts: message.parts.filter((part) => part.type !== "image" || model.supportsImages)
  }));

  return sanitized.filter((message, index) => {
    if (message.parts.length > 0) return true;
    const previous = sanitized[index - 1];
    const next = sanitized[index + 1];
    return !(previous && next);
  });
}

export function summarizeAttachments(parts: ChatMessage["parts"]): string {
  const counts = new Map<string, number>();
  for (const part of parts) counts.set(part.type, (counts.get(part.type) ?? 0) + 1);
  return [...counts.entries()].map(([kind, count]) => `${kind}:${count}`).join(", ");
}

export function lastUserIndex(messages: ChatMessage[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "user") return index;
  }
  return -1;
}

export function truncateMiddle(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  const half = Math.floor(maxLength / 2);
  return `${text.slice(0, half)}…${text.slice(text.length - half)}`;
}

export function hostFingerprint(): string {
  return `${os.hostname()}/${os.platform()}`;
}
