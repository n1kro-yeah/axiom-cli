export type Role = "user" | "assistant";

export type StopReason = "end_turn" | "tool_use" | "max_tokens" | "aborted" | "error" | "other";

export interface TextPart {
  readonly type: "text";
  text: string;
}

export interface ImagePart {
  readonly type: "image";
  mediaType: string;
  data: string;
}

export interface ThinkingPart {
  readonly type: "thinking";
  thinking: string;
  signature?: string;
}

export interface ToolCallPart {
  readonly type: "tool_call";
  id: string;
  name: string;
  input: unknown;
  rawArgs: string;
}

export interface ToolResultPart {
  readonly type: "tool_result";
  toolCallId: string;
  name: string;
  content: string;
  isError: boolean;
  metadata?: Record<string, unknown>;
}

export type Part = TextPart | ImagePart | ThinkingPart | ToolCallPart | ToolResultPart;

export function makeText(text: string): TextPart {
  return { type: "text", text };
}

export function makeImage(mediaType: string, base64: string): ImagePart {
  return { type: "image", mediaType, data: base64 };
}

export function makeThinking(thinking: string, signature?: string): ThinkingPart {
  return signature === undefined ? { type: "thinking", thinking } : { type: "thinking", thinking, signature };
}

export function makeToolCall(id: string, name: string, input: unknown, rawArgs: string): ToolCallPart {
  return { type: "tool_call", id, name, input, rawArgs };
}

export function makeToolResult(
  toolCallId: string,
  name: string,
  content: string,
  isError: boolean,
  metadata?: Record<string, unknown>
): ToolResultPart {
  const part: ToolResultPart = { type: "tool_result", toolCallId, name, content, isError };
  if (metadata !== undefined) part.metadata = metadata;
  return part;
}

export function isTextPart(part: Part): part is TextPart {
  return part.type === "text";
}

export function isImagePart(part: Part): part is ImagePart {
  return part.type === "image";
}

export function isThinkingPart(part: Part): part is ThinkingPart {
  return part.type === "thinking";
}

export function isToolCallPart(part: Part): part is ToolCallPart {
  return part.type === "tool_call";
}

export function isToolResultPart(part: Part): part is ToolResultPart {
  return part.type === "tool_result";
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
}

export function emptyUsage(): Usage {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 };
}

export function addUsage(target: Usage, delta: Usage): Usage {
  target.inputTokens += delta.inputTokens;
  target.outputTokens += delta.outputTokens;
  target.cacheReadTokens += delta.cacheReadTokens;
  target.cacheWriteTokens += delta.cacheWriteTokens;
  target.reasoningTokens += delta.reasoningTokens;
  return target;
}

export interface ChatMessage {
  id: string;
  role: Role;
  parts: Part[];
  timestamp: number;
  model?: string;
  provider?: string;
  usage?: Usage;
  stopReason?: StopReason;
  costUSD?: number;
  durationMs?: number;
  agent?: string;
  summary?: boolean;
  errorMessage?: string;
}

let messageCounter = 0;

export function createMessageId(): string {
  messageCounter += 1;
  return `msg_${Date.now().toString(36)}_${messageCounter.toString(36)}`;
}

let callCounter = 0;

export function createToolCallId(): string {
  callCounter += 1;
  return `call_${Date.now().toString(36)}_${callCounter.toString(36)}`;
}

export interface StreamRequestSystemBlock {
  text: string;
  cache?: boolean;
}

export interface StreamRequest {
  model: string;
  system: StreamRequestSystemBlock[];
  messages: ChatMessage[];
  tools: ProviderToolSpec[];
  maxTokens: number;
  temperature?: number;
  thinkingBudgetTokens?: number;
}

export interface ProviderToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export type StreamEvent =
  | { type: "start"; provider: string; model: string }
  | { type: "text_delta"; delta: string }
  | { type: "thinking_delta"; delta: string; signature?: string }
  | { type: "tool_call_start"; index: number; id: string; name: string }
  | { type: "tool_call_delta"; index: number; argsDelta: string }
  | { type: "tool_call_end"; index: number; id: string; name: string; args: string }
  | { type: "usage_delta"; usage: Partial<Usage> }
  | { type: "stop"; reason: StopReason }
  | { type: "error"; message: string; retryable: boolean; status?: number }
  | { type: "done" };

export interface ModelPricing {
  inputPerMillion: number;
  outputPerMillion: number;
  cacheReadPerMillion?: number;
  cacheWritePerMillion?: number;
}

export interface ModelInfo {
  id: string;
  label: string;
  provider: string;
  contextWindow: number;
  maxOutputTokens: number;
  supportsTools: boolean;
  supportsImages: boolean;
  supportsThinking: boolean;
  supportsCacheControl: boolean;
  pricing?: ModelPricing;
  recommended?: boolean;
}

export interface ProviderAdapter {
  readonly id: string;
  readonly label: string;
  listModels(): ModelInfo[];
  hasModel(modelId: string): boolean;
  resolveModel(modelId: string): ModelInfo | undefined;
  stream(request: StreamRequest, signal: AbortSignal): AsyncIterable<StreamEvent>;
  estimateCost(model: ModelInfo, usage: Usage): number;
}

export type PermissionMode = "normal" | "accept" | "plan" | "bypass";

export type PermissionDecision = "allow_once" | "allow_always" | "deny";

export type RiskLevel = "low" | "medium" | "high";

export interface PermissionRequest {
  id: string;
  tool: string;
  title: string;
  summary: string[];
  risk: RiskLevel;
}

export interface PermissionRule {
  tool: string;
  pattern?: string;
  decision: "allow" | "deny" | "ask";
}

export interface TodoItem {
  id: string;
  content: string;
  status: "pending" | "in_progress" | "completed" | "cancelled";
  priority: "high" | "medium" | "low";
}

export interface ToolContext {
  cwd: string;
  sessionId: string;
  mode: PermissionMode;
  abortSignal: AbortSignal;
  requestPermission(request: Omit<PermissionRequest, "id">): Promise<PermissionDecision>;
  reportProgress(callId: string, line: string): void;
  snapshotFiles(paths: string[]): void;
  spawnSubagent(prompt: string, description: string, agentName: string): Promise<string>;
  getTodoList(): TodoItem[];
  setTodoList(items: TodoItem[]): void;
}

export interface ToolInvocationResult {
  content: string;
  isError: boolean;
  metadata?: Record<string, unknown>;
  images?: Array<{ mediaType: string; data: string }>;
}

export interface ToolDefinition {
  name: string;
  label: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
  readOnly: boolean;
  hiddenFromModel?: boolean;
  needsPermission(input: Record<string, unknown>, mode: PermissionMode): PermissionNeed;
  execute(
    input: Record<string, unknown>,
    context: ToolContext,
    callId: string
  ): Promise<ToolInvocationResult>;
}

export interface PermissionNeed {
  required: boolean;
  risk: RiskLevel;
  title?: string;
  summary?: string[];
  pattern?: string;
}

export class ToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolError";
  }
}

export type AgentRuntimeStatus =
  | "idle"
  | "streaming"
  | "executing_tools"
  | "waiting_permission"
  | "compacting"
  | "error"
  | "aborted";

export type AgentEvent =
  | { type: "status_changed"; status: AgentRuntimeStatus }
  | { type: "assistant_started"; messageId: string }
  | { type: "text_delta"; messageId: string; delta: string }
  | { type: "thinking_delta"; messageId: string; delta: string }
  | { type: "part_added"; messageId: string; index: number }
  | { type: "part_updated"; messageId: string; index: number }
  | { type: "assistant_finished"; message: ChatMessage }
  | { type: "user_message_added"; message: ChatMessage }
  | { type: "permission_requested"; request: PermissionRequest }
  | { type: "permission_resolved"; requestId: string; decision: PermissionDecision }
  | { type: "tool_started"; callId: string; name: string; input: unknown }
  | { type: "tool_progress"; callId: string; line: string }
  | { type: "tool_finished"; callId: string; result: ToolInvocationResult }
  | { type: "queue_updated"; depth: number }
  | { type: "compaction_started" }
  | { type: "compaction_finished"; summaryText: string }
  | { type: "title_generated"; title: string }
  | { type: "todo_updated"; items: TodoItem[] }
  | { type: "usage_updated"; usage: Usage; costUSD: number }
  | { type: "notice"; level: "info" | "warn" | "error"; text: string }
  | { type: "loop_error"; error: Error; retryable: boolean; attempt: number };

export type AgentEventListener = (event: AgentEvent) => void;

export interface PermissionBroker {
  request(
    request: Omit<PermissionRequest, "id">,
    options: { mode: PermissionMode }
  ): Promise<PermissionDecision>;
}

export interface LifecycleHooksRunner {
  runSessionStart(context: Record<string, unknown>): Promise<void>;
  runSessionEnd(context: Record<string, unknown>): Promise<void>;
  runPreToolUse(input: { tool: string; toolInput: unknown }): Promise<{ blocked: boolean; message?: string }>;
  runPostToolUse(input: { tool: string; toolInput: unknown; result: string; isError: boolean }): Promise<void>;
  runPreCompact(): Promise<void>;
  runPostCompact(): Promise<void>;
  runStop(reason: string): Promise<void>;
}

export interface SessionMeta {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  projectRoot: string;
  model: string;
  provider: string;
  messageCount: number;
  totalCostUSD: number;
  totalUsage: Usage;
}

export interface AttachmentRef {
  kind: "image" | "text";
  path: string;
  mediaType?: string;
  sizeBytes: number;
}

export interface McpServerConfig {
  type: "stdio" | "http";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
  enabled: boolean;
}

export interface SkillFrontmatter {
  name: string;
  description: string;
  allowedTools?: string[];
  disableModelInvocation?: boolean;
}

export interface SkillEntry {
  name: string;
  description: string;
  body: string;
  frontmatter: SkillFrontmatter;
  scope: "global" | "project";
  path: string;
}

export interface SubagentConfig {
  name: string;
  description: string;
  systemPromptAddendum?: string;
  model?: string;
  toolsDenyList?: string[];
  readOnlyOnly?: boolean;
}
