import { existsSync, readFileSync } from "node:fs";
import { extname } from "node:path";
import type {
  AgentEvent,
  AgentEventListener,
  AgentRuntimeStatus,
  AttachmentRef,
  ChatMessage,
  LifecycleHooksRunner,
  ModelInfo,
  Part,
  PermissionBroker,
  ProviderAdapter,
  SkillEntry,
  StreamEvent,
  TodoItem,
  ToolContext,
  ToolDefinition,
  Usage,
  ProviderToolSpec
} from "../types.js";
import {
  addUsage,
  createMessageId,
  createToolCallId,
  emptyUsage,
  makeText,
  makeThinking,
  makeToolCall,
  makeToolResult
} from "../types.js";
import { AxiomError, computeBackoff, errorMessage, toAxiomError } from "../util/errors.js";
import { createLogger } from "../util/log.js";
import { parsePartialJson } from "../util/json.js";
import type { ProviderRegistry } from "../providers/registry.js";
import { computeMessageCost, MessageBudget } from "./tokens.js";
import { estimateContextSize, shouldCompact, compactConversation } from "./compact.js";
import { buildContext } from "./context.js";

const log = createLogger("agent");

export interface AgentOptions {
  sessionId: string;
  cwd: string;
  mode: "normal" | "accept" | "plan" | "bypass";
  language: "en" | "ru";
  modelReference: string;
  maxTokens: number;
  thinkingEnabled: boolean;
  thinkingBudgetTokens: number;
  temperature?: number;
  effort: "low" | "medium" | "high";
  autoCompactThreshold: number;
  rulesText: string;
  skills: SkillEntry[];
  subagentProfiles: Array<{ name: string; description: string; readOnlyOnly?: boolean; toolsDenyList?: string[] }>;
  mcpServerNames: string[];
  hooks?: LifecycleHooksRunner;
  permissionBroker: PermissionBroker;
  registry: ProviderRegistry;
  toolResolver: (name: string) => ToolDefinition | undefined;
  toolSpecs: () => ProviderToolSpec[];
  maxLoopRounds?: number;
  isSubagent?: boolean;
  agentName?: string;
  checkpointSink?: (sessionId: string, paths: string[]) => void;
}

const EFFORT_THINKING_MULTIPLIER: Record<"low" | "medium" | "high", number> = {
  low: 0.5,
  medium: 1,
  high: 2.5
};

export class Agent {
  readonly id: string;
  messages: ChatMessage[] = [];
  todos: TodoItem[] = [];
  modelReference: string;
  mode: AgentOptions["mode"];

  private readonly options: AgentOptions;
  private readonly listeners = new Set<AgentEventListener>();
  private abortController: AbortController | null = null;
  private queue: Array<{ text: string; attachments?: AttachmentRef[] }> = [];
  private statusValue: AgentRuntimeStatus = "idle";
  private runningFlag = false;
  private budget: MessageBudget;
  private sessionUsage: Usage = emptyUsage();
  private sessionCostUSD = 0;
  private subagentsSpawned = 0;
  private titleText: string | undefined;
  private sessionStartFired = false;

  constructor(options: AgentOptions) {
    this.options = options;
    this.id = options.sessionId;
    this.modelReference = options.modelReference;
    this.mode = options.mode;
    this.budget = new MessageBudget({
      maxToolCallsPerMessage: 80
    });
  }

  get status(): AgentRuntimeStatus {
    return this.statusValue;
  }

  get isRunning(): boolean {
    return this.runningFlag;
  }

  get usage(): Usage {
    return { ...this.sessionUsage };
  }

  get cost(): number {
    return this.sessionCostUSD;
  }

  get queuedCount(): number {
    return this.queue.length;
  }

  get title(): string | undefined {
    return this.titleText;
  }

  on(listener: AgentEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event: AgentEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch (error) {
        log.error("listener threw", error);
      }
    }
  }

  setStatus(status: AgentRuntimeStatus): void {
    if (this.statusValue === status) return;
    this.statusValue = status;
    this.emit({ type: "status_changed", status });
  }

  setModel(reference: string): void {
    this.modelReference = reference;
  }

  setMode(mode: AgentOptions["mode"]): void {
    this.mode = mode;
  }

  setRulesText(rulesText: string): void {
    this.options.rulesText = rulesText;
  }

  setSkills(skills: SkillEntry[]): void {
    this.options.skills = skills;
  }

  setMcpServerNames(names: string[]): void {
    this.options.mcpServerNames = names;
  }

  restoreMessages(messages: ChatMessage[]): void {
    if (this.runningFlag) throw new Error("Cannot restore messages while running");
    this.messages = messages;
  }

  resolveModelInfoPublic(): { adapter: ProviderAdapter; model: ModelInfo } {
    return this.resolveModelInfo();
  }

  absorbUsage(delta: Usage, costDelta: number): void {
    addUsage(this.sessionUsage, delta);
    this.sessionCostUSD += costDelta;
    this.emit({ type: "usage_updated", usage: this.sessionUsage, costUSD: this.sessionCostUSD });
  }

  enqueue(text: string, attachments?: AttachmentRef[]): number {
    this.queue.push({ text, attachments });
    this.emit({ type: "queue_updated", depth: this.queue.length });
    return this.queue.length;
  }

  async send(text: string, attachments?: AttachmentRef[]): Promise<void> {
    if (this.runningFlag) {
      this.enqueue(text, attachments);
      return;
    }
    await this.runTurn(text, attachments);
  }

  abort(reason = "user"): void {
    if (!this.abortController) return;
    log.info(`abort requested (${reason})`);
    this.abortController.abort();
  }

  private async drainQueue(): Promise<void> {
    while (this.queue.length > 0 && !this.runningFlag) {
      const next = this.queue.shift();
      this.emit({ type: "queue_updated", depth: this.queue.length });
      if (!next) continue;
      await this.runTurn(next.text, next.attachments);
    }
  }

  private resolveModelInfo(): { adapter: ProviderAdapter; model: ModelInfo } {
    const resolved = this.options.registry.resolveModelInfo(this.modelReference);
    return { adapter: resolved.adapter, model: resolved.model };
  }

  private makeToolContext(callIdForProgress: string): ToolContext {
    const self = this;
    return {
      cwd: this.options.cwd,
      sessionId: this.id,
      mode: this.mode,
      abortSignal: this.abortController?.signal ?? new AbortController().signal,
      async requestPermission(request) {
        self.setStatus("waiting_permission");
        const decision = await self.options.permissionBroker.request(
          request,
          { mode: self.mode }
        );
        self.setStatus(self.runningFlag ? "executing_tools" : "executing_tools");
        return decision;
      },
      reportProgress(callId, line) {
        self.emit({ type: "tool_progress", callId, line });
      },
      snapshotFiles(paths) {
        if (self.options.checkpointSink && paths.length > 0) {
          try {
            self.options.checkpointSink(self.id, paths);
          } catch (error) {
            log.debug("checkpoint sink failed", error);
          }
        }
      },
      async spawnSubagent(prompt, description, agentName) {
        const limit = 24;
        self.subagentsSpawned += 1;
        if (self.subagentsSpawned > limit) {
          throw new Error(`Subagent limit reached (${limit} per session)`);
        }
        return self.runSubagent(prompt, description, agentName);
      },
      getTodoList() {
        return [...self.todos];
      },
      setTodoList(items) {
        self.todos = items;
        self.emit({ type: "todo_updated", items: [...items] });
      }
    };
  }

  private async runSubagent(prompt: string, description: string, agentName: string): Promise<string> {
    const profile = this.options.subagentProfiles.find((candidate) => candidate.name === agentName);
    const child = new Agent({
      ...this.options,
      sessionId: `${this.id}-sub-${Date.now().toString(36)}`,
      isSubagent: true,
      agentName,
      subagentProfiles: [],
      skills: [],
      mode: profile?.readOnlyOnly ? "plan" : this.mode,
      permissionBroker: {
        request: async (request, options) => {
          if (profile?.readOnlyOnly || options.mode !== "bypass") {
            return this.options.permissionBroker.request(request, { mode: this.mode });
          }
          return "allow_once";
        }
      }
    });

    if (profile?.toolsDenyList?.length) {
      log.debug(`subagent ${agentName} denies tools: ${profile.toolsDenyList.join(",")}`);
    }

    let finalText = "";
    const off = child.on((event) => {
      if (event.type === "assistant_finished") {
        finalText = event.message.parts
          .filter((part): part is Extract<Part, { type: "text" }> => part.type === "text")
          .map((part) => part.text)
          .join("\n");
      }
      if (event.type === "tool_progress") {
        this.emit({ type: "tool_progress", callId: event.callId, line: `[${agentName}] ${event.line}` });
      }
    });

    try {
      await child.send(`${description}\n\n${prompt}`);
      addUsage(this.sessionUsage, child.usage);
      this.sessionCostUSD += child.cost;
      return finalText.trim().length > 0 ? finalText : "(subagent returned no text)";
    } finally {
      off();
    }
  }

  private async runTurn(text: string, attachments?: AttachmentRef[]): Promise<void> {
    if (this.runningFlag) return;
    this.runningFlag = true;
    this.budget.startMessage();
    this.abortController = new AbortController();

    try {
      const userMessage = composeUserMessage(text, attachments);
      this.messages.push(userMessage);
      this.emit({ type: "user_message_added", message: userMessage });
      this.setStatus("streaming");

      if (!this.sessionStartFired) {
        this.sessionStartFired = true;
        await this.options.hooks?.runSessionStart({ sessionId: this.id });
      }

      let rounds = 0;
      const maxRounds = this.options.maxLoopRounds ?? 40;

      while (rounds < maxRounds) {
        rounds += 1;
        if (this.abortController.signal.aborted) break;

        const compacted = await this.maybeCompact();
        if (compacted && this.abortController.signal.aborted) break;

        const outcome = await this.streamRound();
        if (outcome.shouldBreak) break;

        if (outcome.toolCallIds.length > 0) {
          this.setStatus("executing_tools");
          const results = await this.executeToolCalls(outcome.toolCalls);
          if (results.length > 0) {
            const resultsMessage: ChatMessage = {
              id: createMessageId(),
              role: "user",
              parts: results,
              timestamp: Date.now()
            };
            this.messages.push(resultsMessage);
            this.emit({ type: "user_message_added", message: resultsMessage });
          }
          continue;
        }

        break;
      }

      await this.options.hooks?.runStop(this.lastStopReason ?? "completed");
    } catch (error) {
      const axiomError = toAxiomError(error);
      if (axiomError.code === "aborted") {
        this.setStatus("aborted");
        this.emit({ type: "notice", level: "info", text: "stopped" });
      } else {
        this.setStatus("error");
        this.emit({ type: "notice", level: "error", text: axiomError.message });
        log.error("turn failed", axiomError);
      }
    } finally {
      this.runningFlag = false;
      this.abortController = null;
      if (this.statusValue !== "error") this.setStatus("idle");
      this.emit({ type: "usage_updated", usage: this.sessionUsage, costUSD: this.sessionCostUSD });
    }

    await this.drainQueue();
  }

  private lastStopReason: string | undefined;

  private async maybeCompact(): Promise<boolean> {
    if (this.options.isSubagent) return false;
    const { model } = this.resolveModelInfo();
    const systemChars = 4000;
    const estimated = estimateContextSize(this.messages, "x".repeat(systemChars));
    if (!shouldCompact(estimated, model, this.options.autoCompactThreshold)) return false;

    this.setStatus("compacting");
    this.emit({ type: "compaction_started" });
    await this.options.hooks?.runPreCompact();

    try {
      const { adapter } = this.resolveModelInfo();
      const result = await compactConversation(this.messages, adapter, model.id, {
        language: this.options.language
      });
      this.messages = result.keptMessages;
      addUsage(this.sessionUsage, result.usage);
      this.emit({ type: "compaction_finished", summaryText: result.summary.parts[0]?.type === "text" ? result.summary.parts[0].text : "" });
      await this.options.hooks?.runPostCompact();
      return true;
    } catch (error) {
      log.warn("auto-compaction failed, continuing with full context", error);
      this.emit({ type: "notice", level: "warn", text: `Auto-compact failed: ${errorMessage(error)}` });
      return false;
    } finally {
      this.setStatus("streaming");
    }
  }

  async manualCompact(customInstructions?: string): Promise<string | undefined> {
    if (this.runningFlag && !this.options.isSubagent) {
      this.setStatus("compacting");
    }
    const { adapter, model } = this.resolveModelInfo();
    this.emit({ type: "compaction_started" });
    try {
      const result = await compactConversation(this.messages, adapter, model.id, {
        language: this.options.language,
        customInstructions
      });
      this.messages = result.keptMessages;
      addUsage(this.sessionUsage, result.usage);
      this.emit({ type: "compaction_finished", summaryText: result.summary.parts[0]?.type === "text" ? result.summary.parts[0].text : "" });
      return result.summary.parts[0]?.type === "text" ? result.summary.parts[0].text : undefined;
    } finally {
      this.setStatus("idle");
    }
  }

  private async streamRound(): Promise<{ shouldBreak: boolean; toolCalls: ToolCallPartAccum[]; toolCallIds: string[] }> {
    const { adapter, model } = this.resolveModelInfo();
    this.options.registry.requireCredential(parseProviderId(this.modelReference));

    const context = buildContext({
      messages: this.messages,
      cwd: this.options.cwd,
      mode: this.mode,
      agentName: this.options.isSubagent ? "subagent" : "build",
      skills: this.options.skills.filter(() => !this.options.isSubagent),
      subagentProfiles: this.options.subagentProfiles,
      rulesText: this.options.rulesText,
      language: this.options.language,
      todos: this.todos,
      mcpServerNames: this.options.mcpServerNames,
      tools: this.options.toolSpecs(),
      model,
      maxTokens: this.options.maxTokens,
      thinkingBudgetTokens: this.options.thinkingEnabled
        ? Math.round(this.options.thinkingBudgetTokens * EFFORT_THINKING_MULTIPLIER[this.options.effort])
        : 0,
      temperature: this.options.temperature
    });

    const assistant: ChatMessage = {
      id: createMessageId(),
      role: "assistant",
      parts: [],
      timestamp: Date.now(),
      model: model.id,
      provider: parseProviderId(this.modelReference),
      agent: this.options.isSubagent ? "subagent" : "build"
    };

    this.emit({ type: "assistant_started", messageId: assistant.id });

    const started = Date.now();
    const roundUsage = emptyUsage();
    const toolCalls: ToolCallPartAccum[] = [];
    let roundStopReason: "end_turn" | "tool_use" | "max_tokens" | "aborted" | "error" | "other" = "other";

    const attemptLimit = 4;
    for (let attempt = 1; attempt <= attemptLimit; attempt += 1) {
      try {
        for await (const event of adapter.stream(context.request, this.abortController!.signal)) {
          if (event.type === "stop") roundStopReason = event.reason;
          applyStreamEventToAssistant(event, assistant, toolCalls, roundUsage, this);

          if (event.type === "error") {
            const error = new AxiomError(event.message, { code: "provider_error", retryable: event.retryable, status: event.status });
            if (event.retryable && attempt < attemptLimit) throw error;
            finalizeAssistant(this, assistant, roundUsage, started, "error", event.message);
            this.setStatus("error");
            this.emit({ type: "notice", level: "error", text: event.message });
            return { shouldBreak: true, toolCalls: [], toolCallIds: [] };
          }

          if (event.type === "stop" && event.reason === "aborted") {
            finalizeAssistant(this, assistant, roundUsage, started, "aborted");
            this.setStatus("aborted");
            return { shouldBreak: true, toolCalls: [], toolCallIds: [] };
          }
        }

        const hasToolCalls = toolCalls.length > 0;
        const effectiveStop =
          roundStopReason === "tool_use" || hasToolCalls
            ? "tool_use"
            : roundStopReason === "max_tokens"
              ? "max_tokens"
              : roundStopReason === "aborted"
                ? "aborted"
                : roundStopReason === "error"
                  ? "error"
                  : "end_turn";

        finalizeAssistant(this, assistant, roundUsage, started, effectiveStop);
        this.lastStopReason = effectiveStop;

        if (effectiveStop === "max_tokens") {
          this.emit({ type: "notice", level: "warn", text: "Output truncated at max_tokens; consider raising the limit." });
        }

        if (!hasToolCalls || effectiveStop !== "tool_use") {
          return { shouldBreak: true, toolCalls: [], toolCallIds: [] };
        }

        return {
          shouldBreak: false,
          toolCalls,
          toolCallIds: toolCalls.map((call) => call.id)
        };
      } catch (error) {
        const axiomError = toAxiomError(error);
        if (axiomError.code === "aborted" || this.abortController!.signal.aborted) {
          finalizeAssistant(this, assistant, roundUsage, started, "aborted");
          this.setStatus("aborted");
          return { shouldBreak: true, toolCalls: [], toolCallIds: [] };
        }
        if (!axiomError.retryable || attempt >= attemptLimit) {
          finalizeAssistant(this, assistant, roundUsage, started, "error", axiomError.message);
          this.setStatus("error");
          this.emit({ type: "notice", level: "error", text: axiomError.message });
          return { shouldBreak: true, toolCalls: [], toolCallIds: [] };
        }
        const delay = computeBackoff(attempt, {
          maxAttempts: attemptLimit,
          baseDelayMs: 900,
          maxDelayMs: 12000,
          jitterRatio: 0.3,
          respectRetryAfter: true
        });
        this.emit({ type: "loop_error", error: axiomError, retryable: true, attempt });
        await new Promise<void>((resolve) => setTimeout(resolve, delay));
      }
    }

    return { shouldBreak: true, toolCalls: [], toolCallIds: [] };
  }

  private async executeToolCalls(calls: ToolCallPartAccum[]): Promise<Part[]> {
    const results: Part[] = [];

    for (const call of calls) {
      if (this.abortController?.signal.aborted) {
        results.push(makeToolResult(call.id, call.name, "Aborted before execution", true));
        continue;
      }

      const budgetCheck = this.budget.recordToolCall();
      if (!budgetCheck.allowed) {
        results.push(makeToolResult(call.id, call.name, budgetCheck.reason ?? "budget exceeded", true));
        continue;
      }

      const definition = this.options.toolResolver(call.name);
      this.emit({ type: "tool_started", callId: call.id, name: call.name, input: call.input });

      if (!definition) {
        const message = `Unknown tool "${call.name}". Available tools are listed in your instructions.`;
        results.push(makeToolResult(call.id, call.name, message, true));
        this.emit({ type: "tool_finished", callId: call.id, result: { content: message, isError: true } });
        continue;
      }

      const hookOutcome = await this.options.hooks
        ?.runPreToolUse({ tool: call.name, toolInput: call.input })
        .catch(() => ({ blocked: false, message: undefined }) as { blocked: boolean; message?: string });
      if (hookOutcome?.blocked) {
        const message = hookOutcome.message ?? `Blocked by pre_tool_use hook`;
        results.push(makeToolResult(call.id, call.name, message, true));
        this.emit({ type: "tool_finished", callId: call.id, result: { content: message, isError: true } });
        continue;
      }

      const need = definition.needsPermission(safeRecord(call.input), this.mode);
      let approved = true;

      if (need.required) {
        const decision = await this.requestPermissionSafely(definition, call, need.risk, need.title, need.summary);
        approved = decision === "allow_once" || decision === "allow_always";
        if (!approved) {
          const message = `The user denied permission for ${definition.label}. Do not retry the same action without asking.`;
          results.push(makeToolResult(call.id, call.name, message, true));
          this.emit({ type: "tool_finished", callId: call.id, result: { content: message, isError: true } });
          continue;
        }
      }

      try {
        const context = this.makeToolContext(call.id);
        const outcome = await definition.execute(safeRecord(call.input), context, call.id);
        results.push(makeToolResult(call.id, call.name, outcome.content, outcome.isError, outcome.metadata));
        this.emit({ type: "tool_finished", callId: call.id, result: outcome });
        await this.options.hooks
          ?.runPostToolUse({ tool: call.name, toolInput: call.input, result: outcome.content.slice(0, 20000), isError: outcome.isError })
          .catch(() => undefined);
      } catch (error) {
        const axiomError = toAxiomError(error);
        const content = axiomError.code === "aborted" ? "Aborted by user" : `Tool error: ${axiomError.message}`;
        results.push(makeToolResult(call.id, call.name, content, true));
        this.emit({ type: "tool_finished", callId: call.id, result: { content, isError: true } });
      }
    }

    return results;
  }

  private async requestPermissionSafely(
    definition: ToolDefinition,
    call: ToolCallPartAccum,
    risk: "low" | "medium" | "high",
    customTitle?: string,
    customSummary?: string[]
  ): Promise<"allow_once" | "allow_always" | "deny"> {
    try {
      const decision = await this.options.permissionBroker.request(
        {
          tool: definition.name,
          title: customTitle ?? definition.label,
          summary: customSummary ?? summarizeToolInput(definition.name, call.input),
          risk
        },
        { mode: this.mode }
      );
      return decision;
    } catch (error) {
      log.error("permission broker failed, denying", error);
      return "deny";
    }
  }
}

interface ToolCallPartAccum {
  id: string;
  name: string;
  rawArgs: string;
  input: unknown;
}

function safeRecord(input: unknown): Record<string, unknown> {
  if (input !== null && typeof input === "object" && !Array.isArray(input)) {
    return input as Record<string, unknown>;
  }
  return {};
}

function composeUserMessage(text: string, attachments?: AttachmentRef[]): ChatMessage {
  const parts: Part[] = [makeText(text)];

  if (attachments?.length) {
    for (const attachment of attachments) {
      if (attachment.kind !== "image") continue;
      try {
        if (!existsSync(attachment.path)) continue;
        const buffer = readFileSync(attachment.path);
        parts.push({
          type: "image",
          mediaType: imageMimeFromExtension(attachment.path),
          data: buffer.toString("base64")
        });
      } catch {
      }
    }
  }

  return {
    id: createMessageId(),
    role: "user",
    parts,
    timestamp: Date.now()
  };
}

const EXTENSION_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp"
};

function imageMimeFromExtension(filePath: string): string {
  return EXTENSION_MIME[extname(filePath).toLowerCase()] ?? "image/png";
}

function applyStreamEventToAssistant(
  event: StreamEvent,
  assistant: ChatMessage,
  toolCalls: ToolCallPartAccum[],
  usage: Usage,
  agent: Agent
): void {
  switch (event.type) {
    case "start":
      break;

    case "text_delta": {
      const lastPart = assistant.parts[assistant.parts.length - 1];
      if (lastPart && lastPart.type === "text") {
        lastPart.text += event.delta;
      } else {
        assistant.parts.push(makeText(event.delta));
        agent.emit({ type: "part_added", messageId: assistant.id, index: assistant.parts.length - 1 });
      }
      agent.emit({ type: "text_delta", messageId: assistant.id, delta: event.delta });
      break;
    }

    case "thinking_delta": {
      const lastPart = assistant.parts[assistant.parts.length - 1];
      if (lastPart && lastPart.type === "thinking") {
        lastPart.thinking += event.delta;
        if (event.signature) lastPart.signature = event.signature;
      } else if (event.delta.length > 0 || event.signature) {
        assistant.parts.push(makeThinking(event.delta, event.signature));
        agent.emit({ type: "part_added", messageId: assistant.id, index: assistant.parts.length - 1 });
      }
      if (event.delta.length > 0) {
        agent.emit({ type: "thinking_delta", messageId: assistant.id, delta: event.delta });
      }
      break;
    }

    case "tool_call_start": {
      const existing = toolCalls.find((call) => call.id === event.id);
      if (!existing) {
        const part = makeToolCall(event.id, event.name, {}, "");
        assistant.parts.push(part);
        toolCalls.push({ id: event.id, name: event.name, rawArgs: "", input: {} });
        agent.emit({ type: "part_added", messageId: assistant.id, index: assistant.parts.length - 1 });
      }
      break;
    }

    case "tool_call_end": {
      let entry = toolCalls.find((call) => call.id === event.id);
      if (!entry) {
        const part = makeToolCall(event.id, event.name, parseArgs(event.args), event.args);
        assistant.parts.push(part);
        entry = { id: event.id, name: event.name, rawArgs: event.args, input: parseArgs(event.args) };
        toolCalls.push(entry);
        agent.emit({ type: "part_added", messageId: assistant.id, index: assistant.parts.length - 1 });
      } else {
        entry.rawArgs = event.args;
        entry.input = parseArgs(event.args);
      }
      const index = assistant.parts.findIndex((part) => part.type === "tool_call" && part.id === event.id);
      if (index !== -1) {
        const part = assistant.parts[index];
        if (part.type === "tool_call") {
          part.input = entry.input;
          part.rawArgs = entry.rawArgs;
        }
        agent.emit({ type: "part_updated", messageId: assistant.id, index });
      }
      break;
    }

    case "tool_call_delta": {
      const entry = toolCalls.find((call) => call.rawArgs.length === 0 && call.input === null);
      void entry;
      break;
    }

    case "usage_delta": {
      mergeUsageDelta(usage, event.usage);
      break;
    }

    case "stop":
      break;

    case "error":
    case "done":
      break;
  }
}

function mergeUsageDelta(target: Usage, delta: Partial<Usage>): void {
  if (delta.inputTokens !== undefined && delta.inputTokens > target.inputTokens) target.inputTokens = delta.inputTokens;
  if (delta.outputTokens !== undefined) target.outputTokens += delta.outputTokens;
  if (delta.cacheReadTokens !== undefined && delta.cacheReadTokens > target.cacheReadTokens) target.cacheReadTokens = delta.cacheReadTokens;
  if (delta.cacheWriteTokens !== undefined && delta.cacheWriteTokens > target.cacheWriteTokens) target.cacheWriteTokens = delta.cacheWriteTokens;
  if (delta.reasoningTokens !== undefined) target.reasoningTokens += delta.reasoningTokens;
}

function parseArgs(raw: string): unknown {
  if (!raw || raw.trim().length === 0) return {};
  try {
    return JSON.parse(raw);
  } catch {
    const partial = parsePartialJson(raw);
    return partial.value ?? {};
  }
}

function finalizeAssistant(
  agent: Agent,
  assistant: ChatMessage,
  usage: Usage,
  startedAt: number,
  reason: "end_turn" | "tool_use" | "max_tokens" | "aborted" | "error" | "other",
  errorMessageText?: string
): void {
  assistant.stopReason = reason;
  assistant.usage = { ...usage };
  assistant.durationMs = Date.now() - startedAt;
  if (errorMessageText) assistant.errorMessage = errorMessageText;

  const resolved = agent.resolveModelInfoPublic();
  assistant.costUSD = computeMessageCost(resolved.model, usage);

  agent.absorbUsage(usage, assistant.costUSD);
  agent.messages.push(assistant);
  agent.emit({ type: "assistant_finished", message: assistant });
  agent.emit({ type: "usage_updated", usage: agent.usage, costUSD: agent.cost });
}

function parseProviderId(reference: string): string {
  const slashIndex = reference.indexOf("/");
  return slashIndex === -1 ? reference : reference.slice(0, slashIndex);
}

export function summarizeToolInput(toolName: string, input: unknown): string[] {
  const record = safeRecord(input);
  const lines: string[] = [];

  switch (toolName) {
    case "bash":
      lines.push(String(record["command"] ?? ""));
      break;
    case "write":
      lines.push(`File: ${record["file_path"] ?? "?"}`);
      lines.push(`${String(record["content"] ?? "").split("\n").length} lines`);
      break;
    case "edit":
      lines.push(`File: ${record["file_path"] ?? "?"}`);
      lines.push(truncateLine(String(record["old_string"] ?? "")));
      break;
    case "read":
    case "glob":
    case "grep":
    case "ls":
      lines.push(Object.entries(record).map(([key, value]) => `${key}: ${truncateLine(String(value))}`).join("  "));
      break;
    default:
      lines.push(JSON.stringify(record).slice(0, 300));
      break;
  }

  return lines.filter((line) => line.trim().length > 0).slice(0, 6);
}

function truncateLine(value: string): string {
  const single = value.split("\n")[0];
  return single.length > 120 ? `${single.slice(0, 117)}…` : single;
}
